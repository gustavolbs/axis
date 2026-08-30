let raw = '';
for await (const chunk of process.stdin) raw += chunk;

try {
  const input = JSON.parse(raw);
  const command = String(input?.tool_input?.command ?? '');
  const response = input?.tool_response;

  const noisyValidation = /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|lint|typecheck|check|build)|lint|typecheck|check|build)\b/i.test(command);
  if (!noisyValidation || !response || typeof response !== 'object') {
    process.stdout.write('{}');
    process.exit(0);
  }

  const stdout = typeof response.stdout === 'string' ? response.stdout : '';
  const stderr = typeof response.stderr === 'string' ? response.stderr : '';
  const combinedLength = stdout.length + stderr.length;

  if (combinedLength <= 6_000) {
    process.stdout.write('{}');
    process.exit(0);
  }

  const compact = (value) => {
    if (typeof value !== 'string' || value.length <= 3_000) return value;
    const head = value.slice(0, 1_200);
    const tail = value.slice(-1_600);
    return `${head}\n\n[... successful command output compacted locally: ${value.length - 2_800} chars omitted ...]\n\n${tail}`;
  };

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedToolOutput: {
          ...response,
          stdout: compact(stdout),
          stderr: compact(stderr)
        }
      }
    })
  );
} catch {
  process.stdout.write('{}');
}
