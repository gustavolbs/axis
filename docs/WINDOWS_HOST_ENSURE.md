# Windows one-shot install / repair

Use this as the normal Windows entrypoint for Local Coder installation, recovery, and verification.

Open **PowerShell as Administrator** in the `local-coder-mcp` repository and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\ensure-windows-host.ps1 `
  -MacIp 100.127.211.109 `
  -ListenHost 100.67.159.181
```

Replace the addresses only if the NordVPN Meshnet IPs change.

## What the script does

The command is intentionally idempotent. It can be run again whenever worker/dashboard connectivity is suspicious.

It:

1. requires Administrator privileges;
2. validates both IPv4 addresses and required commands;
3. verifies the Windows Meshnet address is actually active;
4. refuses to discard tracked local Git changes;
5. switches to `main` and performs `git pull --ff-only origin main`;
6. relaunches itself once so the repair always runs from the freshly updated scripts;
7. preserves the existing `LOCAL_CODER_WORKER_TOKEN` so the Mac does not lose authentication;
8. runs the canonical Windows host setup;
9. recreates the restricted worker firewall rule;
10. replaces stale Local Coder listeners only when their command lines prove they belong to Local Coder;
11. reinstalls and starts the worker scheduled task;
12. reinstalls and starts the dashboard scheduled task;
13. uses the dedicated Local Coder Node runtime instead of the system-wide `node.exe`;
14. repairs Windows-generated Node firewall Block rules that target the Local Coder runtime, while refusing to override custom/managed security policy;
15. verifies that the real PIDs listening on TCP 7337 and 7447 use the dedicated runtime;
16. verifies scheduled-task executable paths;
17. verifies firewall program, source-address, local-address, and port filters;
18. calls the authenticated worker `/v1/health` endpoint locally;
19. requires dashboard `/` and `/api/status` to return HTTP 200.

The script fails immediately with a concrete error if any invariant is not satisfied. A task merely existing is not considered success.

## Verification only

To inspect the current installation without reinstalling or updating the repository:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\ensure-windows-host.ps1 `
  -MacIp 100.127.211.109 `
  -ListenHost 100.67.159.181 `
  -VerifyOnly
```

## Final Mac-side transport check

The Windows script can prove the Windows side is correctly configured, but it cannot originate a Mac-to-Windows TCP connection. After a repair, the final transport check from the Mac remains:

```bash
nc -vz -G 5 100.67.159.181 7337
nc -vz -G 5 100.67.159.181 7447
curl -m 5 http://100.67.159.181:7447/
```

If the Windows ensure script is green but all three Mac commands time out, investigate NordVPN Meshnet transport rather than changing Local Coder configuration.

## Safety properties

- The script never uses `git reset --hard` or discards tracked work.
- It never disables the Windows Firewall globally.
- It never opens the Local Coder ports to arbitrary remote addresses.
- It never terminates an unrelated process merely because it owns port 7337 or 7447.
- It does not rotate an existing worker bearer token during repair.
- Custom or managed inbound Block rules are reported and left untouched.
