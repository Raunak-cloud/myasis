import type { ChatMessage } from '../celeris.js';
import { renderObservation, type Observation } from '../observe.js';

// Observation messages and transcript trimming used by the application agent.

/** Rough token proxy; good enough to decide when to trim, and free. */
const estimateTokens = (messages: ChatMessage[]): number =>
  Math.ceil(JSON.stringify(messages).length / 4);

/**
 * Drops the oldest exchanges when the transcript outgrows its budget.
 *
 * This costs cache hits — everything after the system prompt shifts — so it is
 * a last resort rather than a per-turn tidy-up. The system prompt and the
 * application message after it are always kept: the latter is what tells the
 * model which job it is applying for.
 */
export function trimTranscript(messages: ChatMessage[], maxTokens: number): ChatMessage[] {
  if (estimateTokens(messages) <= maxTokens) return messages;
  const [system, application, ...rest] = messages;
  const kept = [...rest];
  // Drop from the front in pairs so an assistant tool_call is never separated
  // from its tool result, which the API rejects.
  while (kept.length > 4 && estimateTokens([system, application, ...kept]) > maxTokens) {
    // Remove complete exchanges, ending at the next observation/user boundary.
    let end = 1;
    while (end < kept.length && kept[end].role !== 'user') end++;
    kept.splice(0, end);
  }
  return [system, application, { role: 'user', content: '[earlier steps omitted]' }, ...kept];
}

export function observationMessage(observation: Observation, note?: string): ChatMessage {
  const trimmedNote = (note ?? '').trim();
  const text = `${trimmedNote ? `${trimmedNote}\n\n` : ''}${renderObservation(observation)}`;
  if (!observation.screenshot) return { role: 'user', content: text };
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image_url', image_url: { url: observation.screenshot } },
    ],
  };
}
