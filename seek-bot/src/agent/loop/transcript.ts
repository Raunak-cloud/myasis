import type { Page } from 'patchright';
import type { ChatMessage } from '../celeris.js';
import { renderObservation, type Observation } from '../observe.js';

// Part of the agent loop, split from loop.ts by concern; loop.ts re-exports it.

/** Rough token proxy; good enough to decide when to trim, and free. */
const estimateTokens = (messages: ChatMessage[]): number =>
  Math.ceil(JSON.stringify(messages).length / 4);

/** Base64 is a transport encoding, not text tokens. Also count native
 * assistant blocks once, rather than their duplicate compatibility fields. */
export function estimateHaikuTokens(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => {
    if (message.role === 'assistant' && message.nativeContent) {
      return total + Math.ceil(JSON.stringify(message.nativeContent).length / 4);
    }
    if (message.role === 'user' && Array.isArray(message.content)) {
      return total + message.content.reduce((sum, part) => sum + (part.type === 'text' ? Math.ceil(part.text.length / 4) : 4096), 0);
    }
    return total + Math.ceil(JSON.stringify(message).length / 4);
  }, 0);
}

/** Keep the accepted native prefix stable. If a long conversation must be
 * trimmed, retain complete exchanges and commit that change once with room
 * for more turns, rather than shifting the prefix on every following call. */
export function browserTranscript(messages: ChatMessage[], maxTokens: number, haiku: boolean): ChatMessage[] {
  if (!haiku) return trimTranscript(messages, maxTokens);
  if (estimateHaikuTokens(messages) <= maxTokens) return messages;
  const [system, application, ...rest] = messages;
  const kept = [...rest];
  const omitted: ChatMessage = { role: 'user', content: '[Earlier page observations omitted. Canonical candidate profile and current application remain authoritative; retrieve saved evidence again if needed.]' };
  const target = Math.min(maxTokens, 40_000) / 2;
  while (kept.length > 4 && estimateHaikuTokens([system, application, omitted, ...kept]) > target) {
    let end = 1;
    while (end < kept.length && kept[end].role !== 'user') end++;
    kept.splice(0, end);
  }
  messages.splice(0, messages.length, system, application, omitted, ...kept);
  return messages;
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

/**
 * The observation reads the main document only. A form embedded in an iframe
 * (an ATS inside an employer's careers page, a CAPTCHA-free sign-in widget) is
 * invisible to it, so the agent is told one is there and how to see it.
 */
export async function embeddedForms(page: Page): Promise<string> {
  const frames = page.frames().filter((frame) => frame !== page.mainFrame() && /^https?:|^about:srcdoc/.test(frame.url()));
  const found: string[] = [];
  for (const frame of frames.slice(0, 8)) {
    const controls = await frame
      .evaluate(() => [...document.querySelectorAll('input:not([type="hidden"]), textarea, select, button')]
        .filter((el) => (el as HTMLElement).offsetParent !== null).length)
      .catch(() => 0);
    if (controls < 2) continue;
    // CAPTCHA frames belong to the solver.
    if (/recaptcha|hcaptcha|turnstile|challenges.cloudflare|arkoselabs|funcaptcha/i.test(frame.url())) continue;
    let host = 'an embedded page';
    try { host = new URL(frame.url()).host || host; } catch {}
    found.push(`${host} (${controls} controls)`);
  }
  return found.length
    ? `This page embeds a form in an iframe that ACTIONS and FIELDS do not include: ${found.join('; ')}. Call take_snapshot to see and use it.`
    : '';
}
