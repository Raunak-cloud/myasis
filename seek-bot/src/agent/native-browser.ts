import type { Frame, Locator, Page } from 'patchright';
import { browserTarget, browserTargetProperties, hasBrowserTarget } from './browser-target.js';

export const MAX_BROWSER_BATCH = 12;
export const browserWaitProperties = {
  wait: {
    type: 'object', additionalProperties: false,
    description: 'Optional native wait for a target/state or URL after this action. timeout_ms is a maximum, not a delay; timeout alone adds no wait beyond the action\'s native auto-waiting.',
    properties: {
      ...browserTargetProperties,
      state: { type: 'string', enum: ['visible', 'hidden', 'attached', 'detached'] },
      url: { type: 'string', description: 'Exact URL or Playwright URL glob.' },
      timeout_ms: { type: 'integer', minimum: 1, maximum: 15000 },
    },
  },
};

/** Read actual current values and constraints together; never infer an answer or select a widget recipe. */
export async function nativeReadback(target: Locator): Promise<unknown> {
  return target.evaluate(node => {
    const input = node as HTMLInputElement;
    const select = node as HTMLSelectElement;
    const element = node as HTMLElement;
    const type = input.type || node.getAttribute('role') || node.tagName.toLowerCase();
    const privateValue = type === 'password' || /password|one-time-code/.test(input.autocomplete || '')
      || /password|passphrase|verification.?code|one.?time.?code|\botp\b/i.test(`${input.name} ${node.getAttribute('aria-label')} ${[...(input.labels || [])].map(label => label.textContent).join(' ')}`);
    const described = (node.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)
      .map(id => node.getRootNode() instanceof ShadowRoot
        ? (node.getRootNode() as ShadowRoot).getElementById(id)?.textContent : node.ownerDocument.getElementById(id)?.textContent).filter(Boolean);
    return {
      tag: node.tagName.toLowerCase(), type, name: input.name || null,
      private: privateValue,
      label: [...(input.labels || [])].map(label => label.textContent).join(' ') || node.getAttribute('aria-label') || null,
      value: privateValue ? '[private credential]' : element.isContentEditable ? element.innerText : input.value ?? element.innerText,
      checked: typeof input.checked === 'boolean' ? input.checked : node.getAttribute('aria-checked'),
      selected: node.tagName === 'SELECT' ? [...select.selectedOptions].map(option => ({ value: option.value, label: option.label })) : undefined,
      files: type === 'file' ? [...(input.files || [])].map(file => file.name) : undefined,
      required: input.required || node.getAttribute('aria-required') === 'true',
      min: input.min, max: input.max, step: input.step, maxLength: input.maxLength,
      placeholder: input.placeholder, invalid: node.getAttribute('aria-invalid'),
      validation: input.validationMessage || '', description: described,
      expanded: node.getAttribute('aria-expanded'), controls: node.getAttribute('aria-controls'),
    };
  }, undefined, { timeout: 5000 });
}

export async function waitAfterAction(page: Page, args: Record<string, unknown>): Promise<string | undefined> {
  if (!args.wait) return;
  const wait = args.wait as Record<string, unknown>;
  // A timeout is only a bound, not a target. Never turn an already executed
  // click into a selector failure because the agent supplied only that bound.
  if (!wait.url && !hasBrowserTarget(wait)) return;
  const timeout = Math.min(15000, Math.max(1, Number(wait.timeout_ms ?? 8000)));
  try {
    if (wait.url) await page.waitForURL(String(wait.url), { timeout, waitUntil: 'domcontentloaded' });
    else await browserTarget(page, wait).waitFor({ state: (wait.state ?? 'visible') as 'visible', timeout });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error;
    return `${args.action === 'wait' ? 'The requested wait' : 'The browser action completed, but its follow-up wait'} timed out. Inspect the current page and saved values before deciding the next action; this does not mean the preceding action failed.`;
  }
}

export function hasWaitCondition(args: Record<string, unknown>): boolean {
  const wait = args.wait as Record<string, unknown> | undefined;
  return Boolean(wait && (wait.url || hasBrowserTarget(wait)));
}

/** Browser JavaScript only. No Node globals, host filesystem or arbitrary host-code executor. */
export async function evaluateBrowser(page: Page, args: Record<string, unknown>): Promise<unknown> {
  let scope: Page | Frame = page;
  const frameSelector = (args.locator as { frame?: string } | undefined)?.frame;
  if (frameSelector) {
    const handle = await page.locator(frameSelector).elementHandle({ timeout: 5000 });
    try {
      const frame = await handle?.contentFrame();
      if (!frame) throw new Error('The selected iframe is unavailable. Inspect the current page.');
      scope = frame;
    } finally { await handle?.dispose(); }
  }
  return scope.evaluate(async source => {
    let result;
    try { result = (0, eval)(source); }
    catch (error) {
      if (!(error instanceof SyntaxError) || !/return/i.test(error.message)) throw error;
      return new Function(`return (async()=>{${source}\n})()`)();
    }
    return typeof result === 'function' ? await result() : await result;
  }, String(args.script), undefined, false);
}
