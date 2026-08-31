function Resolve-NormalizedProgramPath {
  param([Parameter(Mandatory = $true)][string]$Path)

  if ([string]::IsNullOrWhiteSpace($Path) -or $Path -eq "Any") {
    return $null
  }

  $expanded = [Environment]::ExpandEnvironmentVariables($Path.Trim('"'))
  try {
    return ([System.IO.Path]::GetFullPath($expanded).TrimEnd('\')).ToLowerInvariant()
  } catch {
    return $expanded.TrimEnd('\').ToLowerInvariant()
  }
}

function Get-ConflictingInboundProgramBlockRules {
  param([Parameter(Mandatory = $true)][string]$ExecutablePath)

  $target = Resolve-NormalizedProgramPath -Path $ExecutablePath
  if (-not $target) {
    throw "ExecutablePath must resolve to a concrete program path."
  }

  $matches = @()
  $rules = Get-NetFirewallRule -PolicyStore ActiveStore -ErrorAction Stop |
    Where-Object {
      $_.Enabled.ToString() -eq "True" -and
      $_.Direction.ToString() -eq "Inbound" -and
      $_.Action.ToString() -eq "Block"
    }

  foreach ($rule in $rules) {
    $filters = @($rule | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue)
    foreach ($filter in $filters) {
      $program = Resolve-NormalizedProgramPath -Path ([string]$filter.Program)
      if ($program -and $program -eq $target) {
        $matches += $rule
        break
      }
    }
  }

  return $matches
}

function Disable-ConflictingInboundProgramBlockRules {
  param([Parameter(Mandatory = $true)][string]$ExecutablePath)

  $conflicts = @(Get-ConflictingInboundProgramBlockRules -ExecutablePath $ExecutablePath)
  foreach ($rule in $conflicts) {
    Write-Warning "Disabling conflicting Windows Firewall rule '$($rule.DisplayName)' ($($rule.Name)) for $ExecutablePath. Explicit Block rules override Local Coder Allow rules."
    Disable-NetFirewallRule -Name $rule.Name -ErrorAction Stop
  }

  $remaining = @(Get-ConflictingInboundProgramBlockRules -ExecutablePath $ExecutablePath)
  if ($remaining.Count -gt 0) {
    $names = ($remaining | ForEach-Object { $_.DisplayName }) -join ", "
    throw "Conflicting inbound Block rule(s) still apply to $ExecutablePath: $names"
  }

  return $conflicts
}

function Set-LocalCoderInboundFirewallRule {
  param(
    [Parameter(Mandatory = $true)][string]$DisplayName,
    [Parameter(Mandatory = $true)][string]$ExecutablePath,
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$RemoteAddress,
    [string]$LocalAddress = "Any",
    [ValidateSet("Any", "Private", "Public", "Domain")][string]$Profile = "Any"
  )

  Disable-ConflictingInboundProgramBlockRules -ExecutablePath $ExecutablePath | Out-Null

  $existing = Get-NetFirewallRule -DisplayName $DisplayName -ErrorAction SilentlyContinue
  if ($existing) {
    $existing | Remove-NetFirewallRule
  }

  New-NetFirewallRule `
    -DisplayName $DisplayName `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -Program $ExecutablePath `
    -LocalAddress $LocalAddress `
    -LocalPort $Port `
    -RemoteAddress $RemoteAddress `
    -Profile $Profile | Out-Null

  $activeRule = Get-NetFirewallRule -PolicyStore ActiveStore -DisplayName $DisplayName -ErrorAction Stop
  if ($activeRule.Enabled.ToString() -ne "True" -or $activeRule.Action.ToString() -ne "Allow") {
    throw "Windows Firewall rule '$DisplayName' is not active as an enabled Allow rule."
  }

  $programFilters = @($activeRule | Get-NetFirewallApplicationFilter -ErrorAction Stop)
  $expectedProgram = Resolve-NormalizedProgramPath -Path $ExecutablePath
  $programMatch = $programFilters | Where-Object {
    (Resolve-NormalizedProgramPath -Path ([string]$_.Program)) -eq $expectedProgram
  }
  if (-not $programMatch) {
    throw "Windows Firewall rule '$DisplayName' is not scoped to the expected executable $ExecutablePath."
  }
}
