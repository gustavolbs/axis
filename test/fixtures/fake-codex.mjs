import path from 'node:path';

const args = process.argv.slice(2);
const configDir = process.env.CODEX_HOME ?? '';
const profileName = configDir ? path.basename(configDir) : 'none';

if (args[0] === '--version') {
  process.stdout.write('codex-cli 0.999.0 (fake)\n');
  process.exit(0);
}

if (args[0] === 'login' && args[1] === 'status') {
  process.stdout.write(configDir ? `Logged in using ChatGPT (${profileName})\n` : 'Not logged in\n');
  process.exit(configDir ? 0 : 1);
}

if (args[0] === 'login') {
  process.exit(0);
}

if (args[0] === 'mcp' && args[1] === 'list') {
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify([
      { name: 'calendar', enabled: true, transport: { type: 'streamable_http', url: 'https://calendar.example.test/mcp' }, auth_status: 'authenticated' },
      { name: 'jira', enabled: true, transport: { type: 'streamable_http', url: 'https://jira.example.test/mcp' }, auth_status: 'authenticated' },
      { name: 'slack', enabled: true, transport: { type: 'streamable_http', url: 'https://slack.example.test/mcp' }, auth_status: 'authenticated' }
    ]));
  } else {
    process.stdout.write(`profile=${configDir}\ncalendar  https://calendar.example.test/mcp  enabled\njira  https://jira.example.test/mcp  enabled\nslack  https://slack.example.test/mcp  enabled\n`);
  }
  process.exit(0);
}

if (args[0] === 'mcp' && ['add', 'remove', 'login'].includes(args[1])) {
  process.stdout.write(`profile=${configDir}\nargs=${JSON.stringify(args)}\n`);
  process.exit(0);
}

const execIndex = args.indexOf('exec');
if (execIndex >= 0) {
  const prompt = args.at(-1) ?? '';
  if (prompt === 'HANG') {
    setInterval(() => {}, 1_000);
  } else if (prompt === 'JSON_THEN_HANG') {
    process.stdout.write('{"ok":true}');
    setInterval(() => {}, 1_000);
  } else if (prompt === 'LEAK') {
    process.stdout.write('sk-proj-example-secret-token-1234567890\n');
    process.stderr.write('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345\n');
    process.exit(0);
  } else if (prompt === 'USAGE_LIMIT') {
    process.stderr.write([
      'Reading additional input from stdin...',
      'OpenAI Codex v0.153.1 -------- workdir: /Users/example/.local-coder/runtime-cwd model: gpt-5.6-sol provider: openai approval: never sandbox: read-only reasoning effort: none session id: fake-session',
      '# SYSTEM INSTRUCTIONS',
      'private prompt material that must not reach the user-facing error',
      "ERROR: You've hit your usage limit. Upgrade to Pro, visit settings to purchase more credits or try again at Sep 7th, 2026 6:00 AM.",
      "ERROR: You've hit your usage limit. Upgrade to Pro, visit settings to purchase more credits or try again at Sep 7th, 2026 6:00 AM."
    ].join('\n'));
    process.exit(1);
  } else if (prompt.includes('Work Hub collector') || prompt.includes('Work Hub synchronization task')) {
    if (prompt.includes('calendar events')) {
      process.stdout.write(JSON.stringify({ events: [{ externalId: 'evt-1', system: 'Outlook', title: 'Planning', start: '2026-09-02T12:00:00Z', end: '2026-09-02T13:00:00Z', allDay: false, calendar: profileName }] }));
    } else if (prompt.includes('work items/tickets')) {
      process.stdout.write(JSON.stringify({ tickets: [{ externalId: 'ABC-1', system: 'Jira', key: 'ABC-1', title: 'Ship feature', status: 'In Progress', priority: 'P2' }] }));
    } else {
      process.stdout.write(JSON.stringify({ messages: [{ externalId: 'msg-1', system: 'Teams', title: 'Please review', timestamp: '2026-09-02T10:00:00Z', unread: true, requiresAttention: true }] }));
    }
    process.exit(0);
  } else {
    process.stdout.write(`profile=${configDir}\nprompt=${prompt}\nargs=${JSON.stringify(args)}\n`);
    process.exit(0);
  }
} else {
  process.exit(0);
}
