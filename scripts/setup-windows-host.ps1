param(
  [Parameter(Mandatory = $true)]
  [string]$MacIp,

  [int]$OllamaPort = 11434,

  [string]$Model = "qwen3.6:35b-a3b-coding",

  [string]$FirewallRuleName = "Local Coder - Ollama from Mac"
)

$ErrorActionPreference = "Stop"

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

Write-Host "== local-coder Windows host setup ==" -ForegroundColor Cyan
Write-Host "Mac allowed IP: $MacIp"
Write-Host "Ollama port: $OllamaPort"
Write-Host "Model: $Model"

Assert-Command "ollama"

if (-not (Test-IsAdministrator)) {
  throw "Run PowerShell as Administrator so the script can create the restricted Windows Firewall rule."
}

# Ollama on Windows inherits user/system environment variables. Binding to 0.0.0.0
# is safe here only because the firewall rule below restricts inbound traffic to the
# explicitly supplied Mac IP on Private network profiles.
[Environment]::SetEnvironmentVariable("OLLAMA_HOST", "0.0.0.0:$OllamaPort", "User")
[Environment]::SetEnvironmentVariable("OLLAMA_NUM_PARALLEL", "1", "User")
[Environment]::SetEnvironmentVariable("OLLAMA_MAX_LOADED_MODELS", "1", "User")

$existing = Get-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue
if ($existing) {
  $existing | Remove-NetFirewallRule
}

New-NetFirewallRule `
  -DisplayName $FirewallRuleName `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort $OllamaPort `
  -RemoteAddress $MacIp `
  -Profile Private | Out-Null

Write-Host "Pulling $Model..." -ForegroundColor Cyan
ollama pull $Model
if ($LASTEXITCODE -ne 0) {
  throw "ollama pull failed with exit code $LASTEXITCODE."
}

Write-Host ""
Write-Host "Windows host configuration written successfully." -ForegroundColor Green
Write-Host ""
Write-Host "IMPORTANT: Ollama must be restarted to inherit the new OLLAMA_HOST / scheduling variables." -ForegroundColor Yellow
Write-Host "1. Quit Ollama completely from the Windows system tray."
Write-Host "2. Start Ollama again from the Start menu."
Write-Host "3. Verify locally with:"
Write-Host "   Invoke-RestMethod http://127.0.0.1:$OllamaPort/api/tags"
Write-Host "4. On the Mac verify with:"
Write-Host "   curl http://<WINDOWS_IP>:$OllamaPort/api/tags"
Write-Host ""
Write-Host "Security note: Ollama's local API does not provide application-layer authentication."
Write-Host "Keep the Windows network profile Private and keep this firewall rule restricted to the Mac IP."
Write-Host "Inspect other potentially broad Ollama firewall rules with:"
Write-Host "   Get-NetFirewallRule | Where-Object DisplayName -Match 'Ollama' | Format-Table DisplayName, Enabled, Profile, Direction, Action"
