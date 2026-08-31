param(
  [string]$TaskName = "Local Coder Remote Worker",
  [switch]$Remove,
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$WorkerEntry = Join-Path $RepoRoot "dist\worker-server.js"
$FirewallHelpers = Join-Path $PSScriptRoot "windows-firewall.ps1"
$WorkerFirewallRule = "Local Coder - Worker from Mac"
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
  } else {
    Write-Host "Scheduled task '$TaskName' does not exist."
  }
  if (Test-Path $WorkerEntry) {
    Stop-LocalCoderListenerForInstall -Port 7337 -EntryPath $WorkerEntry
  }
  return
}

if (-not (Test-IsAdministrator)) {
  throw "Run PowerShell as Administrator so the installer can replace stale listeners and verify Windows Firewall state."
}

$node = Get-Command node -ErrorAction Stop
$localCoderNode = Install-LocalCoderNodeRuntime -NodePath $node.Source
if (-not (Test-Path $WorkerEntry)) {
  throw "Missing $WorkerEntry. Run npm run build first."
}
if (-not [Environment]::GetEnvironmentVariable("LOCAL_CODER_WORKER_TOKEN", "User")) {
  throw "LOCAL_CODER_WORKER_TOKEN is not configured for the Windows user. Run setup-windows-host.ps1 first."
}

$workerRule = Get-NetFirewallRule -PolicyStore ActiveStore -DisplayName $WorkerFirewallRule -ErrorAction SilentlyContinue
if (-not $workerRule) {
  throw "Missing active firewall rule '$WorkerFirewallRule'. Run setup-windows-host.ps1 first."
}
$expectedProgram = Resolve-NormalizedProgramPath -Path $localCoderNode
$programMatch = @($workerRule | Get-NetFirewallApplicationFilter -ErrorAction Stop) |
  Where-Object { (Resolve-NormalizedProgramPath -Path ([string]$_.Program)) -eq $expectedProgram }
if (-not $programMatch) {
  throw "Firewall rule '$WorkerFirewallRule' is not scoped to the dedicated Local Coder runtime. Run setup-windows-host.ps1 again before installing the task."
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# A manually started or older scheduled worker may survive task replacement and keep
# 7337 bound to the system-wide node.exe. Stop it only when its command line proves
# that it is this Local Coder worker; refuse to kill unrelated port owners.
Stop-LocalCoderListenerForInstall -Port 7337 -EntryPath $WorkerEntry

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

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "Authenticated local-coder execution worker for Claude Code" | Out-Null

Write-Host "Installed scheduled task '$TaskName'." -ForegroundColor Green
Write-Host "Dedicated Node runtime: $localCoderNode"

if (-not $NoStart) {
  Start-ScheduledTask -TaskName $TaskName
  $listener = Wait-LocalCoderListener `
    -Port 7337 `
    -ExecutablePath $localCoderNode `
    -EntryPath $WorkerEntry
  Write-Host "Verified worker listener TCP 7337 -> PID $($listener.ProcessId) -> $($listener.ExecutablePath)" -ForegroundColor Green
  Write-Host "A second firewall conflict check ran after the real listener was established."
} else {
  Write-Host "Task was installed but not started because -NoStart was supplied."
}

Write-Host "Inspect it with:"
Write-Host "  Get-ScheduledTask -TaskName '$TaskName' | Format-List *"
