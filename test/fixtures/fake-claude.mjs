import path from 'node:path';

const args = process.argv.slice(2);
const configDir = process.env.CLAUDE_CONFIG_DIR ?? '';
const profileName = configDir ? path.basename(configDir) : 'none';

if (args[0] === '--version') {
  process.stdout.write('2.1.999 (fake)\n');
  process.exit(0);
}

if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(`${JSON.stringify({
    loggedIn: true,
    email: `${profileName}@example.test`,
    authMethod: 'claude.ai',
    organization: profileName,
    oauthToken: 'sk-ant-oat01-status-secret-should-never-surface'
  })}\n`);
  process.exit(configDir ? 0 : 3);
}

if (args[0] === 'auth' && args[1] === 'login') {
  process.exit(args.includes('--sso') ? 0 : 0);
}

if (args[0] === 'mcp' && args[1] === 'list') {
  process.stdout.write(`profile=${configDir}\nmanaged-jira: connected\n`);
  process.exit(0);
}

const promptIndex = args.indexOf('-p');
if (promptIndex >= 0) {
  const prompt = args[promptIndex + 1] ?? '';
  if (prompt === 'HANG') {
    setInterval(() => {}, 1_000);
  } else if (prompt === 'LEAK') {
    process.stdout.write('sk-ant-oat01-example-leaked-token\n');
    process.stderr.write('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345\n');
    process.exit(0);
  } else {
    process.stdout.write(`profile=${configDir}\nprompt=${prompt}\n`);
    process.exit(0);
  }
} else {
  process.exit(0);
}
