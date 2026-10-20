import type { ChatMessage } from './celeris.js';
import { trimTranscript } from './loop/transcript.js';

/** Old DOM trees are observations, not candidate facts. Keep the current
 * observation/snapshot, authored answers and tool actions. */
export function agentOnlyTranscript(messages: ChatMessage[], maxTokens: number): ChatMessage[] {

  const snapshotCalls = new Set<string>();
  for (const message of messages) if (message.role === 'assistant') {
    for (const call of message.tool_calls ?? []) if (call.function.name === 'take_snapshot') snapshotCalls.add(call.id);
  }
  let latestUser = -1, latestSnapshot = -1;
  messages.forEach((message, index) => {
    if (message.role === 'user') latestUser = index;
    if (message.role === 'tool' && snapshotCalls.has(message.tool_call_id)) latestSnapshot = index;
  });
  const compact = messages.map((message, index): ChatMessage => {
    if (index > 1 && index !== latestUser && message.role === 'user') {
      const content = typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
      return { role: 'user', content: `Previous page observation superseded: ${/^URL: (.+)$/m.exec(content)?.[1] ?? 'earlier page'}. Current observations and the recorded draft follow; original tool actions remain in the conversation.` };
    }
    if (message.role === 'tool' && snapshotCalls.has(message.tool_call_id) && index !== latestSnapshot) {
      return { ...message, content: 'Previous accessibility snapshot superseded. Use the latest snapshot/current page or request a fresh one.' };
    }
    return message;
  });
  return trimTranscript(compact, maxTokens);
}
