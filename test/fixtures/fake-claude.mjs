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
  process.exit(0);
}

if (args[0] === 'mcp' && args[1] === 'list') {
  process.stdout.write(`profile=${configDir}\nclaude.ai Google Calendar: https://calendar.example.test/mcp - ✔ Connected\nclaude.ai GitHub MCP: https://github.example.test/mcp - ✔ Connected\nclaude.ai LN Jira: https://jira.example.test/mcp - ✔ Connected\nclaude.ai Slack: https://slack.example.test/mcp - ✔ Connected\n`);
  process.exit(0);
}

if (args[0] === 'mcp' && ['add', 'remove', 'login'].includes(args[1])) {
  process.stdout.write(`profile=${configDir}\nargs=${JSON.stringify(args)}\n`);
  process.exit(0);
}

const promptIndex = args.indexOf('-p');
if (promptIndex >= 0) {
  const prompt = args[promptIndex + 1] ?? '';
  if (prompt === 'HANG') {
    setInterval(() => {}, 1_000);
  } else if (prompt === 'JSON_THEN_HANG') {
    process.stdout.write('{"ok":true}');
    setInterval(() => {}, 1_000);
  } else if (prompt === 'LEAK') {
    process.stdout.write('sk-ant-oat01-example-leaked-token\n');
    process.stderr.write('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345\n');
    process.exit(0);
  } else if (prompt.includes('Work Hub collector') || prompt.includes('Work Hub synchronization task') || prompt.includes('MCP do Jira') || prompt.includes('MCP do Teams')) {
    if (prompt.includes('calendar events')) {
      process.stdout.write(JSON.stringify({ events: [{ externalId: 'evt-1', system: 'Google Calendar', title: 'Daily', start: '2026-09-02T12:00:00Z', end: '2026-09-02T12:30:00Z', allDay: false, calendar: profileName }] }));
    } else if (prompt.includes('work items/tickets') || prompt.includes('MCP do Jira')) {
      process.stdout.write(JSON.stringify({ tickets: [{ externalId: 'LIV-1', system: 'Jira', key: 'LIV-1', title: 'Implement feature', status: 'Ready for Code Review', priority: 'P3' }] }));
    } else {
      process.stdout.write(JSON.stringify({ messages: [{ externalId: 'msg-1', system: 'Teams', title: 'Review requested', timestamp: '2026-09-02T10:00:00Z', unread: true, requiresAttention: true }] }));
    }
    process.exit(0);
  } else {
    process.stdout.write(`profile=${configDir}\nprompt=${prompt}\nargs=${JSON.stringify(args)}\n`);
    process.exit(0);
  }
} else {
  process.exit(0);
}
