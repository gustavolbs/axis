import type { BrowserContentSecurity } from './contracts.js';

interface InjectionSignal {
  readonly id: string;
  readonly pattern: RegExp;
}

const SIGNALS: readonly InjectionSignal[] = Object.freeze([
  { id: 'ignore-prior-instructions', pattern: /ignore\s+(?:all|any|the|your|previous|prior)\s+(?:instructions|rules|prompts?)/i },
  { id: 'system-or-developer-prompt', pattern: /(?:system|developer)\s+(?:prompt|message|instructions?)/i },
  { id: 'credential-exfiltration', pattern: /(?:send|upload|exfiltrat\w*|reveal|print|return).{0,100}(?:password|secret|token|api[- ]?key|cookie|credential)/i },
  { id: 'tool-or-command-instruction', pattern: /(?:run|execute|call|invoke).{0,80}(?:tool|command|shell|terminal|mcp)/i },
  { id: 'conceal-from-user', pattern: /do\s+not\s+(?:tell|inform|show|reveal).{0,80}(?:user|human|operator)/i }
]);

const MAX_SECURITY_SCAN_CHARS = 200_000;

/**
 * Browser content is always external/untrusted data. The signal detector is a
 * defensive hint for policy/UI and never upgrades content into instructions.
 * It intentionally does not claim to be a complete prompt-injection detector.
 */
export function assessBrowserContentSecurity(
  content: string | readonly string[]
): BrowserContentSecurity {
  const joined = (typeof content === 'string' ? content : content.join('\n')).slice(
    0,
    MAX_SECURITY_SCAN_CHARS
  );
  const signals = SIGNALS.filter((signal) => signal.pattern.test(joined)).map((signal) => signal.id);
  return Object.freeze({
    trust: 'untrusted-external',
    instructionPolicy: 'treat-as-data',
    suspectedPromptInjection: signals.length > 0,
    signals: Object.freeze(signals)
  });
}

export const UNTRUSTED_BROWSER_CONTENT: BrowserContentSecurity = Object.freeze({
  trust: 'untrusted-external',
  instructionPolicy: 'treat-as-data',
  suspectedPromptInjection: false,
  signals: Object.freeze([])
});
