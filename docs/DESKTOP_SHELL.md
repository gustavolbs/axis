# macOS desktop application

## Decision

Local Coder is shipped as a standalone Electron application.

Electron is the product host because the engineering runtime, Project stores, Keychain integration, provider adapters and optional Windows-worker client are already Node.js modules. The React renderer remains sandboxed and accesses those capabilities only through a narrow preload bridge.

There is no browser console or localhost control-plane server in the desktop architecture.

## Runtime topology

```text
Local Coder.app
  ├─ Electron main process
  │    ├─ application/window lifecycle
  │    ├─ DesktopAppRuntime in-process
  │    ├─ native folder picker / theme / login-item APIs
  │    └─ provider + worker infrastructure
  │
  ├─ preload.cjs
  │    └─ narrow IPC bridge
  │
  └─ sandboxed React renderer
       └─ Agent | Chats | Projects | Runs | Settings
```

The main process imports `dist/app-runtime.js` and creates `DesktopAppRuntime` directly. Renderer requests cross `ipcRenderer.invoke('local-coder:runtime-request', ...)`; runtime events flow back through `local-coder:runtime-event`.

The renderer keeps URL-shaped request paths such as `/api/jobs` only as an internal compatibility vocabulary. `runtime-shim.ts` converts them to IPC calls; no HTTP request is sent and no server is bound.

## Security boundary

The renderer follows Electron's security recommendations:

- `nodeIntegration: false`;
- `contextIsolation: true`;
- renderer sandbox enabled;
- `webSecurity` enabled;
- permissions denied by default;
- new windows denied;
- navigation away from the packaged application denied;
- safe HTTPS links delegated to the system browser;
- restrictive CSP in `app/index.html`;
- secrets remain in Keychain/environment references and are never exposed as raw values by the runtime API;
- filesystem selection uses the native directory dialog exposed through preload rather than Node access in the renderer.

## Native desktop behavior

The Electron host owns desktop-only capabilities:

- macOS traffic-light positioning;
- hidden inset title bar;
- persisted window size/position and minimum dimensions;
- dark boot background to avoid a white flash;
- native application menu and keyboard shortcuts;
- System/Light/Dark integration through `nativeTheme`;
- Finder directory selection;
- Start at Login integration;
- external HTTPS link delegation.

The packaged renderer is loaded from `app-dist/index.html` with `BrowserWindow.loadFile()`.

## Development

Current pinned desktop toolchain:

- Electron `44.1.0`;
- electron-builder `26.15.7`.

Launch the application:

```bash
npm run desktop
```

Build without launching:

```bash
npm run build
```

Unsigned local directory package:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run desktop:dir:mac
```

Unsigned DMG + ZIP:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run desktop:pack:mac
```

Normal CI intentionally uses unsigned packaging. Those artifacts validate packaging portability but are not distribution releases.

## Packaged contents

`electron-builder.yml` includes only the product runtime and assets required by the standalone app:

```text
desktop/**/*
dist/**/*
app-dist/**/*
package.json
```

There is no separate console bundle or standalone server entrypoint.

## Signed and notarized distribution

Distribution uses `electron-builder.release.yml` and the manual **macOS Signed Release** GitHub Actions workflow.

The release command is:

```bash
npm run desktop:release:mac
```

It fails before packaging unless all signing/notarization environment variables are present:

```text
CSC_LINK
CSC_KEY_PASSWORD
APPLE_ID
APPLE_APP_SPECIFIC_PASSWORD
APPLE_TEAM_ID
```

The wrapper does not pass secret values in process arguments; electron-builder receives them through inherited environment variables.

The release workflow builds with Developer ID signing plus Hardened Runtime, requests notarization, then independently verifies:

```text
codesign --verify --deep --strict
Developer ID Application authority
xcrun stapler validate
spctl --assess --type execute
```

The generated DMG is mounted and the packaged `Local Coder.app` is verified again before artifacts are uploaded. SHA-256 checksums are generated for DMG and ZIP artifacts.

## Startup and recovery

Startup is intentionally simple:

1. Electron becomes ready.
2. `DesktopAppRuntime.create()` is imported and initialized in-process.
3. IPC handlers are installed.
4. The application menu is installed.
5. The renderer loads from `app-dist/index.html`.
6. The window becomes visible on `ready-to-show`, with a bounded fallback so startup failures are never silently invisible.

If runtime initialization fails, the app exits with a startup error rather than attaching to or spawning a separate control service.

See [INSTALLATION.md](INSTALLATION.md) and [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md).
