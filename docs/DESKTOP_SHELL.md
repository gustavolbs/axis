# macOS desktop shell

## Decision

Local Coder packages the existing React standalone UI and Node control plane with **Electron**.

This is an architectural choice, not a visual preference. The Agent Runtime, Project stores, Keychain integration, provider adapters, worker client and standalone HTTP API are already Node.js modules. Electron can host the existing UI while starting the same compiled control-plane entrypoint with its embedded Node runtime. A Tauri shell would require introducing a Rust host plus a separately packaged Node sidecar for the same runtime, increasing lifecycle, signing and IPC complexity without removing the Node dependency.

The decision can be revisited if the control plane stops depending on Node. The React UI and Agent Runtime boundaries remain independent of the shell.

## Runtime topology

```text
Local Coder.app
  ├─ Electron main process
  │    ├─ single-instance lifecycle
  │    ├─ starts Local Coder control plane with ELECTRON_RUN_AS_NODE
  │    ├─ attaches to an already-running healthy loopback Console when appropriate
  │    └─ stops the owned control plane on app quit
  │
  └─ sandboxed renderer
       └─ http://127.0.0.1:<console-port>
            └─ existing Agent | Projects | Runs React UI
```

`npm run console` remains supported. The desktop app does not create a second Agent Runtime or duplicate Project state.

## Security boundary

The renderer follows Electron's security recommendations:

- `nodeIntegration: false`;
- `contextIsolation: true`;
- renderer sandbox enabled;
- `webSecurity` remains enabled;
- permissions denied by default;
- new windows denied;
- navigation outside the Local Coder loopback origin denied;
- restrictive CSP on the standalone document;
- Project/provider/credential administration remains server-side and loopback-only;
- secrets remain in Keychain/environment references and are never sent to the renderer by the admin API.

References checked 2026-08-31:

- Electron security checklist: https://www.electronjs.org/docs/latest/tutorial/security
- Electron process sandboxing: https://www.electronjs.org/docs/latest/tutorial/sandbox
- Electron `ELECTRON_RUN_AS_NODE`: https://www.electronjs.org/docs/latest/api/environment-variables
- electron-builder application contents: https://www.electron.build/docs/contents/
- electron-builder macOS packaging: https://www.electron.build/docs/mac/

## Packaging

Current pinned desktop toolchain:

- Electron `44.1.0`;
- electron-builder `26.15.7`.

Development:

```bash
npm run desktop
```

Unsigned local directory package:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run desktop:dir:mac
```

Unsigned DMG + ZIP:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run desktop:pack:mac
```

CI intentionally builds unsigned artifacts. Signing/notarization credentials must be supplied only by a release environment; they are never stored in this repository.

## Startup and recovery

The desktop shell always forces its own standalone server bind to `127.0.0.1` even if a broader `LOCAL_CODER_CONSOLE_HOST` exists in the environment.

At startup it:

1. probes the configured loopback port;
2. attaches if a Local Coder standalone API is already healthy there;
3. otherwise starts the compiled `dist/standalone-console.js` using Electron's Node mode;
4. waits for `/api/jobs` to become ready;
5. presents Retry/Quit if startup fails or the port is occupied by a non-Local-Coder process.

If an owned backend exits while the app is open, the user can restart it without restarting the Electron renderer process.
