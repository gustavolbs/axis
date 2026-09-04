import { createHash } from 'node:crypto';

import type { AgentMessage } from './contracts.js';

export interface AgentContextUsage {
  readonly messageCount: number;
  readonly bytes: number;
  readonly estimatedTokens: number;
}

export interface AgentContextCompaction {
  readonly messages: readonly AgentMessage[];
  readonly before: AgentContextUsage;
  readonly after: AgentContextUsage;
  readonly compacted: boolean;
  readonly removedMessageCount: number;
}

export function measureAgentContext(messages: readonly AgentMessage[]): AgentContextUsage {
  const bytes = Buffer.byteLength(JSON.stringify(messages), 'utf8');
  return { messageCount: messages.length, bytes, estimatedTokens: Math.ceil(bytes / 4) };
}

function protectedMessage(message: AgentMessage): boolean {
  return Boolean(message.decisionRequest || message.decisionResolution || message.error);
}

function summaryLine(message: AgentMessage): string {
  const label = message.toolName ? `${message.role}/${message.toolName}` : message.role;
  const content = message.content.replace(/\s+/g, ' ').trim().slice(0, 240);
  const calls = message.toolCalls?.map((call) => call.name).join(', ');
  return `- ${label}${calls ? ` called ${calls}` : ''}: ${content || '[structured state]'}`;
}

/**
 * Deterministic compaction keeps the current turn, all explicit decisions/errors,
 * and a bounded summary of older messages. The full transcript remains available
 * to durable storage; this projection is what is sent to the provider.
 */
export function compactAgentTranscript(
  messages: readonly AgentMessage[],
  maxBytes: number,
  force = false
): AgentContextCompaction {
  const before = measureAgentContext(messages);
  if (!force && before.bytes <= maxBytes) {
    return { messages, before, after: before, compacted: false, removedMessageCount: 0 };
  }
  let latestUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.role === 'user') { latestUser = index; break; }
  }
  const keep = new Set<number>();
  messages.forEach((message, index) => {
    if (message.role === 'system' || protectedMessage(message) || index >= Math.max(0, latestUser)) keep.add(index);
  });
  const removed = messages.filter((_message, index) => !keep.has(index));
  const digest = createHash('sha256').update(JSON.stringify(removed)).digest('hex').slice(0, 16);
  let lines = removed.map(summaryLine);
  const fixed = messages.filter((_message, index) => keep.has(index));
  let summary: AgentMessage | undefined;
  while (lines.length > 0) {
    summary = {
      id: `context-summary-${digest}`,
      role: 'system',
      content: `Axis compacted ${removed.length} older transcript messages (digest ${digest}).\n${lines.join('\n')}`
    };
    if (measureAgentContext([summary, ...fixed]).bytes <= maxBytes) break;
    lines = lines.slice(Math.ceil(lines.length / 3));
  }
  const compacted = summary ? [summary, ...fixed] : fixed;
  const after = measureAgentContext(compacted);
  return {
    messages: Object.freeze(compacted), before, after, compacted: true,
    removedMessageCount: removed.length
  };
}
