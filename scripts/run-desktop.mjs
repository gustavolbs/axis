import { spawn } from 'node:child_process';
import electronPath from 'electron';

const env = { ...process.env };
// ELECTRON_RUN_AS_NODE is intentionally used only for the control-plane child.
// If it leaks into the parent shell, Electron never initializes its GUI lifecycle.
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const forwarded = process.argv.slice(2);
const args = forwarded.length > 0 ? forwarded : ['.'];
console.log(`[Local Coder desktop] launching Electron GUI: ${electronPath}`);
console.log(`[Local Coder desktop] entry: ${args.join(' ')}`);

const child = spawn(electronPath, args, {
  cwd: process.cwd(),
  env,
  stdio: 'inherit'
});

child.on('error', (error) => {
  console.error('[Local Coder desktop] failed to spawn Electron GUI', error);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[Local Coder desktop] Electron exited via signal ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 0;
});
