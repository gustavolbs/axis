# NordVPN Meshnet transport for the Windows worker

This guide configures NordVPN Meshnet as the preferred private transport between the Mac control plane and the Windows local-coder worker.

It is intended to work both:

- at home, even when both machines are on the same physical LAN; and
- while traveling, with the Mac on a hotel, airport, mobile, or other remote network and the Windows workstation left at home.

The Mac and Windows workstation do **not** need to be on the same LAN and they do **not** need to be connected to the same NordVPN VPN server.

Official Meshnet documentation:

- https://support.nordvpn.com/hc/en-us/articles/20278389297041-Guide-for-Meshnet-users
- https://meshnet.nordvpn.com/features/explaining-permissions/remote-access-permissions
- https://meshnet.nordvpn.com/how-to/remote-access
- https://meshnet.nordvpn.com/how-to/remote-access/log-in-to-pc-remotely/connect-to-windows

## Recommended topology

```text
Mac - source of truth / control plane
Claude Desktop or Claude Code
        |
        | stdio
        v
local-coder MCP bridge
        |
        | authenticated HTTP over NordVPN Meshnet
        v
Windows workstation
local-coder worker :7337
        |
        +-- Ollama on 127.0.0.1:11434
        +-- Qwen
        +-- repository mirrors
        +-- disposable worktrees
        +-- investigation / planning
        +-- implementation / repair
        +-- lint / test / typecheck / build
```

Do not expose Ollama directly to Meshnet or the public internet. Only the authenticated local-coder worker needs remote reachability.

Do not configure router/NAT port forwarding for port `7337` or `11434`.

## Why Meshnet instead of the normal NordVPN tunnel

A normal NordVPN server connection is not the mechanism used to connect the Mac directly to the Windows workstation.

Meshnet creates the private device-to-device network. NordVPN documents Meshnet remote access as working between linked devices from the same local network or from outside it.

For local-coder this means the Mac can keep the same worker address while moving between home Wi-Fi, hotel Wi-Fi, mobile tethering, or another location.

## 1. Enable Meshnet on both machines

Install/update the NordVPN desktop application on both Windows and macOS and sign in.

On **Windows**:

1. Open NordVPN.
2. Open **Meshnet / Devices in Meshnet**.
3. Enable Meshnet.
4. Confirm the Mac appears as a linked/online device.

On **macOS**:

1. Open NordVPN.
2. Open **Meshnet**.
3. Enable Meshnet.
4. Confirm the Windows workstation appears as a linked/online device.

When both machines belong to the same Nord account they should appear as your own devices. If the devices use different Nord accounts, link/invite the other device through Meshnet first.

## 2. Keep only the Meshnet permissions local-coder needs

For the Windows peer, the Mac needs **Remote access** permission.

NordVPN documents Remote access as the permission that allows one Meshnet peer to initiate connections to another peer using its Meshnet IP or Nord name, including when the peers are outside the same local network.

For local-coder you do **not** need to enable these additional permissions merely to reach the worker:

- traffic routing;
- access to the peer's local LAN;
- Meshnet file sharing.

Keep them disabled unless you intentionally need them for another purpose.

In NordVPN, open the peer's Meshnet device settings and verify **Remote access** is enabled in the direction `Mac -> Windows`.

## 3. Record the Meshnet identities

In the NordVPN Meshnet device list, record:

```text
MAC_MESHNET_IP=<Mac Meshnet IP>
WINDOWS_MESHNET_IP=<Windows Meshnet IP>
WINDOWS_NORD_NAME=<Windows Nord name>
```

NordVPN supports connecting to a peer using either its **Nord name** or its **Meshnet IP**.

Use the Mac **Meshnet IP** for the Windows Firewall source restriction. Do not use the Mac Nord name for `-MacIp`, because Windows Firewall's `RemoteAddress` field expects an address.

For the Mac local-coder client, prefer the Windows **Nord name** when it resolves correctly; otherwise use the Windows Meshnet IP.

## 4. Configure the Windows worker for the Mac Meshnet IP

Open **PowerShell as Administrator** in the Windows `local-coder-mcp` repository.

Use the Mac Meshnet IP as the `-MacIp` value:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows-host.ps1 `
  -MacIp <MAC_MESHNET_IP> `
  -Mode Worker `
  -StartWorker
```

Example shape only:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows-host.ps1 `
  -MacIp 100.x.y.z `
  -Mode Worker `
  -StartWorker
```

Do not copy the example address. Use the Meshnet IP shown by NordVPN for your Mac.

The setup keeps Ollama at:

```text
127.0.0.1:11434
```

and exposes the authenticated worker on:

```text
:7337
```

with a firewall rule restricted to the supplied Mac address.

Copy the generated worker bearer token once. Do not commit it or store it in repository files.

## 5. Verify the Windows Firewall rule

Inspect the source-address restriction:

```powershell
Get-NetFirewallRule -DisplayName "Local Coder - Worker from Mac" |
  Get-NetFirewallAddressFilter
```

`RemoteAddress` should contain the Mac Meshnet IP.

Inspect the port and action:

```powershell
Get-NetFirewallRule -DisplayName "Local Coder - Worker from Mac" |
  Format-Table DisplayName, Enabled, Profile, Direction, Action

Get-NetFirewallRule -DisplayName "Local Coder - Worker from Mac" |
  Get-NetFirewallPortFilter
```

The inbound port should be `7337`.

### If Meshnet traffic is blocked by the firewall profile

The setup script creates the rule for the Windows `Private` profile. Depending on the local Windows/NordVPN adapter classification, Meshnet traffic may not match that profile.

First test the connection from the Mac. Only if the source-address filter is correct but the connection is still blocked because of the profile, broaden **only the profile**, while keeping the exact Mac Meshnet IP restriction:

```powershell
Set-NetFirewallRule `
  -DisplayName "Local Coder - Worker from Mac" `
  -Profile Any
```

Then verify again:

```powershell
Get-NetFirewallRule -DisplayName "Local Coder - Worker from Mac" |
  Format-Table DisplayName, Enabled, Profile, Direction, Action

Get-NetFirewallRule -DisplayName "Local Coder - Worker from Mac" |
  Get-NetFirewallAddressFilter
```

The important security boundary is that `RemoteAddress` remains the exact Mac Meshnet IP. The worker also independently requires its high-entropy bearer token.

Do not replace `RemoteAddress` with `Any` merely to make troubleshooting easier.

## 6. Verify the worker locally on Windows

```powershell
$TOKEN = "YOUR_WORKER_TOKEN"

Invoke-RestMethod `
  -Headers @{ Authorization = "Bearer $TOKEN" } `
  http://127.0.0.1:7337/v1/health
```

This must work before testing Meshnet.

## 7. Verify Mac -> Windows over Meshnet

On the Mac, with Meshnet enabled, test using the Windows Nord name first:

```bash
TOKEN='YOUR_WORKER_TOKEN'

curl \
  -H "Authorization: Bearer $TOKEN" \
  "http://<WINDOWS_NORD_NAME>:7337/v1/health"
```

If Nord-name resolution does not work on the current machine, use the Windows Meshnet IP:

```bash
curl \
  -H "Authorization: Bearer $TOKEN" \
  "http://<WINDOWS_MESHNET_IP>:7337/v1/health"
```

A request without the token should not succeed:

```bash
curl -i "http://<WINDOWS_NORD_NAME>:7337/v1/health"
```

The expected worker response is HTTP `401` without the bearer token.

Do not continue with Claude configuration until authenticated `/v1/health` succeeds through Meshnet.

## 8. Configure Claude's local-coder bridge

On the Mac:

```bash
cd ~/WORK/local-coder-mcp
npm run build

npm run install:claude:worker -- \
  --host <WINDOWS_NORD_NAME> \
  --token "$TOKEN"
```

If the Nord name is not resolving reliably, use the Meshnet IP instead:

```bash
npm run install:claude:worker -- \
  --host <WINDOWS_MESHNET_IP> \
  --token "$TOKEN"
```

The Mac still runs only the thin stdio MCP bridge. Qwen inference, disposable worktrees, implementation, tests, and builds run on Windows.

Fully quit and reopen Claude Desktop / Claude Code after changing the MCP configuration.

Ask Claude:

```text
Check local_coder_health and report the execution mode, worker hostname, model, queue status, and whether local Mac fallback is enabled.
```

Expected characteristics:

```text
executionMode: remote
worker.ok: true
localFallbackEnabled: false
```

Strict remote mode is intentional. If the Windows worker is unavailable, local-coder must return the failure to Claude instead of silently loading the large model on the Mac.

## 9. Configure unattended operation before traveling

The Windows workstation must remain able to execute while nobody is physically at home.

### Start the worker automatically

After setup/build succeeds:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows-worker-task.ps1
Start-ScheduledTask -TaskName "Local Coder Remote Worker"
```

### Start NordVPN with Windows

In the NordVPN Windows application, enable launch/startup behavior so Meshnet becomes available after Windows starts.

Before leaving home, reboot the Windows workstation once and verify that:

```text
Windows booted
NordVPN is running
Meshnet shows the Mac/peer configuration
Ollama is running
local-coder scheduled worker is running
port 7337 is listening
```

Verify worker listener:

```powershell
Get-NetTCPConnection -LocalPort 7337 -State Listen
```

Verify Ollama locally:

```powershell
Invoke-RestMethod http://127.0.0.1:11434/api/tags
```

### Prevent sleep/hibernate while remote execution is required

The display may turn off. The PC itself must remain awake and network-reachable.

Inspect the active power plan:

```powershell
powercfg /getactivescheme
```

For a workstation that should remain awake while connected to AC power:

```powershell
powercfg /change standby-timeout-ac 0
```

Choose a different policy if permanent wake-on-AC is not desired.

## 10. Travel workflow

Nothing in the Claude/local-coder configuration needs to change merely because the Mac leaves the home LAN.

Example:

```text
Windows workstation at home
        |
        | Internet
        v
NordVPN Meshnet
        ^
        | Internet
        |
Mac on hotel Wi-Fi / mobile hotspot / another city
        |
        v
Claude -> local-coder -> Windows worker
```

Travel checklist:

1. Windows is powered on and not sleeping/hibernating.
2. Windows has internet access.
3. NordVPN is running and Meshnet is enabled.
4. Ollama is running on Windows.
5. The local-coder worker is running.
6. Mac has internet access and Meshnet is enabled.
7. The Windows peer is shown as online from the Mac.
8. `curl .../v1/health` works from the Mac before debugging Claude/MCP itself.

No router port forwarding, public IP, dynamic-DNS service, or shared physical LAN is required for this design.

## 11. Normal NordVPN VPN connection and Meshnet

The local-coder worker connection should target the Meshnet peer identity, not a NordVPN public VPN server address.

You do not need to route the Mac's general internet traffic through the Windows workstation. Meshnet traffic routing is a separate permission and can remain disabled for local-coder.

### Post-quantum encryption caveat

NordVPN currently documents its post-quantum VPN option as incompatible with Meshnet. If the app refuses to enable Meshnet while post-quantum encryption is active, disable the post-quantum option on the affected device while using Meshnet.

Official NordVPN compatibility reference:

https://support.nordvpn.com/hc/en-us/articles/30046321712529-NordVPN-Post-quantum-encryption-explained

This restriction concerns NordVPN's additional post-quantum VPN feature; Meshnet itself remains the encrypted private device network used for this architecture.

## 12. Security checklist

Keep all of these true:

```text
[ ] Ollama listens only on Windows loopback
[ ] worker token is high entropy and not committed
[ ] firewall RemoteAddress is the Mac Meshnet IP
[ ] worker port is not forwarded on the home router
[ ] Ollama port is not forwarded on the home router
[ ] only required Meshnet Remote access permission is enabled
[ ] strict remote mode is configured on the Mac
[ ] worker failure never causes silent Qwen fallback on the Mac
```

The worker currently uses HTTP at the application layer. That is acceptable here only because the connection is carried over the private encrypted Meshnet path and the worker still authenticates every request with the bearer token. Do not expose the same HTTP listener directly to an untrusted/public network.

## 13. Troubleshooting

### Windows peer appears offline in Meshnet

Check:

- Windows is awake;
- NordVPN is running;
- Meshnet is enabled on both devices;
- internet access works on both devices;
- the peer is still linked/authorized.

Restart NordVPN before changing local-coder configuration.

### Mac sees Windows in Meshnet but port 7337 does not connect

On Windows:

```powershell
Get-NetTCPConnection -LocalPort 7337 -State Listen
Get-NetFirewallRule -DisplayName "Local Coder - Worker from Mac" |
  Get-NetFirewallAddressFilter
```

Confirm the rule contains the **current Mac Meshnet IP**, not the Mac's home-LAN `192.168.x.x` address.

If the address is correct, inspect the firewall profile and use the guarded `-Profile Any` procedure above only if necessary.

### Windows Nord name does not resolve

Use the Windows Meshnet IP in the Mac installer instead:

```bash
npm run install:claude:worker -- \
  --host <WINDOWS_MESHNET_IP> \
  --token "$TOKEN"
```

### HTTP 401

Meshnet connectivity is working, but the bearer token does not match.

Repair the token configuration rather than changing firewall rules.

### Works at home but not while traveling

Test in this order:

```text
Meshnet peer online?
  -> no: NordVPN/Meshnet/network issue

worker health over Meshnet curl?
  -> no: Windows worker/firewall issue

local_coder_health?
  -> no: Mac MCP/worker URL/token issue

local_engineer?
  -> no: repository/Ollama/execution issue
```

Do not switch the worker URL back to a home-LAN `192.168.x.x` address; that defeats the travel-safe configuration.
