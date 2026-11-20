# QA-3.8.2: resilient GitHub Actions fetch (ECONNRESET retry + timeout).
$ErrorActionPreference = 'Stop'
$out = Join-Path (Get-Location) 'github-ci-runs.json'
$headers = @{ 'User-Agent' = 'agent-steward-github-ci-check'; 'Accept' = 'application/vnd.github+json' }
$uri = 'https://api.github.com/repos/DeadSno/agent-steward/actions/runs?per_page=5'
$body = $null
for ($i = 1; $i -le 4; $i++) {
  try {
    $body = Invoke-RestMethod -Uri $uri -Headers $headers -TimeoutSec 30
    break
  } catch {
    Write-Warning "GitHub fetch attempt ${i}: $($_.Exception.Message)"
    if ($i -eq 4) { throw }
    Start-Sleep -Seconds (2 * $i)
  }
}
$since = (Get-Date).ToUniversalTime().AddHours(-24)
$runs = @($body.workflow_runs | Where-Object { [datetime]::Parse($_.created_at).ToUniversalTime() -ge $since })
$jobs = @()
foreach ($run in $runs) {
  $j = $null
  for ($k = 1; $k -le 3; $k++) {
    try {
      $j = Invoke-RestMethod -Uri ("https://api.github.com/repos/DeadSno/agent-steward/actions/runs/$($run.id)/jobs") -Headers $headers -TimeoutSec 30
      break
    } catch {
      Write-Warning "Jobs fetch attempt ${k}: $($_.Exception.Message)"
      if ($k -eq 3) { $j = @{ jobs = @() }; break }
      Start-Sleep -Seconds (2 * $k)
    }
  }
  foreach ($job in $j.jobs) {
    $jobs += [pscustomobject]@{ runId = $run.id; name = $job.name; conclusion = $job.conclusion; url = $job.html_url; createdAt = $run.created_at }
  }
}
$jobs | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $out -Encoding UTF8
Write-Output "Fetched $($jobs.Count) jobs into $out"
