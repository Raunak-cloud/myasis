import type { ChatMessage } from './celeris.js';
import { estimateTranscriptTokens, trimTranscript } from './loop/transcript.js';

/** Checkpoint guidance describes the same freshly observed page. It is not a
 * newer browser observation and must not retire that page's screenshot. */
function isCheckpoint(message: ChatMessage): boolean {
  return message.role === 'user' && typeof message.content === 'string'
    && /^(?:RECOVERY CHECKPOINT:|APPLICATION ACCURACY CHECKPOINT:)/.test(message.content);
}

/** Send one current picture while retaining prior text and actions. */
export function latestObservationScreenshotOnly(messages: ChatMessage[]): ChatMessage[] {
  let latest = -1;
  messages.forEach((message, index) => { if (message.role === 'user' && !isCheckpoint(message)) latest = index; });
  let changed = false;
  const next = messages.map((message, index): ChatMessage => {
    if (index <= 1 || index === latest || message.role !== 'user' || typeof message.content === 'string'
      || !message.content.some(part => part.type === 'image_url')) return message;
    changed = true;
    return { ...message, content: message.content.filter(part => part.type === 'text') };
  });
  return changed ? next : messages;
}

/** Old DOM trees are observations, not candidate facts. Keep the current
 * observation/snapshot, authored answers and tool actions. */
export function agentOnlyTranscript(messages: ChatMessage[], maxTokens: number, force = false): ChatMessage[] {
  // Keep the growing prefix byte-for-byte stable for provider prompt caching.
  // Compact in chunks, only when necessary, leaving room for subsequent turns.
  if (!force && estimateTranscriptTokens(messages) <= maxTokens) return messages;
  const snapshotCalls = new Set<string>();
  for (const message of messages) if (message.role === 'assistant') {
    for (const call of message.tool_calls ?? []) if (call.function.name === 'take_snapshot') snapshotCalls.add(call.id);
  }
  let latestUser = -1, latestObservation = -1, latestSnapshot = -1;
  messages.forEach((message, index) => {
    if (message.role === 'user') latestUser = index;
    if (message.role === 'user' && !isCheckpoint(message)) latestObservation = index;
    if (message.role === 'tool' && snapshotCalls.has(message.tool_call_id)) latestSnapshot = index;
  });
  const compact = messages.map((message, index): ChatMessage => {
    if (index > 1 && index !== latestUser && index !== latestObservation && message.role === 'user') {
      const content = typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
      return { role: 'user', content: `Previous page observation superseded: ${/^URL: (.+)$/m.exec(content)?.[1] ?? 'earlier page'}. Current observations and the recorded draft follow; original tool actions remain in the conversation.` };
    }
    if (message.role === 'tool' && snapshotCalls.has(message.tool_call_id) && index !== latestSnapshot) {
      return { ...message, content: 'Previous accessibility snapshot superseded. Use the latest snapshot/current page or request a fresh one.' };
    }
    return message;
  });
  return trimTranscript(compact, Math.floor(maxTokens * 0.75));
}
