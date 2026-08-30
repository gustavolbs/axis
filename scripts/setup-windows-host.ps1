param(
  [Parameter(Mandatory = $true)]
  [string]$MacIp,

  [ValidateSet("Worker", "OllamaOnly")]
  [string]$Mode = "Worker",

  [int]$OllamaPort = 11434,

  [int]$WorkerPort = 7337,

  [string]$Model = "qwen3.6:35b-a3b-coding",

  [string]$WorkerToken = "",

  [string]$AllowedGitHosts = "github.com",

  [ValidateSet("none", "auto")]
  [string]$Bootstrap = "auto",

  [ValidateRange(1, 8)]
  [int]$MaxConcurrentJobs = 1,

  [switch]$StartWorker
)

$ErrorActionPreference = "Stop"
$WorkerFirewallRule = "Local Coder - Worker from Mac"
$OllamaFirewallRule = "Local Coder - Ollama from Mac"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

function Assert-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command '$Name' was not found in PATH."
  }
}

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Set-UserEnvironmentVariable {
  param([string]$Name, [string]$Value)
  [Environment]::SetEnvironmentVariable($Name, $Value, "User")
  Set-Item -Path "Env:$Name" -Value $Value
}

function New-WorkerToken {
  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }
  return [Convert]::ToBase64String($bytes)
}

function Replace-FirewallRule {
  param(
    [string]$DisplayName,
    [int]$Port,
    [string]$RemoteAddress
  )

  $existing = Get-NetFirewallRule -DisplayName $DisplayName -ErrorAction SilentlyContinue
  if ($existing) {
    $existing | Remove-NetFirewallRule
  }

  New-NetFirewallRule `
    -DisplayName $DisplayName `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $Port `
    -RemoteAddress $RemoteAddress `
    -Profile Private | Out-Null
}

Write-Host "== local-coder Windows host setup ==" -ForegroundColor Cyan
Write-Host "Mode: $Mode"
Write-Host "Mac allowed IP: $MacIp"
Write-Host "Model: $Model"
Write-Host "Repository: $RepoRoot"

Assert-Command "ollama"
if (-not (Test-IsAdministrator)) {
  throw "Run PowerShell as Administrator so the script can create restricted Windows Firewall rules."
}

Set-UserEnvironmentVariable "OLLAMA_NUM_PARALLEL" "1"
Set-UserEnvironmentVariable "OLLAMA_MAX_LOADED_MODELS" "1"

Write-Host "Pulling $Model..." -ForegroundColor Cyan
ollama pull $Model
if ($LASTEXITCODE -ne 0) {
  throw "ollama pull failed with exit code $LASTEXITCODE."
}

if ($Mode -eq "OllamaOnly") {
  Set-UserEnvironmentVariable "OLLAMA_HOST" "0.0.0.0:$OllamaPort"
  Replace-FirewallRule -DisplayName $OllamaFirewallRule -Port $OllamaPort -RemoteAddress $MacIp

  Write-Host ""
  Write-Host "Ollama-only remote inference configured." -ForegroundColor Green
  Write-Host "Quit Ollama from the system tray and start it again so OLLAMA_HOST takes effect." -ForegroundColor Yellow
  Write-Host "Then test from the Mac: curl http://<WINDOWS_IP>:$OllamaPort/api/tags"
  Write-Host "Configure the Mac with: npm run install:claude:windows -- --host <WINDOWS_IP>"
  return
}

Assert-Command "node"
Assert-Command "npm"
Assert-Command "git"

if (-not $WorkerToken) {
  $WorkerToken = New-WorkerToken
}

# In full worker mode Ollama stays loopback-only. Only the authenticated worker is
# exposed to the LAN, and Windows Firewall further restricts that port to the Mac.
Set-UserEnvironmentVariable "OLLAMA_HOST" "127.0.0.1:$OllamaPort"
Set-UserEnvironmentVariable "LOCAL_CODER_WORKER_HOST" "0.0.0.0"
Set-UserEnvironmentVariable "LOCAL_CODER_WORKER_PORT" "$WorkerPort"
Set-UserEnvironmentVariable "LOCAL_CODER_WORKER_TOKEN" $WorkerToken
Set-UserEnvironmentVariable "LOCAL_CODER_WORKER_ALLOWED_GIT_HOSTS" $AllowedGitHosts
Set-UserEnvironmentVariable "LOCAL_CODER_WORKER_BOOTSTRAP" $Bootstrap
Set-UserEnvironmentVariable "LOCAL_CODER_WORKER_MAX_CONCURRENT_JOBS" "$MaxConcurrentJobs"
Set-UserEnvironmentVariable "LOCAL_CODER_WORKER_MAX_BODY_BYTES" "12000000"
Set-UserEnvironmentVariable "LOCAL_CODER_REMOTE_MAX_DELTA_BYTES" "8000000"
Set-UserEnvironmentVariable "LOCAL_CODER_REMOTE_WORKER_TIMEOUT_MS" "7200000"
Set-UserEnvironmentVariable "LOCAL_CODER_ADAPTIVE_MODELS" "false"
Set-UserEnvironmentVariable "LOCAL_CODER_MODEL" $Model
Set-UserEnvironmentVariable "LOCAL_CODER_FAST_MODEL" $Model
Set-UserEnvironmentVariable "LOCAL_CODER_STRONG_MODEL" $Model
Set-UserEnvironmentVariable "LOCAL_CODER_NUM_CTX" "16384"
Set-UserEnvironmentVariable "LOCAL_CODER_MAX_CONTEXT_BYTES" "96000"
Set-UserEnvironmentVariable "LOCAL_CODER_TIMEOUT_MS" "600000"
Set-UserEnvironmentVariable "LOCAL_CODER_VALIDATION_TIMEOUT_MS" "600000"

Replace-FirewallRule -DisplayName $WorkerFirewallRule -Port $WorkerPort -RemoteAddress $MacIp

$oldOllamaRule = Get-NetFirewallRule -DisplayName $OllamaFirewallRule -ErrorAction SilentlyContinue
if ($oldOllamaRule) {
  $oldOllamaRule | Remove-NetFirewallRule
}

Write-Host "Building local-coder worker..." -ForegroundColor Cyan
Push-Location $RepoRoot
try {
  npm install --no-package-lock
  if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
  npm run check
  if ($LASTEXITCODE -ne 0) { throw "npm run check failed." }
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "npm run build failed." }
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "Windows execution worker configured." -ForegroundColor Green
Write-Host "Worker URL: http://<WINDOWS_IP>:$WorkerPort"
Write-Host "Allowed Git hosts: $AllowedGitHosts"
Write-Host "Bootstrap mode: $Bootstrap"
Write-Host "Heavy job concurrency: $MaxConcurrentJobs"
if ($MaxConcurrentJobs -eq 1) {
  Write-Host "Multiple Claude sessions may submit jobs, but heavy jobs execute sequentially to protect GPU/RAM." -ForegroundColor Cyan
} else {
  Write-Host "Different checkout/worktree jobs may overlap; same-checkout jobs and Ollama inference remain serialized." -ForegroundColor Yellow
}
Write-Host ""
Write-Host "WORKER TOKEN - copy this once to the Mac installer:" -ForegroundColor Yellow
Write-Host $WorkerToken -ForegroundColor Yellow
Write-Host ""
Write-Host "Ollama remains loopback-only in Worker mode; port $OllamaPort is not opened to the LAN."
Write-Host "The worker port $WorkerPort accepts only the supplied Mac IP on Private network profiles."
Write-Host ""
Write-Host "If Ollama was previously configured for LAN access, quit it from the system tray and restart it now."
Write-Host ""

if ($StartWorker) {
  Write-Host "Starting worker in a separate PowerShell window..." -ForegroundColor Cyan
  $escapedRoot = $RepoRoot.Replace("'", "''")
  Start-Process powershell -ArgumentList @(
    "-NoExit",
    "-Command",
    "Set-Location '$escapedRoot'; npm run start:worker"
  )
} else {
  Write-Host "Start the worker from a new PowerShell in this repository:" -ForegroundColor Cyan
  Write-Host "  npm run start:worker"
}

Write-Host ""
Write-Host "Then on the Mac run:" -ForegroundColor Cyan
Write-Host "  npm run install:claude:worker -- --host <WINDOWS_IP> --token '<TOKEN_ABOVE>'"
Write-Host ""
Write-Host "Do not port-forward $WorkerPort or $OllamaPort on your router."
