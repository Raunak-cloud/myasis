import type { ChatMessage } from '../celeris.js';
import { renderObservation, type Observation } from '../observe.js';

// Observation messages and transcript trimming used by the application agent.

/** Text proxy plus a conservative reserve per browser screenshot. Base64 is
 * transport encoding, not text consumed by the model tokenizer. Counting its
 * bytes used to compact healthy conversations on every screenshot turn.
 * This is not billing: actual provider usage owns costs and context errors
 * still trigger bounded compaction/retry without replaying browser actions. */
export function estimateTranscriptTokens(messages: ChatMessage[]): number {
  let images = 0;
  const text = messages.map(message => !Array.isArray(message.content) ? message : {
    ...message, content: message.content.map(part => {
      if (part.type !== 'image_url') return part;
      images++;
      return { type: 'image_url', image_url: { url: '[image encoded separately]' } };
    }),
  });
  return Math.ceil(JSON.stringify(text).length / 4) + images * 4096;
}

/**
 * Drops the oldest exchanges when the transcript outgrows its budget.
 *
 * This costs cache hits — everything after the system prompt shifts — so it is
 * a last resort rather than a per-turn tidy-up. The system prompt and the
 * application message after it are always kept: the latter is what tells the
 * model which job it is applying for.
 */
export function trimTranscript(messages: ChatMessage[], maxTokens: number): ChatMessage[] {
  if (estimateTranscriptTokens(messages) <= maxTokens) return messages;
  const [system, application, ...rest] = messages;
  const kept = [...rest];
  // Drop from the front in pairs so an assistant tool_call is never separated
  // from its tool result, which the API rejects.
  while (kept.length > 4 && estimateTranscriptTokens([system, application, ...kept]) > maxTokens) {
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
