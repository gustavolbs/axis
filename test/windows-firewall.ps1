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

Write-Host "Windows firewall guard tests passed." -ForegroundColor Green
