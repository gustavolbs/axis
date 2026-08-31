$ErrorActionPreference = "Stop"
$helpers = Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..\scripts")) "windows-firewall.ps1"
. $helpers

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

# The dedicated runtime must be a different executable path from the system-wide Node
# and must remain runnable after copying.
$systemNode = (Get-Command node -ErrorAction Stop).Source
$runtimeNode = Install-LocalCoderNodeRuntime -NodePath $systemNode
Assert-True ($runtimeNode -ne $systemNode) "Dedicated runtime unexpectedly equals the system Node path."
Assert-True (Test-Path $runtimeNode) "Dedicated runtime was not created."
$systemVersion = & $systemNode --version
$runtimeVersion = & $runtimeNode --version
Assert-True ($systemVersion -eq $runtimeVersion) "Dedicated runtime does not execute the installed Node version."

# Mock the NetSecurity cmdlets so the firewall guard can be tested without changing
# the GitHub runner firewall policy.
$script:mockRules = @()

function Get-NetFirewallRule {
  [CmdletBinding()]
  param(
    [string]$PolicyStore,
    [string]$DisplayName,
    [string]$Name
  )

  $rules = @($script:mockRules)
  if ($DisplayName) { $rules = @($rules | Where-Object DisplayName -eq $DisplayName) }
  if ($Name) { $rules = @($rules | Where-Object Name -eq $Name) }
  return $rules
}

function Get-NetFirewallApplicationFilter {
  [CmdletBinding()]
  param([Parameter(ValueFromPipeline = $true)]$InputObject)
  process { [PSCustomObject]@{ Program = $InputObject.Program } }
}

function Disable-NetFirewallRule {
  [CmdletBinding()]
  param([string]$Name)
  $rule = $script:mockRules | Where-Object Name -eq $Name | Select-Object -First 1
  if (-not $rule) { throw "Mock firewall rule '$Name' not found." }
  $rule.Enabled = "False"
}

$script:mockRules = @(
  [PSCustomObject]@{
    Name = "auto-node-block"
    DisplayName = "Node.js JavaScript Runtime"
    Enabled = "True"
    Direction = "Inbound"
    Action = "Block"
    PolicyStoreSourceType = "Local"
    Program = $runtimeNode
  }
)

$disabled = @(Disable-ConflictingInboundProgramBlockRules -ExecutablePath $runtimeNode)
Assert-True ($disabled.Count -eq 1) "Expected exactly one Windows-generated Node block to be repaired."
Assert-True ($script:mockRules[0].Enabled -eq "False") "Windows-generated Node block was not disabled."

# Custom or managed blocks must never be silently disabled.
$script:mockRules = @(
  [PSCustomObject]@{
    Name = "custom-security-block"
    DisplayName = "Corporate Node Restriction"
    Enabled = "True"
    Direction = "Inbound"
    Action = "Block"
    PolicyStoreSourceType = "Local"
    Program = $runtimeNode
  }
)

$threw = $false
try {
  Disable-ConflictingInboundProgramBlockRules -ExecutablePath $runtimeNode | Out-Null
} catch {
  $threw = $true
  Assert-True ($_.Exception.Message -match "custom or managed") "Unexpected custom-policy error message: $($_.Exception.Message)"
}
Assert-True $threw "Expected custom Node Block policy to fail safely."
Assert-True ($script:mockRules[0].Enabled -eq "True") "Custom Node Block policy was modified."

# Reproduce the rollout failure mode: an old Local Coder process can keep the port
# bound to the system Node executable even after the scheduled task is replaced.
$script:mockRules = @()
$workerEntry = "C:\WORK\local-coder-mcp\dist\worker-server.js"
$script:mockProcesses = @{}
$script:mockListenerPids = @()

function Get-NetTCPConnection {
  [CmdletBinding()]
  param([int]$LocalPort, [string]$State)
  return @($script:mockListenerPids | ForEach-Object {
    [PSCustomObject]@{ LocalPort = $LocalPort; State = "Listen"; OwningProcess = $_ }
  })
}

function Get-CimInstance {
  [CmdletBinding()]
  param([string]$ClassName, [string]$Filter)
  if ($Filter -match "ProcessId\s*=\s*(\d+)") {
    return $script:mockProcesses[[int]$Matches[1]]
  }
  return $null
}

function Stop-Process {
  [CmdletBinding()]
  param([int]$Id, [switch]$Force)
  $script:mockListenerPids = @($script:mockListenerPids | Where-Object { $_ -ne $Id })
}

function Start-Sleep {
  [CmdletBinding()]
  param([int]$Milliseconds, [int]$Seconds)
}

$script:mockProcesses[4100] = [PSCustomObject]@{
  ProcessId = 4100
  ExecutablePath = $systemNode
  CommandLine = ('"{0}" "{1}"' -f $systemNode, $workerEntry)
}
$script:mockListenerPids = @(4100)
Stop-LocalCoderListenerForInstall -Port 7337 -EntryPath $workerEntry
Assert-True ($script:mockListenerPids.Count -eq 0) "Stale Local Coder listener was not stopped."

# The installer must fail if a listener exists for the right Local Coder entry point
# but it is still running through the global Node executable instead of the dedicated runtime.
$script:mockProcesses[4200] = [PSCustomObject]@{
  ProcessId = 4200
  ExecutablePath = $systemNode
  CommandLine = ('"{0}" "{1}"' -f $systemNode, $workerEntry)
}
$script:mockListenerPids = @(4200)
$threw = $false
try {
  Wait-LocalCoderListener -Port 7337 -ExecutablePath $runtimeNode -EntryPath $workerEntry -TimeoutSeconds 1 | Out-Null
} catch {
  $threw = $true
  Assert-True ($_.Exception.Message -match "unexpected executable") "Unexpected wrong-runtime error: $($_.Exception.Message)"
}
Assert-True $threw "Expected wrong listener executable to fail validation."

# A listener owned by the dedicated runtime passes, and the post-bind firewall check runs.
$script:mockProcesses[4300] = [PSCustomObject]@{
  ProcessId = 4300
  ExecutablePath = $runtimeNode
  CommandLine = ('"{0}" "{1}"' -f $runtimeNode, $workerEntry)
}
$script:mockListenerPids = @(4300)
$listener = Wait-LocalCoderListener -Port 7337 -ExecutablePath $runtimeNode -EntryPath $workerEntry -TimeoutSeconds 1
Assert-True ($listener.ProcessId -eq 4300) "Dedicated runtime listener was not accepted."

Write-Host "Windows firewall and listener supervision tests passed." -ForegroundColor Green
