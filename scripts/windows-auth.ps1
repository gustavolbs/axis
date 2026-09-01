function New-LocalCoderWorkerToken {
  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }
  return [Convert]::ToBase64String($bytes)
}

function Resolve-LocalCoderWorkerToken {
  param(
    [string]$RequestedToken = "",
    [switch]$Rotate,
    [AllowNull()][string]$ExistingToken = [Environment]::GetEnvironmentVariable("LOCAL_CODER_WORKER_TOKEN", "User")
  )

  if ($RequestedToken -and $Rotate) {
    throw "Do not combine -WorkerToken with -RotateWorkerToken. Supply the exact token or request a generated rotation, not both."
  }

  if ($RequestedToken) {
    return [PSCustomObject]@{
      Token = $RequestedToken
      Source = "explicit"
      Changed = $ExistingToken -ne $RequestedToken
    }
  }

  if ($Rotate) {
    $generated = New-LocalCoderWorkerToken
    return [PSCustomObject]@{
      Token = $generated
      Source = "rotated"
      Changed = $true
    }
  }

  if (-not [string]::IsNullOrWhiteSpace($ExistingToken)) {
    return [PSCustomObject]@{
      Token = $ExistingToken
      Source = "existing"
      Changed = $false
    }
  }

  return [PSCustomObject]@{
    Token = $null
    Source = "disabled"
    Changed = $false
  }
}
