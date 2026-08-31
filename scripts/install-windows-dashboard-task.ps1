param(
  [Parameter(Mandatory = $true)]
  [string]$MacIp,

  [Parameter(Mandatory = $true)]
  [string]$ListenHost,

  [int]$Port = 7447,
  [string]$TaskName = "Local Coder Dashboard",
  [switch]$Remove
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$DashboardEntry = Join-Path $RepoRoot "scripts\dashboard.mjs"
$DashboardIndex = Join-Path $RepoRoot "dashboard\dist\index.html"
$FirewallRule = "Local Coder - Dashboard from Mac"

if ($Remove) {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
  }

  $rule = Get-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue
  if ($rule) {
    Remove-NetFirewallRule -DisplayName $FirewallRule
    Write-Host "Removed firewall rule '$FirewallRule'." -ForegroundColor Green
  }
  return
}

$node = Get-Command node -ErrorAction Stop
if (-not (Test-Path $DashboardEntry)) {
  throw "Missing $DashboardEntry."
}
if (-not (Test-Path $DashboardIndex)) {
  throw "Missing built dashboard at $DashboardIndex. Run npm run build first."
}

$workerToken = [Environment]::GetEnvironmentVariable("LOCAL_CODER_WORKER_TOKEN", "User")
if (-not $workerToken) {
  throw "LOCAL_CODER_WORKER_TOKEN is not configured for the Windows user. Run setup-windows-host.ps1 first."
}

# Persist only connection metadata. The dashboard process reuses the worker bearer token
# already stored in the Windows user's environment; it is never sent to browser JavaScript.
[Environment]::SetEnvironmentVariable("LOCAL_CODER_DASHBOARD_HOST", $ListenHost, "User")
[Environment]::SetEnvironmentVariable("LOCAL_CODER_DASHBOARD_PORT", [string]$Port, "User")
[Environment]::SetEnvironmentVariable("LOCAL_CODER_DASHBOARD_WORKER_URL", "http://127.0.0.1:7337", "User")

$action = New-ScheduledTaskAction `
  -Execute $node.Source `
  -Argument ('"{0}" --no-open' -f $DashboardEntry) `
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
  -Description "Local Coder React dashboard hosted on the Windows execution plane" | Out-Null

$existingRule = Get-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue
if ($existingRule) {
  Remove-NetFirewallRule -DisplayName $FirewallRule
}

New-NetFirewallRule `
  -DisplayName $FirewallRule `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalAddress $ListenHost `
  -LocalPort $Port `
  -RemoteAddress $MacIp `
  -Profile Private | Out-Null

Write-Host "Installed scheduled task '$TaskName'." -ForegroundColor Green
Write-Host "Dashboard listens only on $ListenHost`:$Port and the firewall allows only Mac $MacIp on the Private profile."
Write-Host ""
Write-Host "Start it now with:"
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host ""
Write-Host "Open from the Mac:"
Write-Host "  http://$ListenHost`:$Port"
