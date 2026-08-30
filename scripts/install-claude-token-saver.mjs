import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = os.homedir();
const claudeDir = path.join(home, '.claude');
const settingsPath = path.join(claudeDir, 'settings.json');
const localCoderDir = path.join(home, '.local-coder-mcp');
const hooksDir = path.join(localCoderDir, 'hooks');
const sourceHook = path.resolve(import.meta.dirname, 'compact-claude-bash-output.mjs');
const targetHook = path.join(hooksDir, 'compact-claude-bash-output.mjs');

fs.mkdirSync(claudeDir, { recursive: true });
fs.mkdirSync(hooksDir, { recursive: true });

if (fs.existsSync(settingsPath)) {
  const timestamp = new Date().toISOString().replaceAll(':', '-');
  const backupPath = `${settingsPath}.backup-${timestamp}`;
  fs.copyFileSync(settingsPath, backupPath);
  console.error(`Backup created: ${backupPath}`);
}

let settings = {};
if (fs.existsSync(settingsPath)) {
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (error) {
    console.error(`Cannot parse ${settingsPath}: ${error.message}`);
    process.exit(1);
  }
}

fs.copyFileSync(sourceHook, targetHook);

settings.env = {
  ...(settings.env ?? {}),
  ENABLE_TOOL_SEARCH: 'true',
  MAX_MCP_OUTPUT_TOKENS: '8000'
};

const postToolUse = Array.isArray(settings.hooks?.PostToolUse) ? settings.hooks.PostToolUse : [];
const hookCommand = `${process.execPath} ${targetHook}`;
const withoutExistingLocalCompactor = postToolUse.filter((entry) => {
  if (entry?.matcher !== 'Bash' || !Array.isArray(entry?.hooks)) return true;
  return !entry.hooks.some((hook) => hook?.command === hookCommand || String(hook?.command ?? '').includes('compact-claude-bash-output.mjs'));
});

settings.hooks = {
  ...(settings.hooks ?? {}),
  PostToolUse: [
    ...withoutExistingLocalCompactor,
    {
      matcher: 'Bash',
      hooks: [
        {
          type: 'command',
          command: hookCommand,
          timeout: 5
        }
      ]
    }
  ]
};

fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');

console.log(`Installed Claude token-saver settings: ${settingsPath}`);
console.log(`Installed successful validation-output compactor: ${targetHook}`);
console.log('Configured ENABLE_TOOL_SEARCH=true and MAX_MCP_OUTPUT_TOKENS=8000.');
console.log('No MAX_THINKING_TOKENS override was set, so Claude reasoning quality is not globally reduced.');
console.log('Fully quit and reopen Claude Code Desktop for environment changes to take effect.');
