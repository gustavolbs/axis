param(
  [Parameter(Mandatory = $true)]
  [string]$MacIp,

  [Parameter(Mandatory = $true)]
  [string]$ListenHost,

  [string]$Model = "qwen3.8:27b",

  [ValidateRange(1, 8)]
  [int]$MaxConcurrentJobs = 1,

  [switch]$VerifyOnly,
  [switch]$SkipRepoUpdate
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$SetupScript = Join-Path $PSScriptRoot "setup-windows-host.ps1"
$WorkerTaskScript = Join-Path $PSScriptRoot "install-windows-worker-task.ps1"
$DashboardTaskScript = Join-Path $PSScriptRoot "install-windows-dashboard-task.ps1"
$FirewallHelpers = Join-Path $PSScriptRoot "windows-firewall.ps1"
$WorkerEntry = Join-Path $RepoRoot "dist\worker-server.js"
$DashboardEntry = Join-Path $RepoRoot "scripts\dashboard.mjs"
$WorkerTaskName = "Local Coder Remote Worker"
$DashboardTaskName = "Local Coder Dashboard"
$WorkerFirewallRule = "Local Coder - Worker from Mac"
$DashboardFirewallRule = "Local Coder - Dashboard from Mac"
$WorkerPort = 7337
$DashboardPort = 7447

. $FirewallHelpers

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-Command {
  param([Parameter(Mandatory = $true)][string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command '$Name' was not found in PATH."
  }
}

function Assert-IPv4Address {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Value
  )

  $parsed = $null
  if (-not [System.Net.IPAddress]::TryParse($Value, [ref]$parsed) -or
      $parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
    throw "$Name must be a valid IPv4 address; received '$Value'."
  }
}

function Invoke-LocalScript {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [string[]]$Arguments = @()
  )

  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Path @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Script '$Path' failed with exit code $LASTEXITCODE."
  }
}

function Assert-FirewallRuleShape {
  param(
    [Parameter(Mandatory = $true)][string]$DisplayName,
    [Parameter(Mandatory = $true)][string]$ExecutablePath,
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$RemoteAddress,
    [string]$LocalAddress = "Any"
  )

  $rule = Get-NetFirewallRule -PolicyStore ActiveStore -DisplayName $DisplayName -ErrorAction Stop
  if ($rule.Enabled.ToString() -ne "True" -or
      $rule.Direction.ToString() -ne "Inbound" -or
      $rule.Action.ToString() -ne "Allow") {
    throw "Firewall rule '$DisplayName' is not an enabled inbound Allow rule."
  }

  $expectedProgram = Resolve-NormalizedProgramPath -Path $ExecutablePath
  $programMatch = @($rule | Get-NetFirewallApplicationFilter -ErrorAction Stop) |
    Where-Object { (Resolve-NormalizedProgramPath -Path ([string]$_.Program)) -eq $expectedProgram }
  if (-not $programMatch) {
    throw "Firewall rule '$DisplayName' is not scoped to $ExecutablePath."
  }

  $portMatch = @($rule | Get-NetFirewallPortFilter -ErrorAction Stop) |
    Where-Object { $_.Protocol.ToString() -eq "TCP" -and [string]$_.LocalPort -eq [string]$Port }
  if (-not $portMatch) {
    throw "Firewall rule '$DisplayName' does not allow TCP local port $Port."
  }

  $addressMatch = @($rule | Get-NetFirewallAddressFilter -ErrorAction Stop) |
    Where-Object {
      $remoteOk = @($_.RemoteAddress) -contains $RemoteAddress
      $localValues = @($_.LocalAddress)
      $localOk = if ($LocalAddress -eq "Any") {
        $localValues -contains "Any"
      } else {
        $localValues -contains $LocalAddress
      }
      $remoteOk -and $localOk
    }
  if (-not $addressMatch) {
    throw "Firewall rule '$DisplayName' has unexpected address filters; expected local '$LocalAddress', remote '$RemoteAddress'."
  }
}

function Assert-ScheduledTaskRuntime {
  param(
    [Parameter(Mandatory = $true)][string]$TaskName,
    [Parameter(Mandatory = $true)][string]$ExecutablePath
  )

  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  $expected = Resolve-NormalizedProgramPath -Path $ExecutablePath
  $actionMatch = @($task.Actions) | Where-Object {
    (Resolve-NormalizedProgramPath -Path ([string]$_.Execute)) -eq $expected
  }
  if (-not $actionMatch) {
    $actual = (@($task.Actions) | ForEach-Object { $_.Execute }) -join ", "
    throw "Scheduled task '$TaskName' uses unexpected executable(s): $actual; expected $ExecutablePath."
  }
}

function Assert-LocalHealth {
  param([Parameter(Mandatory = $true)][string]$DashboardHost)

  $workerToken = [Environment]::GetEnvironmentVariable("LOCAL_CODER_WORKER_TOKEN", "User")
  $workerRequest = @{
    Uri = "http://127.0.0.1:$WorkerPort/v1/health"
    Method = "Get"
    TimeoutSec = 10
  }
  if (-not [string]::IsNullOrWhiteSpace($workerToken)) {
    $workerRequest.Headers = @{ Authorization = "Bearer $workerToken" }
  }

  $workerHealth = Invoke-RestMethod @workerRequest
  if (-not $workerHealth) {
    throw "Worker health endpoint returned an empty response."
  }

  $dashboard = Invoke-WebRequest `
    -Uri "http://$DashboardHost`:$DashboardPort/" `
    -UseBasicParsing `
    -TimeoutSec 10
  if ($dashboard.StatusCode -ne 200) {
    throw "Dashboard root returned HTTP $($dashboard.StatusCode), expected 200."
  }

  $status = Invoke-WebRequest `
    -Uri "http://$DashboardHost`:$DashboardPort/api/status" `
    -UseBasicParsing `
    -TimeoutSec 10
  if ($status.StatusCode -ne 200) {
    throw "Dashboard /api/status returned HTTP $($status.StatusCode), expected 200."
  }
}

function Invoke-FullVerification {
  $node = Get-Command node -ErrorAction Stop
  $runtimeNode = Install-LocalCoderNodeRuntime -NodePath $node.Source

  $windowsMeshnetAddress = Get-NetIPAddress -IPAddress $ListenHost -ErrorAction SilentlyContinue |
    Where-Object { $_.AddressState -eq "Preferred" }
  if (-not $windowsMeshnetAddress) {
    throw "Windows Meshnet IP $ListenHost is not active/preferred. Repair NordVPN Meshnet before Local Coder."
  }

  $workerListener = Wait-LocalCoderListener `
    -Port $WorkerPort `
    -ExecutablePath $runtimeNode `
    -EntryPath $WorkerEntry `
    -TimeoutSeconds 5
  $dashboardListener = Wait-LocalCoderListener `
    -Port $DashboardPort `
    -ExecutablePath $runtimeNode `
    -EntryPath $DashboardEntry `
    -TimeoutSeconds 5

  Assert-ScheduledTaskRuntime -TaskName $WorkerTaskName -ExecutablePath $runtimeNode
  Assert-ScheduledTaskRuntime -TaskName $DashboardTaskName -ExecutablePath $runtimeNode
  Assert-FirewallRuleShape `
    -DisplayName $WorkerFirewallRule `
    -ExecutablePath $runtimeNode `
    -Port $WorkerPort `
    -RemoteAddress $MacIp
  Assert-FirewallRuleShape `
    -DisplayName $DashboardFirewallRule `
    -ExecutablePath $runtimeNode `
    -Port $DashboardPort `
    -RemoteAddress $MacIp `
    -LocalAddress $ListenHost
  Assert-LocalHealth -DashboardHost $ListenHost

  $workerToken = [Environment]::GetEnvironmentVariable("LOCAL_CODER_WORKER_TOKEN", "User")
  $authMode = if ([string]::IsNullOrWhiteSpace($workerToken)) { "disabled" } else { "bearer token" }

  Write-Host ""
  Write-Host "Local Coder Windows host verified healthy." -ForegroundColor Green
  Write-Host "  Worker:    TCP $WorkerPort -> PID $($workerListener.ProcessId) -> $($workerListener.ExecutablePath)"
  Write-Host "  Auth:      $authMode"
  Write-Host "  Dashboard: TCP $DashboardPort -> PID $($dashboardListener.ProcessId) -> $($dashboardListener.ExecutablePath)"
  Write-Host "  Firewall:  exact runtime + Mac $MacIp + required ports"
  Write-Host "  Dashboard: http://$ListenHost`:$DashboardPort -> HTTP 200"
  Write-Host ""
  Write-Host "Final Mac-side check:" -ForegroundColor Cyan
  Write-Host "  nc -vz -G 5 $ListenHost $WorkerPort"
  Write-Host "  nc -vz -G 5 $ListenHost $DashboardPort"
  Write-Host "  curl -m 5 http://$ListenHost`:$DashboardPort/"
}

if (-not (Test-IsAdministrator)) {
  throw "Run this script from an elevated PowerShell (Run as Administrator)."
}

Assert-IPv4Address -Name "MacIp" -Value $MacIp
Assert-IPv4Address -Name "ListenHost" -Value $ListenHost
Assert-Command "git"
Assert-Command "node"
Assert-Command "npm"
Assert-Command "ollama"

if (-not $SkipRepoUpdate -and -not $VerifyOnly) {
  Push-Location $RepoRoot
  try {
    $dirty = @(git status --porcelain --untracked-files=no)
    if ($LASTEXITCODE -ne 0) { throw "git status failed." }
    if ($dirty.Count -gt 0) {
      throw "Repository has tracked local changes. Commit/stash them before running automatic repair so the script never discards local work."
    }

    $branch = (git branch --show-current).Trim()
    if ($LASTEXITCODE -ne 0) { throw "Unable to read current Git branch." }
    if ($branch -ne "main") {
      git switch main
      if ($LASTEXITCODE -ne 0) { throw "Unable to switch repository to main." }
    }

    git pull --ff-only origin main
    if ($LASTEXITCODE -ne 0) { throw "Unable to fast-forward main from origin/main." }
  } finally {
    Pop-Location
  }

  # Relaunch once after updating so every remaining step uses the current main copy
  # of this orchestrator and all subordinate installers.
  $relaunchArgs = @(
    "-MacIp", $MacIp,
    "-ListenHost", $ListenHost,
    "-Model", $Model,
    "-MaxConcurrentJobs", [string]$MaxConcurrentJobs,
    "-SkipRepoUpdate"
  )
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath @relaunchArgs
  exit $LASTEXITCODE
}

Write-Host "== Local Coder Windows ensure ==" -ForegroundColor Cyan
Write-Host "Repository:       $RepoRoot"
Write-Host "Mac Meshnet IP:   $MacIp"
Write-Host "Windows Meshnet:  $ListenHost"
Write-Host "Worker:           $WorkerPort"
Write-Host "Dashboard:        $DashboardPort"
Write-Host "Model:            $Model"
Write-Host ""

if ($VerifyOnly) {
  Invoke-FullVerification
  exit 0
}

$existingToken = [Environment]::GetEnvironmentVariable("LOCAL_CODER_WORKER_TOKEN", "User")
$setupArguments = @{
  MacIp = $MacIp
  Mode = "Worker"
  Model = $Model
  MaxConcurrentJobs = $MaxConcurrentJobs
}
if ($existingToken) {
  Write-Host "Preserving existing worker authentication token." -ForegroundColor Cyan
  $setupArguments.WorkerToken = $existingToken
} else {
  Write-Host "No existing worker token found; worker authentication will remain disabled." -ForegroundColor Yellow
}

# Run setup in this PowerShell process so a preserved bearer token is never exposed in
# a child-process command line. The subordinate task installers do not receive secrets.
& $SetupScript @setupArguments

Invoke-LocalScript -Path $WorkerTaskScript
Invoke-LocalScript `
  -Path $DashboardTaskScript `
  -Arguments @(
    "-MacIp", $MacIp,
    "-ListenHost", $ListenHost
  )

Invoke-FullVerification
