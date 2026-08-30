import fs from 'node:fs';
import path from 'node:path';

export interface SpawnInvocation {
  command: string;
  args: string[];
}

const WINDOWS_NODE_CLI_RELATIVE_PATHS: Record<string, string[]> = {
  npm: ['node_modules', 'npm', 'bin', 'npm-cli.js'],
  pnpm: ['node_modules', 'corepack', 'dist', 'pnpm.js'],
  yarn: ['node_modules', 'corepack', 'dist', 'yarn.js']
};

function windowsNodeCli(command: string): string | undefined {
  if (command === 'npm') {
    const npmExecPath = process.env.npm_execpath?.trim();
    if (npmExecPath && /npm-cli\.js$/i.test(npmExecPath) && fs.existsSync(npmExecPath)) {
      return npmExecPath;
    }
  }

  const relative = WINDOWS_NODE_CLI_RELATIVE_PATHS[command];
  if (!relative) return undefined;

  const candidate = path.join(path.dirname(process.execPath), ...relative);
  return fs.existsSync(candidate) ? candidate : undefined;
}

export function resolveSpawnInvocation(command: string, args: string[]): SpawnInvocation {
  if (process.platform !== 'win32') return { command, args };

  if (command === 'npm' || command === 'pnpm' || command === 'yarn') {
    const cli = windowsNodeCli(command);
    if (!cli) {
      throw new Error(
        `Cannot resolve the Windows ${command} JavaScript CLI without a shell. ` +
          'Install the package manager through the active Node.js installation or enable Corepack.'
      );
    }
    return {
      command: process.execPath,
      args: [cli, ...args]
    };
  }

  return { command, args };
}
