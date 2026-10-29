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

/** Shared browser-side description. No answers, actions or host dependencies. */
function describeNativeTargets(targets: Element | Element[]) {
  const nodes = Array.isArray(targets) ? targets : [targets];
  return { matched: nodes.length, truncated: nodes.length > 80, fields: nodes.slice(0, 80).map(node => {
    const input = node as HTMLInputElement;
    const select = node as HTMLSelectElement;
    const element = node as HTMLElement;
    const type = input.type || node.getAttribute('role') || node.tagName.toLowerCase();
    const privateValue = type === 'password' || /password|one-time-code/.test(input.autocomplete || '')
      || /password|passphrase|verification.?code|one.?time.?code|\botp\b/i.test(`${input.name} ${node.getAttribute('aria-label')} ${[...(input.labels || [])].map(label => label.textContent).join(' ')}`);
    const described = (node.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)
      .map(id => node.getRootNode() instanceof ShadowRoot
        ? (node.getRootNode() as ShadowRoot).getElementById(id)?.textContent : node.ownerDocument.getElementById(id)?.textContent).filter(Boolean);
    const context = [];
    for (let depth = 0, parent = node.parentElement; nodes.length > 1 && parent && depth < 4; depth++, parent = parent.parentElement) {
      context.push({ tag: parent.tagName.toLowerCase(), id: parent.id || undefined,
        label: parent.getAttribute('aria-label') || undefined,
        heading: parent.querySelector(':scope > legend, :scope > label, :scope > h2, :scope > h3, :scope > h4')?.textContent?.trim().slice(0, 200) });
    }
    return {
      id: node.id || null, ref: node.getAttribute('data-field-id') || node.getAttribute('data-ref-id') || null,
      tag: node.tagName.toLowerCase(), type, name: input.name || null,
      private: privateValue,
      label: [...(input.labels || [])].map(label => label.textContent).join(' ') || node.getAttribute('aria-label') || null,
      context: nodes.length > 1 ? context : undefined,
      value: privateValue ? '[private credential]' : element.isContentEditable ? element.innerText : input.value ?? element.innerText,
      checked: typeof input.checked === 'boolean' ? input.checked : node.getAttribute('aria-checked'),
      selected: node.tagName === 'SELECT' ? [...select.selectedOptions].map(option => ({ value: option.value, label: option.label })) : undefined,
      files: type === 'file' ? [...(input.files || [])].map(file => file.name) : undefined,
      required: input.required || node.getAttribute('aria-required') === 'true',
      readOnly: input.readOnly || node.getAttribute('aria-readonly') === 'true',
      disabled: input.disabled || node.getAttribute('aria-disabled') === 'true',
      min: input.min, max: input.max, step: input.step, maxLength: input.maxLength,
      placeholder: input.placeholder, invalid: node.getAttribute('aria-invalid'),
      validation: input.validationMessage || '', description: described,
      expanded: node.getAttribute('aria-expanded'), controls: node.getAttribute('aria-controls'),
    };
  }) };
}

/** Mutation readback remains strict: exactly the target the action addressed. */
export async function nativeReadback(target: Locator): Promise<unknown> {
  return (await target.evaluate(describeNativeTargets, undefined, { timeout: 5000 })).fields[0];
}

/** One evaluation reads the current matching nodes together, including privacy
 * masking. Multiple matches are useful evidence, never permission for writes. */
export async function nativeInspect(target: Locator): Promise<unknown> {
  const result = await target.evaluateAll(describeNativeTargets);
  return result.matched === 1 ? result.fields[0] : result;
}

/** Read-only evidence after a failed interaction. Never chooses an index,
 * dismisses an overlay or repeats the operation. Credentials remain masked. */
export async function browserFailureEvidence(page: Page, args: Record<string, unknown>): Promise<string> {
  if (page.isClosed()) return '';
  const matches = hasBrowserTarget(args) ? await nativeInspect(browserTarget(page, args)).catch(() => 'Target changed or cannot be inspected.') : undefined;
  const frames = page.frames().slice(0, 20).map(frame => {
    let url = ''; try { const parsed = new URL(frame.url()); url = parsed.origin + parsed.pathname; } catch { /* Blank frame. */ }
    return { name: frame.name(), url, main: !frame.parentFrame() };
  });
  const hosts = await page.locator('iframe').evaluateAll(nodes => nodes.slice(0, 20).map(node => ({
    id: node.id || undefined, name: node.getAttribute('name'), title: node.getAttribute('title'),
    visible: node.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }),
  }))).catch(() => []);
  return `\nFRESH FAILURE EVIDENCE (read only; no retry executed): ${JSON.stringify({ matchingTargets: matches, frames, iframeHosts: hosts }).slice(0, 6500)}\nInspect matching controls and their context before choosing a unique target. A control inside an iframe needs that frame or its current accessibility ref; a main-document selector does not search iframe contents.`;
}

/** Read every requested section with current locators, never retained handles.
 * Keep large / changing pages bounded and make omitted sections explicit. */
async function snapshotPrivateValues(page: Page): Promise<string[] | undefined> {
  const reads = await Promise.allSettled(page.frames().map(frame => frame.locator('input, textarea').evaluateAll(nodes => nodes
    .filter(node => {
      const input = node as HTMLInputElement;
      return input.type === 'password' || /password|one-time-code/.test(input.autocomplete || '')
        || /password|passphrase|verification.?code|one.?time.?code|\botp\b/i.test(`${input.name} ${node.getAttribute('aria-label')} ${[...(input.labels || [])].map(label => label.textContent).join(' ')}`);
    }).map(node => (node as HTMLInputElement).value).filter(Boolean))));
  // Do not expose an old snapshot if privacy inspection lost its page/frame.
  if (reads.some(read => read.status === 'rejected')) return undefined;
  return reads.flatMap(read => read.status === 'fulfilled' ? read.value : []);
}

async function maskSnapshots(page: Page, snapshots: string[], before: string[] | undefined): Promise<string[]> {
  const after = await snapshotPrivateValues(page);
  if (!before || !after) return ['Snapshot not returned because a frame changed during private-value masking. Inspect the fresh page and retry a focused snapshot.'];
  for (const secret of new Set([...before, ...after])) {
    for (const representation of [secret, JSON.stringify(secret).slice(1, -1), secret.replaceAll("'", "''")]) {
      if (representation) snapshots = snapshots.map(snapshot => snapshot.replaceAll(representation, '[private credential]'));
    }
  }
  return snapshots;
}

export async function nativeSnapshot(target: Locator | Page, timeout = 15_000): Promise<string> {
  const scoped = 'count' in target ? target : undefined;
  const page = scoped ? scoped.page() : target as Page;
  const before = await snapshotPrivateValues(page);
  if (!scoped) return (await maskSnapshots(page, [await target.ariaSnapshot({ mode: 'ai', timeout })], before))[0];
  const count = await scoped.count();
  if (!count) return 'No matching snapshot targets are currently present. Inspect the fresh page or wait for an observed condition.';
  if (count === 1) return (await maskSnapshots(page, [await scoped.ariaSnapshot({ mode: 'ai', timeout })], before))[0];
  // Patchright replaces its accessibility-ref map on every snapshot. Separate
  // subtree captures make the earlier returned refs stale even on a static
  // page. One capture gives every included target the same usable ref map.
  const snapshot = (await maskSnapshots(page, [await page.ariaSnapshot({ mode: 'ai', timeout })], before))[0];
  const bounded = snapshot.length <= 24000 ? snapshot : snapshot.slice(0,16000)
    + '\n[Middle omitted; narrow your inspection to one intended section.]\n' + snapshot.slice(-8000);
  return `Matched ${count} snapshot targets. Returning one fresh page snapshot with consistent references; narrow the locator for a focused section.\n${bounded}`;
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
    // Waiting is observation after the action, not part of its execution.
    // Ambiguous/invalid wait locators must not invite replay of a completed
    // click, just as a timeout must not. Actual browser loss still propagates.
    if (!(error instanceof Error) || page.isClosed() || /TargetClosed|closed|disconnected|session.*(?:gone|ended)/i.test(`${error.name} ${error.message}`)) throw error;
    const detail = error.name === 'TimeoutError' ? 'timed out' : `could not be evaluated: ${error.message.slice(0, 1200)}`;
    return `${args.action === 'wait' ? 'The requested wait' : 'The browser action completed, but its follow-up wait'} ${detail}. Inspect the current page and saved values before deciding the next action; this does not mean the preceding action failed.`;
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
