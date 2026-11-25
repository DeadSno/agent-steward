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
# PL-127/PL-132: a rejected push is repaired by replaying ONLY the commit this
# helper just created onto a fresh origin/dev with cherry-pick. We never rebase
# the whole branch: local commits already present in origin/dev under other
# hashes would conflict on stale docs, and rebase --quit used to leave a
# detached HEAD with an unresolved (UU) index. The origin remote name works for
# GitHub and for a local mirror alike - no remote URL or path is hard-coded.
param(
  [Parameter(Mandatory = $true)][string]$Message,
  [Parameter(Mandatory = $true)][string]$Files,
  [Parameter(Mandatory = $true)][string]$Marker,
  # PL-142: explicit list of checks that must pass before the gate marker is
  # consumed. Accepts an array ('npm run build', 'npm run lint') or a single
  # 'npm run build;npm run lint' string - each entry is split on ';'.
  # Defaults to build + lint (the values below are ready PS expressions, so
  # '& npm run build 2>&1' stays the anchor for the PL-135 source regression).
  [string[]]$VerifyCommands = @('& npm run build 2>&1', '& npm run lint 2>&1')
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$logFile = Join-Path $root 'pl-commit.log'
$markerPath = Join-Path $root $Marker

function Log([string]$text) {
  Add-Content -LiteralPath $logFile -Value ("{0} {1}" -f (Get-Date -Format o), $text)
}

# QA-D316-11: the child agent may write the manifest after the wrapper took
# its snapshot (PL-134 interrupted finalization). Wait until the task files
# stop changing, then compute the diff. The time limit prevents a hang.
function Wait-ManifestSettle {
  param([string[]]$Paths, [int]$MaxSeconds)
  if ($MaxSeconds -le 0 -or $Paths.Count -eq 0) { return }

  function Get-ManifestStamp {
    $oldPref = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      return [string]::Join("`n", @(& git status --porcelain --untracked-files=all -- @Paths 2>$null))
    }
    finally { $ErrorActionPreference = $oldPref }
  }

  $stable = 0
  $previous = Get-ManifestStamp
  for ($i = 0; $i -lt $MaxSeconds; $i++) {
    Start-Sleep -Seconds 1
    $current = Get-ManifestStamp
    if ($current -eq $previous) { $stable++ } else { $stable = 0; $previous = $current }
    if ($stable -ge 2) {
      Log "QA-D316-11: manifest stable before diff ($Message)"
      return
    }
  }
  Log "WARN QA-D316-11: manifest kept changing for ${MaxSeconds}s, committing current diff: $Message"
}

# P1-B: the non-FF repair runs `reset --hard`, which would destroy uncommitted
# changes the task does not own (files outside -Files). Foreign tracked
# modifications are moved into a path-limited stash BEFORE the reset and
# restored after the replay. The stash sha is remembered, so a failed restore
# keeps the data recoverable with `git stash apply <sha>`.
$script:foreignStashSha = $null

function Save-ForeignChanges {
  param([string[]]$Paths)
  if (-not $Paths -or $Paths.Count -eq 0) { return $true }
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $before = (& git rev-parse -q --verify refs/stash 2>$null)
    $null = & git stash push -m 'pl-commit foreign (P1-B)' -- @Paths 2>&1
    $code = $LASTEXITCODE
    $after = (& git rev-parse -q --verify refs/stash 2>$null)
  } finally { $ErrorActionPreference = $old }
  if ($code -ne 0) { return $false }
  $sha = ([string]$after).Trim()
  if (-not $sha -or $sha -eq ([string]$before).Trim()) { return $true }
  $script:foreignStashSha = $sha
  Log "P1-B: foreign changes stashed before repair ($sha): $($Paths -join '; ')"
  return $true
}

function Restore-ForeignChanges {
  if (-not $script:foreignStashSha) { return }
  $sha = $script:foreignStashSha
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $null = & git stash apply $sha 2>&1
    $code = $LASTEXITCODE
    if ($code -eq 0) {
      $list = @(& git stash list --format='%H' 2>$null)
      for ($i = 0; $i -lt $list.Count; $i++) {
        if (([string]$list[$i]).Trim() -eq $sha) { $null = & git stash drop "stash@{$i}" 2>$null; break }
      }
    }
  } finally { $ErrorActionPreference = $old }
  if ($code -eq 0) {
    $script:foreignStashSha = $null
    Log "P1-B: foreign changes restored after repair"
  } else {
    Log "WARN P1-B: foreign changes NOT auto-restored; recover with: git stash apply $sha"
  }
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
  # PL-142: read the gate marker but DO NOT burn it yet. A stale or hand-made
  # marker must never push broken code: verification runs first and the marker
  # is removed only when every check passed. On failure we exit 2 with the
  # marker intact, so no staging/commit/push happens.
  $gateOk = Test-Path -LiteralPath $markerPath
  if (-not $gateOk) {
    Log "SKIP (quality gate did not pass): $Message"
    exit 0
  }
  $markerContent = Get-Content -LiteralPath $markerPath -Raw
  Log ("PL-142: gate marker read ({0}): {1}" -f $markerPath, ([string]$markerContent).Trim())

  $fileList = @($Files -split ';' | Where-Object { $_ } | ForEach-Object { $_.Trim() })
  if ($fileList.Count -eq 0) {
    Log "SKIP (no files): $Message"
    exit 0
  }

  # PL-135 + PL-142: verify BEFORE staging/committing/pushing. Build and lint
  # (plus any extra -VerifyCommands) come from one explicit list; every command
  # must exit 0 before the gate marker is consumed. The marker alone is not
  # enough - it can be left over from an older run or created by hand, so a
  # failing check (e.g. npm run build/lint = exit 2) must never reach dev.
  $verifyList = @()
  foreach ($entry in @($VerifyCommands)) {
    foreach ($part in (@($entry) -split ';')) {
      $c = ([string]$part).Trim()
      if ($c) { $verifyList += $c }
    }
  }
  if ($verifyList.Count -eq 0) {
    Log "FAIL verify (empty -VerifyCommands): commit/push aborted: $Message"
    exit 2
  }

  foreach ($cmd in $verifyList) {
    # Accept both 'npm run lint' and '& npm run lint 2>&1' forms.
    $expr = ([string]$cmd).Trim()
    if (-not $expr.StartsWith('&')) { $expr = "& $expr" }
    if (-not $expr.Contains('2>&1')) { $expr = "$expr 2>&1" }

    $oldVerify = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $verifyOutput = Invoke-Expression -Command $expr
      $verifyCode = $LASTEXITCODE
      foreach ($line in @($verifyOutput)) { Log ("[verify:{0}] {1}" -f $cmd, [string]$line) }
    }
    finally {
      $ErrorActionPreference = $oldVerify
    }
    if ($verifyCode -ne 0) {
      # PL-142: marker stays on failure; no commit/push. Keep 'exit 2' adjacent
      # to the build log line for the PL-135 source-level regression.
      Log "PL-142: gate marker kept (verification failed): $markerPath"
      if ($cmd -match 'build') {
        Log "FAIL build (npm run build exit $verifyCode): commit/push aborted: $Message"
        exit 2
      }
      Log "FAIL verify ('$cmd' exit $verifyCode): commit/push aborted: $Message"
      exit 2
    }
    Log "OK verify ($cmd): $Message"
  }

  # PL-142: all verification passed - now (and only now) consume the marker.
  Remove-Item -LiteralPath $markerPath -Force
  Log "PL-142: gate marker consumed after successful verification: $Message"

  # QA-D316-11: wait for final manifest edits before git diff (late writes to
  # ROADMAP/CHANGELOG/tests would otherwise be missed while status stays
  # success). Default 5s, 0 disables the wait.
  $settleSec = 5
  if ($env:AGENT_STEWARD_COMMIT_SETTLE_SEC -match '^\d+$') {
    $settleSec = [Math]::Min(60, [int]$env:AGENT_STEWARD_COMMIT_SETTLE_SEC)
  }
  Wait-ManifestSettle -Paths $fileList -MaxSeconds $settleSec

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
    # QA-D316-11: "nothing to commit" is not success if manifest files are
    # actually changed (snapshot was taken before agent finalization).
    $oldStatus = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $manifestStatus = @(& git status --porcelain --untracked-files=all -- @fileList 2>$null)
    }
    finally { $ErrorActionPreference = $oldStatus }
    if ($manifestStatus.Count -gt 0) {
      Log "FAIL QA-D316-11: manifest changed but no commit (agent finalization missed): $Message"
      exit 3
    }
    Log "SKIP (nothing to commit): $Message"
    exit 0
  }

  if ((Invoke-Git 'commit' (@('commit', '-m', $Message, '--') + $commitFiles)) -ne 0) {
    Log "FAIL commit: $Message"
    exit 1
  }

  # QA-D316-11: the commit must contain ALL changed manifest files. After
  # PL-134, edits appeared after the snapshot and the partial commit still
  # left the task as success - fail such a run.
  $oldLeftover = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $leftoverRaw = @(& git diff --name-only HEAD -- @fileList 2>$null)
  }
  finally { $ErrorActionPreference = $oldLeftover }
  $leftover = @($leftoverRaw | ForEach-Object { ([string]$_).Trim() -replace '\\', '/' } |
    Where-Object { $_ -and $manifest.ContainsKey($_) })
  if ($leftover.Count -gt 0) {
    Log "FAIL QA-D316-11: manifest not fully committed: $($leftover -join '; '): $Message"
    exit 3
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

  # PL-127/PL-132: a rejected push is not repaired by blind retries or by
  # rebasing the whole branch. A rebase replays local commits already present
  # in origin/dev under different hashes and dies on stale CHANGELOG/ROADMAP
  # conflicts; rebase --quit then leaves a detached HEAD and a UU index.
  # Instead: fetch, remember this helper's single new commit, move to the fresh
  # origin/dev tip and cherry-pick that one commit, then push again.
  # The origin/dev remote-tracking ref works for GitHub and for a local mirror
  # alike - no remote URL or filesystem path is hard-coded here.
  if (-not $pushed) {
    if ((Invoke-Git 'fetch-nonff' @('fetch', 'origin', 'dev')) -ne 0) {
      Log "FAIL fetch origin dev: $Message"
      exit 1
    }
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $local = (& git rev-parse HEAD 2>$null).Trim()
      $remote = (& git rev-parse origin/dev 2>$null).Trim()
    }
    finally { $ErrorActionPreference = $old }
    if (-not $local -or -not $remote) {
      Log "FAIL rev-parse HEAD/origin/dev: $Message"
      exit 1
    }
    if ($local -eq $remote) {
      $pushed = $true
      Log "push: remote already contains HEAD (concurrent push): $Message"
    }
    else {
      # P1-B: capture foreign uncommitted changes BEFORE the destructive reset.
      $oldRepair = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      try { $repairRaw = @(& git diff --name-only HEAD 2>$null) } finally { $ErrorActionPreference = $oldRepair }
      $foreignNow = @($repairRaw | ForEach-Object { ([string]$_).Trim() -replace '\\', '/' } |
        Where-Object { $_ -and -not $manifest.ContainsKey($_) } | Sort-Object -Unique)
      if ($foreignNow.Count -gt 0 -and -not (Save-ForeignChanges $foreignNow)) {
        Log "FAIL P1-B: foreign changes present but stash failed; repair aborted to protect them: $($foreignNow -join '; '): $Message"
        exit 1
      }
      # Reset the current branch (NOT a detached checkout) to the fresh remote
      # tip, then replay exactly one commit: our own pathspec-limited commit.
      if ((Invoke-Git 'reset-remote' @('reset', '--hard', 'origin/dev')) -ne 0) {
        Restore-ForeignChanges
        Log "FAIL reset --hard origin/dev: $Message"
        exit 1
      }
      $pickCode = Invoke-Git 'cherry-pick' @('cherry-pick', $local)
      if ($pickCode -ne 0) {
        # PL-132: on conflict run 'git cherry-pick --abort', then force a clean
        # tree. --abort restores HEAD to origin/dev; reset --hard clears any
        # UU index entries. No detached HEAD, no unresolved state, no push.
        $oldPick = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
          $cpHead = (& git rev-parse --git-path CHERRY_PICK_HEAD 2>$null).Trim()
        }
        finally { $ErrorActionPreference = $oldPick }
        if ($cpHead -and (Test-Path -LiteralPath $cpHead)) {
          $null = Invoke-Git 'cherry-pick-abort' @('cherry-pick', '--abort')
        }
        $null = Invoke-Git 'reset-clean' @('reset', '--hard', 'HEAD')
        Restore-ForeignChanges
        Log "PL-132: cherry-pick --abort; conflict replaying $local onto origin/dev; tree clean, no push: $Message"
        exit 2
      }
      if ((Invoke-Git 'push-picked' @('push', 'origin', 'HEAD:dev')) -ne 0) {
        Restore-ForeignChanges
        Log "FAIL push after cherry-pick: $Message"
        exit 1
      }
      Restore-ForeignChanges
      $pushed = $true
      Log "OK (cherry-picked onto origin/dev): $Message"
    }
  }
  if (-not $pushed) {
    Log "FAIL push: $Message"
    exit 1
  }
  Log "OK: $Message"
}
catch {
  Restore-ForeignChanges
  Log "ERROR: $($_.Exception.Message)"
  exit 1
}
