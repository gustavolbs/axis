import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function existingDirectory(candidate) {
  if (!candidate) return undefined;
  try {
    return fs.statSync(candidate).isDirectory() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function childDirectories(root, suffixParts = []) {
  if (!existingDirectory(root)) return [];
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => existingDirectory(path.join(root, entry.name, ...suffixParts)))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function unique(entries) {
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    if (!entry) continue;
    const normalized = path.resolve(entry);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(entry);
  }
  return result;
}

/**
 * Finder/Dock-launched macOS apps receive a minimal system PATH instead of the
 * user's interactive-shell PATH. Axis invokes user-installed CLIs (Claude Code,
 * Codex, package managers, etc.) without a shell, so add the conventional
 * per-user and package-manager locations explicitly.
 *
 * Existing PATH entries stay first. We only append directories that exist, and
 * never execute a login shell or source user dotfiles during app startup.
 */
export function buildDesktopExecutablePath({
  env = process.env,
  home = env.HOME?.trim() || os.homedir(),
  platform = process.platform
} = {}) {
  const current = env.PATH ?? env.Path ?? '';
  if (platform !== 'darwin') return current;

  const existing = current.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
  const candidates = [
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, 'Library', 'pnpm'),
    path.join(home, '.asdf', 'shims'),
    path.join(home, '.local', 'share', 'mise', 'shims'),
    env.PNPM_HOME?.trim(),
    env.npm_config_prefix?.trim() ? path.join(env.npm_config_prefix.trim(), 'bin') : undefined,
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    ...childDirectories(path.join(home, '.nvm', 'versions', 'node'), ['bin']),
    ...childDirectories(path.join(home, '.fnm', 'node-versions'), ['installation', 'bin']),
    ...childDirectories(path.join(home, '.local', 'share', 'fnm', 'node-versions'), ['installation', 'bin'])
  ].map(existingDirectory).filter(Boolean);

  return unique([...existing, ...candidates]).join(path.delimiter);
}

export function installDesktopExecutablePath(env = process.env) {
  const value = buildDesktopExecutablePath({ env });
  if (value) env.PATH = value;
  return value;
}
