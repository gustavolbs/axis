import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const sourcePath = path.join(projectRoot, 'config', 'claude-local-coder-rule.md');
const rulesDir = path.join(os.homedir(), '.claude', 'rules');
const targetPath = path.join(rulesDir, 'local-coder.md');

if (!fs.existsSync(sourcePath)) {
  console.error(`Missing routing rule template: ${sourcePath}`);
  process.exit(1);
}

fs.mkdirSync(rulesDir, { recursive: true });

if (fs.existsSync(targetPath)) {
  const timestamp = new Date().toISOString().replaceAll(':', '-');
  const backupPath = `${targetPath}.backup-${timestamp}`;
  fs.copyFileSync(targetPath, backupPath);
  console.error(`Backup created: ${backupPath}`);
}

fs.copyFileSync(sourcePath, targetPath);
console.log(`Installed global local-coder routing rule: ${targetPath}`);
console.log('Fully quit and reopen Claude Code Desktop, then run /context to confirm the rule loaded.');
