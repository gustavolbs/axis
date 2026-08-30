import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const projectRoot = path.resolve(import.meta.dirname, '..');
const serverPath = path.join(projectRoot, 'dist', 'index.js');
const claudeConfigPath = path.join(os.homedir(), '.claude.json');

if (!fs.existsSync(serverPath)) {
  console.error(`Missing ${serverPath}. Run "npm run build" first.`);
  process.exit(1);
}

let config = {};

if (fs.existsSync(claudeConfigPath)) {
  const raw = fs.readFileSync(claudeConfigPath, 'utf8').trim();

  if (raw) {
    try {
      config = JSON.parse(raw);
    } catch (error) {
      console.error(`Could not parse ${claudeConfigPath}. No changes were made.`);
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }

  const timestamp = new Date().toISOString().replaceAll(':', '-');
  const backupPath = `${claudeConfigPath}.local-coder-backup-${timestamp}`;
  fs.copyFileSync(claudeConfigPath, backupPath);
  console.error(`Backup created: ${backupPath}`);
}

config.mcpServers ??= {};
config.mcpServers['local-coder'] = {
  type: 'stdio',
  command: process.execPath,
  args: [serverPath],
  env: {
    OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
    LOCAL_CODER_MODEL: 'qwen2.5-coder:14b',
    LOCAL_CODER_TIMEOUT_MS: '180000'
  }
};

fs.writeFileSync(claudeConfigPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

console.log(`Installed user-scoped MCP server "local-coder" in ${claudeConfigPath}.`);
console.log(`Node: ${process.execPath}`);
console.log(`Server: ${serverPath}`);
console.log('Fully quit and reopen Claude Code Desktop before testing it.');
