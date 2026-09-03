const REDACTED = '[REDACTED]';

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/gi,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g,
  /\bgh[opusr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /([a-z][a-z0-9+.-]*:\/\/[^\s:/]+:)[^\s@/]+@/gi,
  /(\b(?:(?:[a-z0-9.-]+[_-])?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|password|passwd|secret|cookie|session[_-]?token|private[_-]?key)|aws_secret_access_key)\b\s*[:=]\s*)([^\s,;]+)/gi,
  /(--(?:api[_-]?key|token|access-token|password|secret)\s+)([^\s]+)/gi,
  /(\b(?:[A-Z0-9]+_)*(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|AUTHORIZATION|PASSWORD|PASSWD|SECRET|COOKIE|SESSION_TOKEN|PRIVATE_KEY|AWS_SECRET_ACCESS_KEY)\s*=\s*)([^\s]+)/g
];

export function redactProjectMemoryText(value: string, maxChars = 2_000): string {
  let output = value;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (match, prefix: string | undefined) => {
      if (typeof prefix === 'string' && match.startsWith(prefix)) return `${prefix}${REDACTED}`;
      return REDACTED;
    });
  }
  output = output.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');
  output = output.trim();
  if (output.length <= maxChars) return output;
  return `${output.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function safeProjectMemoryString(value: unknown, maxChars = 2_000): string | undefined {
  return typeof value === 'string' && value.trim() ? redactProjectMemoryText(value, maxChars) : undefined;
}

export function safeProjectMemoryStringArray(value: unknown, maxItems = 20, maxChars = 500): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .map((item) => redactProjectMemoryText(item, maxChars))
    .filter(Boolean)
    .slice(0, maxItems);
}
