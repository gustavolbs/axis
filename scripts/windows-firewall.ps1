function Install-LocalCoderNodeRuntime {
  param([Parameter(Mandatory = $true)][string]$NodePath)

  if (-not (Test-Path $NodePath)) {
    throw "Node executable not found at $NodePath."
  }

  $stateRoot = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".local-coder-mcp"
  $runtimeRoot = Join-Path $stateRoot "runtime"
  $runtimeNode = Join-Path $runtimeRoot "node.exe"
  New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null

  if (-not (Test-Path $runtimeNode)) {
    Copy-Item -LiteralPath $NodePath -Destination $runtimeNode -Force
  }

  $version = & $runtimeNode --version
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($version)) {
    throw "Dedicated Local Coder Node runtime at $runtimeNode failed validation."
  }

  return (Resolve-Path $runtimeNode).Path
}

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

function Test-IsWindowsNodePopupBlockRule {
  param([Parameter(Mandatory = $true)]$Rule)

  return (
    $Rule.DisplayName -eq "Node.js JavaScript Runtime" -and
    $Rule.PolicyStoreSourceType.ToString() -eq "Local"
  )
}

function Disable-ConflictingInboundProgramBlockRules {
  param([Parameter(Mandatory = $true)][string]$ExecutablePath)

  $conflicts = @(Get-ConflictingInboundProgramBlockRules -ExecutablePath $ExecutablePath)
  $automatic = @($conflicts | Where-Object { Test-IsWindowsNodePopupBlockRule -Rule $_ })
  $protected = @($conflicts | Where-Object { -not (Test-IsWindowsNodePopupBlockRule -Rule $_) })

  foreach ($rule in $automatic) {
    Write-Warning "Disabling Windows-generated Node firewall Block rule '$($rule.DisplayName)' ($($rule.Name)) for $ExecutablePath. Explicit Block rules override Local Coder Allow rules."
    Disable-NetFirewallRule -Name $rule.Name -ErrorAction Stop
  }

  if ($protected.Count -gt 0) {
    $details = ($protected | ForEach-Object { "'$($_.DisplayName)' [$($_.Name)]" }) -join ", "
    throw "A custom or managed inbound Block rule applies to $ExecutablePath and would override Local Coder: $details. Local Coder will not disable non-default security policy automatically."
  }

  $remaining = @(Get-ConflictingInboundProgramBlockRules -ExecutablePath $ExecutablePath)
  if ($remaining.Count -gt 0) {
    $names = ($remaining | ForEach-Object { $_.DisplayName }) -join ", "
    throw "Conflicting inbound Block rule(s) still apply to $ExecutablePath after remediation: $names"
  }

  return $automatic
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

function Get-TcpListenerProcesses {
  param([Parameter(Mandatory = $true)][int]$Port)

  $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  $seen = @{}
  $processes = @()
  foreach ($listener in $listeners) {
    $processIdValue = [int]$listener.OwningProcess
    if ($seen.ContainsKey($processIdValue)) {
      continue
    }
    $seen[$processIdValue] = $true
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $processIdValue" -ErrorAction SilentlyContinue
    if ($processInfo) {
      $processes += $processInfo
    }
  }
  return $processes
}

function Test-ProcessCommandLineContainsPath {
  param(
    [Parameter(Mandatory = $true)]$Process,
    [Parameter(Mandatory = $true)][string]$ExpectedPath
  )

  $commandLine = [string]$Process.CommandLine
  if ([string]::IsNullOrWhiteSpace($commandLine)) {
    return $false
  }
  return $commandLine.IndexOf($ExpectedPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Stop-LocalCoderListenerForInstall {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$EntryPath
  )

  $listeners = @(Get-TcpListenerProcesses -Port $Port)
  foreach ($processInfo in $listeners) {
    if (-not (Test-ProcessCommandLineContainsPath -Process $processInfo -ExpectedPath $EntryPath)) {
      throw "TCP port $Port is already owned by unrelated process PID $($processInfo.ProcessId): $($processInfo.CommandLine)"
    }
    Write-Warning "Stopping stale Local Coder listener PID $($processInfo.ProcessId) on TCP $Port before reinstall."
    Stop-Process -Id ([int]$processInfo.ProcessId) -Force -ErrorAction Stop
  }

  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (@(Get-TcpListenerProcesses -Port $Port).Count -eq 0) {
      return
    }
    Start-Sleep -Milliseconds 200
  }
  if (@(Get-TcpListenerProcesses -Port $Port).Count -gt 0) {
    throw "TCP port $Port is still occupied after stopping the stale Local Coder listener."
  }
}

function Wait-LocalCoderListener {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$ExecutablePath,
    [Parameter(Mandatory = $true)][string]$EntryPath,
    [int]$TimeoutSeconds = 15
  )

  $expectedExecutable = Resolve-NormalizedProgramPath -Path $ExecutablePath
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    $listeners = @(Get-TcpListenerProcesses -Port $Port)
    if ($listeners.Count -gt 0) {
      $matching = @($listeners | Where-Object {
        Test-ProcessCommandLineContainsPath -Process $_ -ExpectedPath $EntryPath
      })
      if ($matching.Count -eq 0) {
        $owners = ($listeners | ForEach-Object { "PID $($_.ProcessId): $($_.CommandLine)" }) -join "; "
        throw "TCP port $Port was claimed by an unrelated process while Local Coder was starting: $owners"
      }

      foreach ($processInfo in $matching) {
        $actualExecutable = Resolve-NormalizedProgramPath -Path ([string]$processInfo.ExecutablePath)
        if ($actualExecutable -ne $expectedExecutable) {
          throw "Local Coder TCP $Port is listening from unexpected executable '$($processInfo.ExecutablePath)' (PID $($processInfo.ProcessId)); expected '$ExecutablePath'."
        }
      }

      # Windows may create an application Block rule only after the executable first
      # opens a listening socket. Re-run remediation after the real listener exists.
      Disable-ConflictingInboundProgramBlockRules -ExecutablePath $ExecutablePath | Out-Null
      return $matching[0]
    }
    Start-Sleep -Milliseconds 250
  }

  throw "Local Coder did not establish TCP listener $Port within $TimeoutSeconds seconds."
}
