# Global Claude routing policy

`local-coder-mcp` can install a user-level Claude Code rule that tells Claude when to delegate bounded implementation work to the local executor.

Install it after the MCP itself is working:

```bash
npm run install:routing
```

The installer copies `config/claude-local-coder-rule.md` to:

```text
~/.claude/rules/local-coder.md
```

If that target already exists, a timestamped backup is created first.

User-level rules are loaded across all Claude Code projects. Project rules are loaded later and therefore can override the global delegation policy when a repository needs stricter behavior.

After installation, fully quit and reopen Claude Code Desktop. In a Code session, run `/context` and confirm `~/.claude/rules/local-coder.md` appears under loaded memory/rule files.

The policy intentionally keeps architecture, ambiguity resolution, risky debugging, security-sensitive work, destructive migrations, production infrastructure, and broad cross-cutting changes in Claude. It delegates only after the approach and file scope are understood.
