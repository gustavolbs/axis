param(
  [Parameter(Mandatory = $true)]
  [string]$MacIp,

  [Parameter(Mandatory = $true)]
  [string]$ListenHost,

  [int]$Port = 7447,
  [string]$TaskName = "Local Coder Dashboard",
  [switch]$Remove,
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$DashboardEntry = Join-Path $RepoRoot "scripts\dashboard.mjs"
$DashboardIndex = Join-Path $RepoRoot "dashboard\dist\index.html"
$FirewallRule = "Local Coder - Dashboard from Mac"
$FirewallHelpers = Join-Path $PSScriptRoot "windows-firewall.ps1"
. $FirewallHelpers

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if ($Remove) {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existing) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
  }
  if (Test-Path $DashboardEntry) {
    Stop-LocalCoderListenerForInstall -Port $Port -EntryPath $DashboardEntry
  }

  $rule = Get-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue
  if ($rule) {
    Remove-NetFirewallRule -DisplayName $FirewallRule
    Write-Host "Removed firewall rule '$FirewallRule'." -ForegroundColor Green
  }
  return
}

if (-not (Test-IsAdministrator)) {
  throw "Run PowerShell as Administrator so the installer can replace stale listeners and verify restricted Windows Firewall rules."
}

$node = Get-Command node -ErrorAction Stop
$localCoderNode = Install-LocalCoderNodeRuntime -NodePath $node.Source
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

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# A manually started or older dashboard may survive task replacement and keep 7447
# bound to the system-wide node.exe. Stop it only when the command line proves that
# it is this Local Coder dashboard; refuse to kill unrelated port owners.
Stop-LocalCoderListenerForInstall -Port $Port -EntryPath $DashboardEntry

$action = New-ScheduledTaskAction `
  -Execute $localCoderNode `
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

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "Local Coder React dashboard hosted on the Windows execution plane" | Out-Null

# The dashboard uses a dedicated Node runtime and an exact Mac/address/port firewall
# rule. Windows-generated Node blocks are checked before and again after the listener
# is real, because Windows may create an application rule on first bind.
Set-LocalCoderInboundFirewallRule `
  -DisplayName $FirewallRule `
  -ExecutablePath $localCoderNode `
  -Port $Port `
  -RemoteAddress $MacIp `
  -LocalAddress $ListenHost `
  -Profile Any

Write-Host "Installed scheduled task '$TaskName'." -ForegroundColor Green
Write-Host "Dedicated Node runtime: $localCoderNode"

if (-not $NoStart) {
  Start-ScheduledTask -TaskName $TaskName
  $listener = Wait-LocalCoderListener `
    -Port $Port `
    -ExecutablePath $localCoderNode `
    -EntryPath $DashboardEntry
  Write-Host "Verified dashboard listener TCP $Port -> PID $($listener.ProcessId) -> $($listener.ExecutablePath)" -ForegroundColor Green
  Write-Host "A second firewall conflict check ran after the real listener was established."
} else {
  Write-Host "Task was installed but not started because -NoStart was supplied."
}

Write-Host "Dashboard URL from the Mac: http://$ListenHost`:$Port"
