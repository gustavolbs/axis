const REDACTED = '[REDACTED]';

const SECRET_FIELD = /(?:^|[_-])(?:authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|passwd|secret|client[_-]?secret|private[_-]?key|credential|secret[_-]?ref|token)(?:$|[_-])/i;

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/gi,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /\bBasic\s+[A-Za-z0-9+/]+=*/gi,
  /\bsk-ant-[A-Za-z0-9_-]{12,}\b/g,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g,
  /\bgh[opusr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /([a-z][a-z0-9+.-]*:\/\/[^\s:/]+:)[^\s@/]+@/gi,
  /(\b(?:(?:[a-z0-9.-]+[_-])?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|password|passwd|secret|cookie|session[_-]?token|private[_-]?key|client[_-]?secret|secret[_-]?ref)|aws_secret_access_key)\b\s*[:=]\s*)([^\s,;]+)/gi,
  /(--(?:api[_-]?key|token|access-token|password|secret|client-secret)\s+)([^\s]+)/gi,
  /(\b(?:[A-Z0-9]+_)*(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|AUTHORIZATION|PASSWORD|PASSWD|SECRET|COOKIE|SESSION_TOKEN|PRIVATE_KEY|CLIENT_SECRET|AWS_SECRET_ACCESS_KEY)\s*=\s*)([^\s]+)/g
];

export interface RuntimeRedactionOptions {
  readonly knownSecrets?: readonly string[];
  readonly maxChars?: number;
}

export function isRuntimeSecretField(key: string): boolean {
  return SECRET_FIELD.test(key.replace(/([a-z0-9])([A-Z])/g, '$1_$2'));
}

export function redactRuntimeText(value: string, options: RuntimeRedactionOptions = {}): string {
  let output = value;
  for (const secret of options.knownSecrets ?? []) {
    if (secret) output = output.split(secret).join(REDACTED);
  }
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (match, prefix: string | undefined) => {
      if (typeof prefix === 'string' && match.startsWith(prefix)) return `${prefix}${REDACTED}`;
      return REDACTED;
    });
  }
  output = output.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');
  const maxChars = options.maxChars;
  if (maxChars !== undefined && output.length > maxChars) {
    return `${output.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
  }
  return output;
}

function redactObject(
  value: Readonly<Record<string, unknown>>,
  options: RuntimeRedactionOptions,
  seen: WeakSet<object>
): Readonly<Record<string, unknown>> {
  if (seen.has(value)) return { circular: '[CIRCULAR]' };
  seen.add(value);
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, child] of Object.entries(value)) {
    output[key] = isRuntimeSecretField(key)
      ? REDACTED
      : redactRuntimeValue(child, options, seen);
  }
  return output;
}

export function redactRuntimeValue(
  value: unknown,
  options: RuntimeRedactionOptions = {},
  seen = new WeakSet<object>()
): unknown {
  if (typeof value === 'string') return redactRuntimeText(value, options);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactRuntimeText(value.message, options),
      ...(value.stack ? { stack: redactRuntimeText(value.stack, { ...options, maxChars: 4_000 }) } : {})
    };
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return ['[CIRCULAR]'];
    seen.add(value);
    return value.map((item) => redactRuntimeValue(item, options, seen));
  }
  return redactObject(value as Readonly<Record<string, unknown>>, options, seen);
}

export function redactRuntimeRecord(
  value: Readonly<Record<string, unknown>> | undefined,
  options: RuntimeRedactionOptions = {}
): Readonly<Record<string, unknown>> | undefined {
  if (!value) return undefined;
  return redactRuntimeValue(value, options) as Readonly<Record<string, unknown>>;
}

export function redactRuntimeUrlForDisplay(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = url.username ? REDACTED : '';
      url.password = url.password ? REDACTED : '';
    }
    for (const key of [...url.searchParams.keys()]) {
      if (isRuntimeSecretField(key)) url.searchParams.set(key, REDACTED);
    }
    return redactRuntimeText(url.toString());
  } catch {
    return redactRuntimeText(value);
  }
}

export { REDACTED as RUNTIME_REDACTED };
