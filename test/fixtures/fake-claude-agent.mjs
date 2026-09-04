const args = process.argv.slice(2);

const valueAfter = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const prompt = valueAfter('-p') ?? '';
const selectedModel = valueAfter('--model') ?? '';
const toolsValue = valueAfter('--tools');
const disallowed = valueAfter('--disallowedTools');
const hasIsolation = args.includes('--safe-mode') && args.includes('--strict-mcp-config')
  && toolsValue === '' && disallowed === 'mcp__*';

if (!hasIsolation) {
  process.stderr.write('unsafe Claude agent invocation: provider-managed tools were not fully disabled');
  process.exit(9);
}
if (!args.includes('--no-session-persistence') || valueAfter('--permission-mode') !== 'dontAsk') {
  process.stderr.write('unsafe Claude agent invocation: persistence or permission mode mismatch');
  process.exit(10);
}
if (!valueAfter('--json-schema')) {
  process.stderr.write('missing Axis structured schema');
  process.exit(11);
}
if (prompt.includes('SCENARIO_CANCEL')) {
  setInterval(() => {}, 1_000);
} else if (prompt.includes('SCENARIO_PROVIDER_ERROR')) {
  process.stderr.write('fixture provider failure');
  process.exit(7);
} else {
  const hasToolResult = prompt.includes('"role":"tool"');
  const structured = prompt.includes('SCENARIO_HIDDEN_TOOL')
    ? { complete: false, toolCalls: [{ id: 'hidden-1', name: 'provider.hidden', arguments: {} }] }
    : hasToolResult
      ? { complete: true, text: 'claude:done', reasoningSummary: 'Used the Axis tool result.', toolCalls: [] }
      : { complete: false, toolCalls: [{ id: 'claude-probe', name: 'probe_context', arguments: { provider: 'anthropic' } }] };
  const canonicalModel = prompt.includes('SCENARIO_WRONG_MODEL')
    ? 'claude-opus-5'
    : selectedModel === 'sonnet'
      ? 'claude-sonnet-5'
      : selectedModel;
  process.stdout.write(JSON.stringify({
    type: 'result',
    session_id: 'fixture-claude-session',
    structured_output: structured,
    modelUsage: {
      [canonicalModel || 'claude-sonnet-5']: {
        canonicalModel: canonicalModel || 'claude-sonnet-5',
        costUSD: 0.01
      }
    }
  }));
}
