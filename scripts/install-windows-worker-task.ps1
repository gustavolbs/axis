param(
  [string]$TaskName = "Local Coder Remote Worker",
  [switch]$Remove
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$WorkerEntry = Join-Path $RepoRoot "dist\worker-server.js"
$FirewallHelpers = Join-Path $PSScriptRoot "windows-firewall.ps1"
. $FirewallHelpers

if ($Remove) {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
  } else {
    Write-Host "Scheduled task '$TaskName' does not exist."
  }
  return
}

$node = Get-Command node -ErrorAction Stop
$localCoderNode = Install-LocalCoderNodeRuntime -NodePath $node.Source
if (-not (Test-Path $WorkerEntry)) {
  throw "Missing $WorkerEntry. Run npm run build first."
}
if (-not [Environment]::GetEnvironmentVariable("LOCAL_CODER_WORKER_TOKEN", "User")) {
  throw "LOCAL_CODER_WORKER_TOKEN is not configured for the Windows user. Run setup-windows-host.ps1 first."
}

$action = New-ScheduledTaskAction `
  -Execute $localCoderNode `
  -Argument ('"{0}"' -f $WorkerEntry) `
  -WorkingDirectory $RepoRoot

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Days 3650) `
  -RestartCount 10 `
  -RestartInterval (New-TimeSpan -Minutes 1)

$principal = New-ScheduledTaskPrincipal `
  -UserId $env:USERNAME `
  -LogonType Interactive `
  -RunLevel Limited

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "Authenticated local-coder execution worker for Claude Code" | Out-Null

Write-Host "Installed scheduled task '$TaskName'." -ForegroundColor Green
Write-Host "It starts the worker at Windows logon using the dedicated Local Coder Node runtime:"
Write-Host "  $localCoderNode $WorkerEntry"
Write-Host "System-wide Node firewall rules cannot target this runtime path."
Write-Host ""
Write-Host "Start it now with:"
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Inspect it with:"
Write-Host "  Get-ScheduledTask -TaskName '$TaskName' | Format-List *"
