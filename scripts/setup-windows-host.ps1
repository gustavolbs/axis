param(
  [Parameter(Mandatory = $true)]
  [string]$MacIp,

  [ValidateSet("Worker", "OllamaOnly")]
  [string]$Mode = "Worker",

  [int]$OllamaPort = 11434,

  [int]$WorkerPort = 7337,

  [string]$Model = "qwen3.8:27b",

  [string]$WorkerToken = "",

  [switch]$RotateWorkerToken,

  [string]$AllowedGitHosts = "github.com",

  [ValidateSet("none", "auto")]
  [string]$Bootstrap = "auto",

  [ValidateRange(1, 8)]
  [int]$MaxConcurrentJobs = 1,

  [switch]$DisableRepoIntelligence,

  [switch]$StartWorker
)

$ErrorActionPreference = "Stop"
$WorkerFirewallRule = "Local Coder - Worker from Mac"
$OllamaFirewallRule = "Local Coder - Ollama from Mac"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$WorkerEntry = Join-Path $RepoRoot "dist\worker-server.js"
$FirewallHelpers = Join-Path $PSScriptRoot "windows-firewall.ps1"
$AuthHelpers = Join-Path $PSScriptRoot "windows-auth.ps1"
. $FirewallHelpers
. $AuthHelpers

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

function Remove-UserEnvironmentVariable {
  param([string]$Name)
  [Environment]::SetEnvironmentVariable($Name, $null, "User")
  Remove-Item -Path "Env:$Name" -ErrorAction SilentlyContinue
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
  Write-Host "Configure the Local Coder app to use http://<WINDOWS_IP>:$OllamaPort as the Ollama endpoint."
  return
}

Assert-Command "node"
Assert-Command "npm"
Assert-Command "git"
$node = Get-Command node -ErrorAction Stop
$localCoderNode = Install-LocalCoderNodeRuntime -NodePath $node.Source

$tokenResolution = Resolve-LocalCoderWorkerToken `
  -RequestedToken $WorkerToken `
  -Rotate:$RotateWorkerToken
$WorkerToken = $tokenResolution.Token

switch ($tokenResolution.Source) {
  "existing" { Write-Host "Worker authentication: preserving existing bearer token." -ForegroundColor Cyan }
  "explicit" { Write-Host "Worker authentication: using explicitly supplied bearer token." -ForegroundColor Cyan }
  "rotated" { Write-Host "Worker authentication token: ROTATED explicitly." -ForegroundColor Yellow }
  "disabled" { Write-Host "Worker authentication: disabled because no token was configured." -ForegroundColor Yellow }
}

# In full worker mode Ollama stays loopback-only. Only the Local Coder worker is
# exposed to the Mac. The firewall remains restricted to the supplied Mac IP even
# when bearer authentication is intentionally disabled.
Set-UserEnvironmentVariable "OLLAMA_HOST" "127.0.0.1:$OllamaPort"
Set-UserEnvironmentVariable "LOCAL_CODER_WORKER_HOST" "0.0.0.0"
Set-UserEnvironmentVariable "LOCAL_CODER_WORKER_PORT" "$WorkerPort"
if ($tokenResolution.Source -eq "disabled") {
  Remove-UserEnvironmentVariable "LOCAL_CODER_WORKER_TOKEN"
} else {
  Set-UserEnvironmentVariable "LOCAL_CODER_WORKER_TOKEN" $WorkerToken
}
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
# Qwen3.8 advertises a much larger context, but 16K is deliberate on the RTX 3060 12 GB
# worker: focused repo-intelligence/evidence capsules are cheaper and leave RAM for builds.
Set-UserEnvironmentVariable "LOCAL_CODER_NUM_CTX" "16384"
Set-UserEnvironmentVariable "LOCAL_CODER_MAX_CONTEXT_BYTES" "96000"
# Short Ollama control calls retain the legacy timeout. Long model inference uses
# separate liveness-aware streaming limits so active reasoning is not killed at 10m.
Set-UserEnvironmentVariable "LOCAL_CODER_TIMEOUT_MS" "600000"
Set-UserEnvironmentVariable "LOCAL_CODER_INFERENCE_HEADER_TIMEOUT_MS" "180000"
Set-UserEnvironmentVariable "LOCAL_CODER_INFERENCE_FIRST_CHUNK_TIMEOUT_MS" "600000"
Set-UserEnvironmentVariable "LOCAL_CODER_INFERENCE_IDLE_TIMEOUT_MS" "300000"
Set-UserEnvironmentVariable "LOCAL_CODER_INFERENCE_MAX_DURATION_MS" "1800000"
Set-UserEnvironmentVariable "LOCAL_CODER_VALIDATION_TIMEOUT_MS" "600000"
Set-UserEnvironmentVariable "LOCAL_CODER_REPO_INTELLIGENCE_ENABLED" $(if ($DisableRepoIntelligence) { "false" } else { "true" })

# If Windows ever creates a generic inbound Block for the dedicated runtime, repair
# only the standard local popup-generated rule. Custom/managed security policy is
# never silently disabled and instead fails setup with an explicit error.
Set-LocalCoderInboundFirewallRule `
  -DisplayName $WorkerFirewallRule `
  -ExecutablePath $localCoderNode `
  -Port $WorkerPort `
  -RemoteAddress $MacIp `
  -Profile Any

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
Write-Host "Worker URL: http://<WINDOWS_IP_OR_MESHNET_NAME>:$WorkerPort"
Write-Host "Model: $Model"
Write-Host "Context: 16384 (focused default; do not raise just because the model supports more)"
Write-Host "Inference timeouts: headers 3m; first chunk 10m; stream idle 5m; hard cap 30m"
Write-Host "Allowed Git hosts: $AllowedGitHosts"
Write-Host "Bootstrap mode: $Bootstrap"
Write-Host "Heavy job concurrency: $MaxConcurrentJobs"
Write-Host "Persistent repo intelligence: $(if ($DisableRepoIntelligence) { 'disabled' } else { 'enabled' })"
Write-Host "Dedicated Node runtime: $localCoderNode"
Write-Host "Worker authentication: $(if ($tokenResolution.Source -eq 'disabled') { 'disabled' } else { 'bearer token enabled' })"
if (-not $DisableRepoIntelligence) {
  Write-Host "Repo intelligence is stored outside target repositories under the worker state directory." -ForegroundColor Cyan
}
if ($MaxConcurrentJobs -eq 1) {
  Write-Host "Multiple app sessions may submit jobs, but heavy jobs execute sequentially to protect GPU/RAM." -ForegroundColor Cyan
} else {
  Write-Host "Different checkout/worktree jobs may overlap; same-checkout jobs and Ollama inference remain serialized." -ForegroundColor Yellow
}
Write-Host ""
if ($tokenResolution.Source -eq "rotated") {
  Write-Host "WORKER TOKEN - copy this once to the Mac settings if you want bearer auth enabled:" -ForegroundColor Yellow
  Write-Host $WorkerToken -ForegroundColor Yellow
  Write-Host ""
} elseif ($tokenResolution.Source -eq "disabled") {
  Write-Host "No worker token is required. The Windows firewall still restricts access to the supplied Mac IP." -ForegroundColor Cyan
  Write-Host ""
} else {
  Write-Host "Worker token was preserved/configured and is not printed during routine setup." -ForegroundColor Cyan
  Write-Host ""
}
Write-Host "Ollama remains loopback-only in Worker mode; port $OllamaPort is not opened to the LAN."
Write-Host "The worker port $WorkerPort accepts only the supplied Mac IP and the dedicated Local Coder Node executable on any Windows network profile."
Write-Host "System-wide Node firewall rules cannot affect the dedicated Local Coder runtime."
Write-Host ""
Write-Host "If Ollama was previously configured for LAN access, quit it from the system tray and restart it now."
Write-Host ""

if ($StartWorker) {
  Write-Host "Starting worker in a separate PowerShell window..." -ForegroundColor Cyan
  $escapedRoot = $RepoRoot.Replace("'", "''")
  $escapedNode = $localCoderNode.Replace("'", "''")
  $escapedWorkerEntry = $WorkerEntry.Replace("'", "''")
  Start-Process powershell -ArgumentList @(
    "-NoExit",
    "-Command",
    "Set-Location '$escapedRoot'; & '$escapedNode' '$escapedWorkerEntry'"
  )
} else {
  Write-Host "Start the worker with the dedicated Local Coder runtime:" -ForegroundColor Cyan
  Write-Host "  & '$localCoderNode' '$WorkerEntry'"
}

Write-Host ""
Write-Host "Then configure the standalone Mac app with:" -ForegroundColor Cyan
Write-Host "  Worker URL: http://<WINDOWS_IP_OR_MESHNET_NAME>:$WorkerPort"
if ($tokenResolution.Source -eq "disabled") {
  Write-Host "  Worker token: leave empty"
} else {
  Write-Host "  Worker token: use the configured token"
}
Write-Host ""
Write-Host "Do not port-forward $WorkerPort or $OllamaPort on your router."
