import { redactRuntimeText } from '../runtime-security/redaction.js';

export function redactProjectMemoryText(value: string, maxChars = 2_000): string {
  return redactRuntimeText(value, { maxChars }).trim();
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
