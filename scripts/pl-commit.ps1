# Post-flight commit+push for one QA-findings task (Detail 1.5 / 1.6).
# Called by agent-steward's afterScript. Commits ONLY the files owned by the task
# and only when that task's quality gate wrote its own success marker.
# Generalizes scripts/qa-a2-commit.ps1: the marker is a parameter, so parallel
# tasks cannot consume each other's gate signal.
# PL-41: the commit itself is pathspec-limited - `git commit -m <msg> -- <files>`
# - so foreign staged changes never enter this task's commit. Plain
# `git add -- <files>` is NOT enough: `git add` stages only our files, but a bare
# `git commit -m <msg>` commits the WHOLE index, so anything another process
# staged in the meantime (or left staged before this run) would be swept into the
# commit. The `--` pathspec restricts the commit to the task's own file list
# regardless of what else sits in the index.
# PL-58: with parallel tasks in one worktree the commit file list is derived
# from the actual task diff (git diff --name-only), not from every change in the
# shared tree. Files outside the task manifest (-Files) are foreign: they are
# excluded from the commit and reported as a WARN.
param(
  [Parameter(Mandatory = $true)][string]$Message,
  [Parameter(Mandatory = $true)][string]$Files,
  [Parameter(Mandatory = $true)][string]$Marker
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$logFile = Join-Path $root 'pl-commit.log'
$markerPath = Join-Path $root $Marker

function Log([string]$text) {
  Add-Content -LiteralPath $logFile -Value ("{0} {1}" -f (Get-Date -Format o), $text)
}

# git writes progress/errors to stderr; PowerShell 7 with ErrorActionPreference=Stop
# turns that into a terminating ErrorRecord even when push succeeds. Capture the
# real exit code instead (QA-A2/PL-7.1 lesson).
function Invoke-Git([string]$what, [string[]]$arguments) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & git @arguments 2>&1
    $code = $LASTEXITCODE
    foreach ($line in $output) { Log ("[{0}] {1}" -f $what, [string]$line) }
    return $code
  }
  finally {
    $ErrorActionPreference = $old
  }
}

try {
  $gateOk = Test-Path -LiteralPath $markerPath
  if ($gateOk) {
    Remove-Item -LiteralPath $markerPath -Force
  }
  if (-not $gateOk) {
    Log "SKIP (quality gate did not pass): $Message"
    exit 0
  }

  $fileList = @($Files -split ';' | Where-Object { $_ } | ForEach-Object { $_.Trim() })
  if ($fileList.Count -eq 0) {
    Log "SKIP (no files): $Message"
    exit 0
  }

  # Task manifest is the only source of file ownership. Normalize separators
  # to forward slashes so comparison is stable on Windows.
  $manifest = @{}
  foreach ($item in $fileList) {
    $key = ([string]$item).Trim() -replace '\\', '/'
    if ($key) { $manifest[$key] = $true }
  }

  # PL-58: stage only our files, then read the actual diff of the shared
  # worktree. The commit list comes from the task diff, not the whole tree.
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

  # Foreign files (ARCH-1/ARCH-2 in PL-58) never enter the commit, but their
  # presence in the shared worktree is always logged as a warning.
  $foreign = @($changedSet.Keys | Where-Object { -not $manifest.ContainsKey($_) } | Sort-Object)
  if ($foreign.Count -gt 0) {
    $foreignJoined = $foreign -join '; '
    Log "WARN PL-58: files outside task manifest are excluded from commit: $foreignJoined"
  }

  # Commit list = our files that actually changed (from the real diff).
  $commitFiles = @()
  foreach ($item in $fileList) {
    $key = ([string]$item).Trim() -replace '\\', '/'
    if ($changedSet.ContainsKey($key)) { $commitFiles += $item }
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
  $pushed = $false
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    if ((Invoke-Git "push#$attempt" @('push', 'origin', 'HEAD:dev')) -eq 0) {
      $pushed = $true
      break
    }
    Start-Sleep -Seconds 3
  }

  # PL-127: parallel tasks push to the same branch while this helper retries.
  # Blind retries cannot resolve a non-fast-forward rejection; unlike
  # steward-commit.ps1 (PL-104) this helper had no rebase path, so a green
  # quality gate ended with "FAIL push" and no commit in the remote branch.
  if (-not $pushed) {
    $null = Invoke-Git 'fetch' @('fetch', 'origin', 'dev')
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $local = (& git rev-parse HEAD 2>$null).Trim()
      $remote = (& git rev-parse origin/dev 2>$null).Trim()
    }
    finally { $ErrorActionPreference = $old }
    if ($local -and $local -eq $remote) {
      $pushed = $true
      Log "push: remote already contains HEAD (concurrent push)"
    } else {
      # --autostash keeps foreign unstaged edits from parallel agents safe.
      if ((Invoke-Git 'rebase' @('rebase', '--autostash', 'origin/dev')) -eq 0) {
        if ((Invoke-Git 'push-rebase' @('push', 'origin', 'HEAD:dev')) -eq 0) {
          $pushed = $true
          Log "OK (rebased onto origin/dev): $Message"
        }
      } else {
        $null = Invoke-Git 'rebase-quit' @('rebase', '--quit')
        Log "CONFLICT - manual resolution required: $Message"
        exit 2
      }
    }
  }
  if (-not $pushed) {
    Log "FAIL push: $Message"
    exit 1
  }
  Log "OK: $Message"
}
catch {
  Log "ERROR: $($_.Exception.Message)"
  exit 1
}
