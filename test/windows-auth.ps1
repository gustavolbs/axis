$ErrorActionPreference = "Stop"
$helpers = Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..\scripts")) "windows-auth.ps1"
. $helpers

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

$existing = "existing-token-value"

$preserved = Resolve-LocalCoderWorkerToken -ExistingToken $existing
Assert-True ($preserved.Source -eq "existing") "Expected existing token source."
Assert-True ($preserved.Token -eq $existing) "Existing worker token was not preserved."
Assert-True (-not $preserved.Changed) "Preserved token should not be marked changed."

$explicit = Resolve-LocalCoderWorkerToken -ExistingToken $existing -RequestedToken "explicit-token"
Assert-True ($explicit.Source -eq "explicit") "Expected explicit token source."
Assert-True ($explicit.Token -eq "explicit-token") "Explicit token was not used."
Assert-True $explicit.Changed "Different explicit token should be marked changed."

$firstInstall = Resolve-LocalCoderWorkerToken -ExistingToken $null
Assert-True ($firstInstall.Source -eq "generated") "Expected first install to generate a token."
Assert-True ($firstInstall.Changed) "Generated token should be marked changed."
Assert-True (-not [string]::IsNullOrWhiteSpace($firstInstall.Token)) "Generated token is empty."

$rotated = Resolve-LocalCoderWorkerToken -ExistingToken $existing -Rotate
Assert-True ($rotated.Source -eq "rotated") "Expected explicit rotation source."
Assert-True ($rotated.Changed) "Rotated token should be marked changed."
Assert-True ($rotated.Token -ne $existing) "Rotation unexpectedly preserved old token."

$threw = $false
try {
  Resolve-LocalCoderWorkerToken -ExistingToken $existing -RequestedToken "explicit-token" -Rotate | Out-Null
} catch {
  $threw = $true
  Assert-True ($_.Exception.Message -match "Do not combine") "Unexpected conflict error message."
}
Assert-True $threw "Expected explicit token + rotation to fail."

Write-Host "Windows worker token tests passed." -ForegroundColor Green
