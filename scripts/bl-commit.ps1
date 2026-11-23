# Post-flight commit+push for ONE backlog task.
# Reads the exact file list produced by the task agent (manifest) and commits
# only those files when the task's own Quality Gate wrote its marker.
# Foreign pre-existing edits are filtered out explicitly (PL-41).
param(
  [Parameter(Mandatory = $true)][string]$Message,
  [Parameter(Mandatory = $true)][string]$Manifest,
  [Parameter(Mandatory = $true)][string]$Marker
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$logFile = Join-Path $root 'bl-commit.log'
$markerPath = Join-Path $root $Marker
$manifestPath = Join-Path $root $Manifest

function Log([string]$text) {
  Add-Content -LiteralPath $logFile -Value ("{0} {1}" -f (Get-Date -Format o), $text)
}

# git writes progress to stderr; PowerShell 7 with Stop turns that into a
# terminating error even when the command succeeded. Use the real exit code.
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
  if ($gateOk) { Remove-Item -LiteralPath $markerPath -Force }
  if (-not $gateOk) {
    Log "SKIP (quality gate did not pass): $Message"
    exit 0
  }
  if (-not (Test-Path -LiteralPath $manifestPath)) {
    Log "SKIP (no manifest): $Message"
    exit 0
  }

  # Foreign work that was already in the working tree before this backlog run.
  $foreign = @(
    'docs/QA-A2-GUI-TUI.md',
    'reports/QA-A2-alert.md',
    'reports/QA-A2-final.md',
    'reports/QA-A2.7-verify-os.md'
  )
  $fileList = @(
    Get-Content -LiteralPath $manifestPath -Encoding UTF8 |
      Where-Object { $_ -and -not $_.TrimStart().StartsWith('#') } |
      ForEach-Object { $_.Trim().Replace('\', '/') } |
      Where-Object { $_ -and ($foreign -notcontains $_) }
  )
  if ($fileList.Count -eq 0) {
    Log "SKIP (no files): $Message"
    exit 0
  }
  Log ("FILES: " + ($fileList -join ' | '))

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

  if ((Invoke-Git 'commit' (@('commit', '-m', $Message, '--') + $fileList)) -ne 0) {
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
    Log "FAIL push: $Message"
    exit 1
  }
  Log "OK: $Message"
}
catch {
  Log "ERROR: $($_.Exception.Message)"
  exit 1
}
