# QA-A2 — post-flight commit+push for a single epic subtask.
# Called by agent-steward's afterScript. Commits ONLY the files owned by the task
# and only when the quality gate wrote its success marker (qa-a2-gate.passed).
param(
  [Parameter(Mandatory = $true)][string]$Message,
  [Parameter(Mandatory = $true)][string]$Files
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$logFile = Join-Path $root 'qa-a2-commit.log'
$marker = Join-Path $root 'qa-a2-gate.passed'

function Log([string]$text) {
  Add-Content -LiteralPath $logFile -Value ("{0} {1}" -f (Get-Date -Format o), $text)
}

try {
  $gateOk = Test-Path -LiteralPath $marker
  if ($marker -and (Test-Path -LiteralPath $marker)) {
    Remove-Item -LiteralPath $marker -Force
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

  git add -- $fileList 2>&1 | ForEach-Object { Log $_ }
  if (git diff --cached --quiet) {
    Log "SKIP (nothing to commit): $Message"
    exit 0
  }

  git commit -m $Message 2>&1 | ForEach-Object { Log $_ }
  if ($LASTEXITCODE -ne 0) {
    Log "FAIL commit: $Message"
    exit 1
  }
  git push origin dev 2>&1 | ForEach-Object { Log $_ }
  if ($LASTEXITCODE -ne 0) {
    Log "FAIL push: $Message"
    exit 1
  }
  Log "OK: $Message"
}
catch {
  Log "ERROR: $($_.Exception.Message)"
  exit 1
}
