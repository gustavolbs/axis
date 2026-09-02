#!/usr/bin/env node

import { ClaudeAccountProfileStore, ClaudeAccountRuntime } from '../dist/claude-account-profiles.js';

const store = new ClaudeAccountProfileStore();
const runtime = new ClaudeAccountRuntime(store);
const [command, ...args] = process.argv.slice(2);

function usage() {
  console.log(`Claude account profiles spike\n\nCommands:\n  create <id> <name> [organization]\n  list\n  discover\n  login <id> [--sso]\n  status <id>\n  invoke <id> <prompt> [--allowed-tools <pattern>]\n  mcp-list <id>\n  shell <id>\n\nThe Local Coder stores only profile metadata. Authentication is delegated to the official Claude CLI.`);
}

function required(value, label) {
  if (!value) throw new Error(`Missing ${label}.`);
  return value;
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

try {
  switch (command) {
    case 'create': {
      const [id, name, organizationLabel] = args;
      print(store.create({ id: required(id, 'profile id'), name: required(name, 'profile name'), organizationLabel }));
      break;
    }
    case 'list':
      print(store.list());
      break;
    case 'discover':
      print(await runtime.discover());
      break;
    case 'login': {
      const id = required(args[0], 'profile id');
      const result = await runtime.login(id, { sso: args.includes('--sso') });
      process.exitCode = result.exitCode ?? 1;
      break;
    }
    case 'status':
      print(await runtime.status(required(args[0], 'profile id')));
      break;
    case 'invoke': {
      const id = required(args[0], 'profile id');
      const prompt = required(args[1], 'prompt');
      const allowedIndex = args.indexOf('--allowed-tools');
      const allowedTools = allowedIndex >= 0 && args[allowedIndex + 1]
        ? args[allowedIndex + 1].split(',').map((value) => value.trim()).filter(Boolean)
        : undefined;
      const result = await runtime.invoke(id, prompt, { allowedTools });
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);
      process.exitCode = result.exitCode ?? 1;
      break;
    }
    case 'mcp-list': {
      const result = await runtime.listMcp(required(args[0], 'profile id'));
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);
      process.exitCode = result.exitCode ?? 1;
      break;
    }
    case 'shell': {
      const result = await runtime.openInteractive(required(args[0], 'profile id'));
      process.exitCode = result.exitCode ?? 1;
      break;
    }
    default:
      usage();
      process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
