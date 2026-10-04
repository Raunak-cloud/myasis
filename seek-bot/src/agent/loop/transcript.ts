import type { Page } from 'patchright';
import type { ChatMessage } from '../celeris.js';
import { renderObservation, type Observation } from '../observe.js';

// Part of the agent loop, split from loop.ts by concern; loop.ts re-exports it.

/** Rough token proxy; good enough to decide when to trim, and free. */
export const estimateTokens = (messages: ChatMessage[]): number =>
  Math.ceil(JSON.stringify(messages).length / 4);

/**
 * Drops the oldest exchanges when the transcript outgrows its budget.
 *
 * This costs cache hits — everything after the system prompt shifts — so it is
 * a last resort rather than a per-turn tidy-up. The system prompt and the first
 * observation are always kept: the latter is what tells the model which job it
 * is applying for.
 */
export function trimTranscript(messages: ChatMessage[], maxTokens: number): ChatMessage[] {
  if (estimateTokens(messages) <= maxTokens) return messages;
  const [system, firstObservation, ...rest] = messages;
  const kept = [...rest];
  // Drop from the front in pairs so an assistant tool_call is never separated
  // from its tool result, which the API rejects.
  while (kept.length > 4 && estimateTokens([system, firstObservation, ...kept]) > maxTokens) {
    // Remove complete exchanges, ending at the next observation/user boundary.
    let end = 1;
    while (end < kept.length && kept[end].role !== 'user') end++;
    kept.splice(0, end);
  }
  return [system, firstObservation, { role: 'user', content: '[earlier steps omitted]' }, ...kept];
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
