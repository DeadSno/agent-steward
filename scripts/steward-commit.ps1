# Post-flight commit + push for one agent-steward task.
# ASCII-only comments (PL-80): Windows PowerShell 5.1 reads UTF-8 without BOM
# as ANSI, so Cyrillic here corrupts parsing.
# Ownership: commits ONLY the files listed in -Files, using a pathspec-limited
# commit so foreign staged changes never enter this commit (PL-41/PL-58).
# Preflight: every path in -Files must exist, otherwise fail before commit
# instead of dying on `git add ... pathspec did not match` after a green gate
# (PL-79, PL-82).
# Push: HEAD:dev because the worktree uses a topic branch while the remote
# branch is dev. On non-fast-forward, rebase; on conflict keep the conflict
# files and report a resolvable state instead of silently aborting (PL-101).
param(
  [Parameter(Mandatory = $true)][string]$Message,
  [Parameter(Mandatory = $true)][string]$Files,
  [Parameter(Mandatory = $true)][string]$Marker,
  [string]$Root = ""
)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = (Get-Location).Path }
Set-Location -LiteralPath $Root
$logFile = Join-Path $Root 'steward-commit.log'
$markerPath = Join-Path $Root $Marker

function Log([string]$text) {
  Add-Content -LiteralPath $logFile -Value ("{0} {1}" -f (Get-Date -Format o), $text)
}

function Invoke-Git([string]$what, [string[]]$arguments) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & git @arguments 2>&1
    $code = $LASTEXITCODE
    foreach ($line in $output) { Log ("[{0}] {1}" -f $what, [string]$line) }
    return $code
  }
  finally { $ErrorActionPreference = $old }
}

try {
  $gateOk = Test-Path -LiteralPath $markerPath
  if ($gateOk) { Remove-Item -LiteralPath $markerPath -Force }
  if (-not $gateOk) {
    Log "SKIP (quality gate did not pass): $Message"
    exit 0
  }

  $fileList = @($Files -split ';' | Where-Object { $_ } | ForEach-Object { $_.Trim() })
  if ($fileList.Count -eq 0) {
    Log "SKIP (no files): $Message"
    exit 0
  }

  # PL-79/PL-82: validate the whole SCOPE list up front, in one pass.
  $missing = @()
  foreach ($item in $fileList) {
    if (-not (Test-Path -LiteralPath (Join-Path $Root $item))) { $missing += $item }
  }
  if ($missing.Count -gt 0) {
    Log ("FAIL SCOPE path(s) do not exist: " + ($missing -join '; '))
    exit 1
  }

  if ((Invoke-Git 'add' (@('add', '--') + $fileList)) -ne 0) {
    Log "FAIL add: $Message"
    exit 1
  }

  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $changedRaw = & git diff --name-only HEAD 2>$null
    $changedCode = $LASTEXITCODE
    $stagedRaw = & git diff --cached --name-only 2>$null
    $stagedCode = $LASTEXITCODE
  }
  finally { $ErrorActionPreference = $old }
  if ($changedCode -ne 0 -or $stagedCode -ne 0) {
    Log "FAIL diff: $Message"
    exit 1
  }

  $changedSet = @{}
  foreach ($raw in @($changedRaw) + @($stagedRaw)) {
    $key = ([string]$raw).Trim() -replace '\\', '/'
    if ($key) { $changedSet[$key] = $true }
  }
  $manifest = @{}
  foreach ($item in $fileList) { $manifest[([string]$item -replace '\\', '/')] = $true }
  $foreign = @($changedSet.Keys | Where-Object { -not $manifest.ContainsKey($_) } | Sort-Object)
  if ($foreign.Count -gt 0) {
    Log ("WARN foreign files excluded: " + ($foreign -join '; '))
  }

  $commitFiles = @()
  foreach ($item in $fileList) {
    if ($changedSet.ContainsKey(($item -replace '\\', '/'))) { $commitFiles += $item }
  }
  if ($commitFiles.Count -eq 0) {
    Log "SKIP (nothing to commit): $Message"
    exit 0
  }

  if ((Invoke-Git 'commit' (@('commit', '-m', $Message, '--') + $commitFiles)) -ne 0) {
    Log "FAIL commit: $Message"
    exit 1
  }

  $null = Invoke-Git 'fetch' @('fetch', 'origin', 'dev')
  if ((Invoke-Git 'push' @('push', 'origin', 'HEAD:dev')) -eq 0) {
    Log "OK: $Message"
    exit 0
  }

  # Non-fast-forward: rebase onto the newest origin/dev (PL-101).
  # PL-104: parallel tasks may leave unstaged files in the shared worktree;
  # a plain `git rebase` aborts with "cannot rebase: You have unstaged changes".
  # --autostash parks those changes and restores them after a successful rebase.
  $rebaseCode = Invoke-Git 'rebase' @('rebase', '--autostash', 'origin/dev')
  if ($rebaseCode -ne 0) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $conflicts = @(& git diff --name-only --diff-filter=U 2>$null)
    $ErrorActionPreference = $old

    # PL-101/PL-104: keep the conflicted files and a clear diagnostic marker.
    # Do NOT call `rebase --quit` unless a rebase is actually in progress:
    # otherwise git answers "fatal: no rebase in progress" and the helper dies.
    $rebaseMergeDir = (& git rev-parse --git-path rebase-merge 2>$null).Trim()
    $rebaseApplyDir = (& git rev-parse --git-path rebase-apply 2>$null).Trim()
    $rebaseInProgress = (Test-Path -LiteralPath $rebaseMergeDir) -or (Test-Path -LiteralPath $rebaseApplyDir)

    $backupDir = Join-Path $Root (Join-Path 'reports' 'merge-conflicts')
    $markerFile = Join-Path $Root 'reports/merge-conflict-pending.md'
    try {
      New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
      foreach ($item in $conflicts) {
        if (-not $item) { continue }
        $src = Join-Path $Root $item
        if (Test-Path -LiteralPath $src) {
          $dest = Join-Path $backupDir (($item -replace '[\\/]', '__'))
          Copy-Item -LiteralPath $src -Destination $dest -Force
        }
      }
      $taskSlug = (Split-Path -Leaf $logFile) -replace '\.log$', ''
      $body = @(
        "# Merge conflict needs manual resolution ($taskSlug)",
        "",
        "Message: $Message",
        "Conflicted files: " + (@($conflicts) -join '; '),
        "Backed-up copies: $backupDir",
        "",
        "The commit was created and the Quality Gate passed. Resolve the",
        "conflict markers in the listed files, then push manually:",
        "  git add <files>; git commit; git push origin HEAD:dev"
      )
      Set-Content -LiteralPath $markerFile -Value $body -Encoding UTF8
    } catch {
      Log ("WARN could not persist conflict backup: " + $_.Exception.Message)
    }

    if ($rebaseInProgress) {
      # --quit (not --abort) keeps our commit at HEAD and leaves conflict
      # markers on disk instead of losing the whole run (the PL-101 defect).
      $null = Invoke-Git 'rebase-quit' @('rebase', '--quit')
    } else {
      Log "PL-104: no rebase in progress - skipped 'rebase --quit'"
    }
    Log ("CONFLICT - manual resolution required: " + (@($conflicts) -join '; '))
    Log ("PL-101: conflict files preserved; marker=$markerFile; task requires conflict resolution")
    exit 0
  }
  if ((Invoke-Git 'push-2' @('push', 'origin', 'HEAD:dev')) -ne 0) {
    Log "FAIL push after rebase: $Message"
    exit 1
  }
  Log "OK (rebased): $Message"
  exit 0
}
catch {
  Log ("ERROR: " + $_.Exception.Message)
  exit 1
}
