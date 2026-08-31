import fs from 'node:fs';
import path from 'node:path';

export interface SpawnInvocation {
  command: string;
  args: string[];
}

interface WindowsCliResolutionOptions {
  execPath?: string;
  env?: NodeJS.ProcessEnv;
}

const PACKAGE_CANDIDATES: Record<string, string[]> = {
  npm: ['npm', 'corepack'],
  pnpm: ['pnpm', 'corepack'],
  yarn: ['yarn', 'corepack']
};

const LEGACY_RELATIVE_CANDIDATES: Record<string, string[][]> = {
  npm: [['node_modules', 'npm', 'bin', 'npm-cli.js']],
  pnpm: [
    ['node_modules', 'corepack', 'dist', 'pnpm.js'],
    ['node_modules', 'pnpm', 'bin', 'pnpm.cjs'],
    ['node_modules', 'pnpm', 'bin', 'pnpm.mjs'],
    ['node_modules', 'pnpm', 'bin', 'pnpm.js']
  ],
  yarn: [
    ['node_modules', 'corepack', 'dist', 'yarn.js'],
    ['node_modules', 'yarn', 'bin', 'yarn.js']
  ]
};

function existingJavaScriptCli(candidate: string | undefined): string | undefined {
  if (!candidate) return undefined;
  if (!/\.(?:c|m)?js$/i.test(candidate)) return undefined;
  return fs.existsSync(candidate) ? candidate : undefined;
}

function packageBin(packageJsonPath: string, command: string): string | undefined {
  if (!fs.existsSync(packageJsonPath)) return undefined;

  try {
    const manifest = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      name?: string;
      bin?: string | Record<string, string>;
      publishConfig?: { bin?: string | Record<string, string> };
    };
    const bin = manifest.bin ?? manifest.publishConfig?.bin;
    let relative: string | undefined;

    if (typeof bin === 'string') {
      if (manifest.name === command) relative = bin;
    } else if (bin && typeof bin === 'object') {
      relative = bin[command];
    }

    if (!relative) return undefined;
    return existingJavaScriptCli(path.resolve(path.dirname(packageJsonPath), relative));
  } catch {
    return undefined;
  }
}

function candidateRoots(execPath: string, env: NodeJS.ProcessEnv): string[] {
  const roots: string[] = [path.dirname(execPath)];
  const systemNode = env.LOCAL_CODER_SYSTEM_NODE_PATH?.trim();
  if (systemNode) roots.push(path.dirname(systemNode));
  if (env.PNPM_HOME?.trim()) roots.push(env.PNPM_HOME.trim());
  if (env.npm_config_prefix?.trim()) roots.push(env.npm_config_prefix.trim());
  if (env.APPDATA?.trim()) roots.push(path.join(env.APPDATA.trim(), 'npm'));

  const windowsPath = env.Path ?? env.PATH;
  if (windowsPath) {
    roots.push(
      ...windowsPath
        .split(';')
        .map((entry) => entry.trim().replace(/^"|"$/g, ''))
        .filter(Boolean)
    );
  }

  const seen = new Set<string>();
  return roots.filter((root) => {
    const normalized = path.resolve(root).toLowerCase();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

/**
 * Resolve the JavaScript entrypoint behind npm/pnpm/yarn without invoking cmd.exe.
 *
 * Local Coder intentionally executes from a dedicated copy of node.exe on Windows so
 * generic application firewall rules for the system Node installation cannot block the
 * worker. Package-manager files, however, still live beside the original Node install
 * (Corepack/npm) or in a user-global prefix. Search those roots while continuing to run
 * the discovered JavaScript CLI with the dedicated process.execPath.
 */
export function resolveWindowsNodeCli(
  command: string,
  options: WindowsCliResolutionOptions = {}
): string | undefined {
  const env = options.env ?? process.env;
  const execPath = options.execPath ?? process.execPath;

  if (command === 'npm') {
    const npmExecPath = env.npm_execpath?.trim();
    const npmCli = existingJavaScriptCli(npmExecPath);
    if (npmCli) return npmCli;
  }

  const packages = PACKAGE_CANDIDATES[command];
  const legacy = LEGACY_RELATIVE_CANDIDATES[command];
  if (!packages || !legacy) return undefined;

  for (const root of candidateRoots(execPath, env)) {
    for (const packageName of packages) {
      const fromManifest = packageBin(
        path.join(root, 'node_modules', packageName, 'package.json'),
        command
      );
      if (fromManifest) return fromManifest;
    }

    for (const relative of legacy) {
      const candidate = existingJavaScriptCli(path.join(root, ...relative));
      if (candidate) return candidate;
    }
  }

  return undefined;
}

export function resolveSpawnInvocation(command: string, args: string[]): SpawnInvocation {
  if (process.platform !== 'win32') return { command, args };

  if (command === 'npm' || command === 'pnpm' || command === 'yarn') {
    const cli = resolveWindowsNodeCli(command);
    if (!cli) {
      throw new Error(
        `Cannot resolve the Windows ${command} JavaScript CLI without a shell. ` +
          'Install/enable the package manager for the system Node.js installation and rerun ensure-windows-host.ps1.'
      );
    }
    return {
      command: process.execPath,
      args: [cli, ...args]
    };
  }

  return { command, args };
}
