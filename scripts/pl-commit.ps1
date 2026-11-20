# Post-flight commit+push for one QA-findings task (Деталь 1.5 / 1.6).
# Called by agent-steward's afterScript. Commits ONLY the files owned by the task
# and only when that task's quality gate wrote its own success marker.
# Generalizes scripts/qa-a2-commit.ps1: the marker is a parameter, so parallel
# tasks cannot consume each other's gate signal.
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

  if ((Invoke-Git 'add' (@('add', '--') + $fileList)) -ne 0) {
    Log "FAIL add: $Message"
    exit 1
  }
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $nothing = git diff --cached --quiet; $cleanCode = $LASTEXITCODE }
  finally { $ErrorActionPreference = $old }
  if ($cleanCode -eq 0) {
    Log "SKIP (nothing to commit): $Message"
    exit 0
  }

  if ((Invoke-Git 'commit' @('commit', '-m', $Message)) -ne 0) {
    Log "FAIL commit: $Message"
    exit 1
  }

  $pushed = $false
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    if ((Invoke-Git "push#$attempt" @('push', 'origin', 'dev')) -eq 0) {
      $pushed = $true
      break
    }
    Start-Sleep -Seconds 3
  }
  if (-not $pushed) {
    # A parallel task may have pushed our commit already — verify before failing.
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
