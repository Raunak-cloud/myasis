import type { Frame, Locator, Page } from 'patchright';

const observedFrames = new WeakMap<Page, { next: number; frames: Map<string, Frame> }>();

/** An observed target became stale or the agent selected an unsupported
 * target. Correct the call from fresh evidence; this is not a source defect. */
export class BrowserTargetInputError extends Error {
  constructor(message:string){super(message);this.name='BrowserTargetInputError';}
}

/** A reference stays bound to its actual browser frame, never its current array
 * index. Locators still resolve fresh controls; detached frames cannot retarget
 * an action to a replacement frame. No DOM handles or candidate data retained. */
export function registerObservedFrame(page: Page, frame: Frame): string {
  assertBrowserPage(page);
  let registry = observedFrames.get(page);
  if (!registry) { registry = { next: 1, frames: new Map() }; observedFrames.set(page, registry); }
  for (const [ref, known] of registry.frames) {
    if (known.isDetached()) registry.frames.delete(ref);
    else if (known === frame) return ref;
  }
  const ref = `frame${registry.next++}`;
  registry.frames.set(ref, frame); return ref;
}

export function observedFrame(page: Page, ref: string): Frame | undefined {
  assertBrowserPage(page);
  if (!/^frame\d+$/.test(ref)) return undefined;
  const frame = observedFrames.get(page)?.frames.get(ref);
  if (!frame || frame.isDetached()) throw new BrowserTargetInputError(`Observed ${ref} is no longer attached. Inspect the fresh page; no replacement frame was selected.`);
  return frame;
}

/** Resolve afresh for every operation. Never retain an ElementHandle across a rerender. */
export function locate(page: Page, ref: string): Locator | null {
  assertBrowserPage(page);
  const nested = /^(frame\d+):([af]\d+(?::\d+)?)$/.exec(ref);
  if (nested) {
    const frame = observedFrame(page, nested[1])!;
    return frame.locator(`[${nested[2].startsWith('a') ? 'data-ref-id' : 'data-field-id'}="${nested[2]}"]`);
  }
  if (/^a\d+$/.test(ref)) return page.locator(`[data-ref-id="${ref}"]`);
  if (/^f\d+(?::\d+)?$/.test(ref)) return page.locator(`[data-field-id="${ref}"]`);
  if (/^(?:f\d+)?e\d+$/.test(ref)) return page.locator(`aria-ref=${ref}`);
  return null;
}

/** Standard Playwright locators, selected by the agent, without widget recipes. */
export const browserTargetProperties = {
  ref: { type: 'string', pattern: '^(?:a[0-9]+|f[0-9]+(?::[0-9]+)?|(?:f[0-9]+)?e[0-9]+|frame[0-9]+:[af][0-9]+(?::[0-9]+)?)$',
    description: 'Observed control reference, not a frame reference alone. To inspect a whole observed frame, use locator {by:"css",value:"body",frame:"frame1"}; omit all targets for a page snapshot.' },
  selector: { type: 'string' },
  locator: {
    type: 'object', additionalProperties: false,
    description: 'Direct Playwright locator. Uses exact matching by default and requires a unique element. Scope repeated controls with within (CSS), frame (iframe CSS), or an explicitly chosen zero-based index. Takes precedence over selector/ref.',
    properties: {
      by: { type: 'string', enum: ['role', 'label', 'placeholder', 'text', 'test_id', 'css'] },
      value: { type: 'string', minLength: 1 },
      name: { type: 'string', description: 'Accessible name when by=role.' },
      exact: { type: 'boolean' },
      within: { type: 'string', minLength: 1, description: 'CSS selector for the containing section in the selected frame.' },
      frame: { type: 'string', minLength: 1, description: 'Observed frame reference (for example frame1) or CSS selector for the iframe containing this control.' },
      index: { type: 'integer', minimum: 0 },
    },
    required: ['by', 'value'],
  },
};

export function hasBrowserTarget(args: Record<string, unknown>): boolean {
  return Boolean(args.locator || args.selector || args.ref);
}

/** Internal API contract, not employer/candidate data. A corrupted Page
 * argument must not masquerade as an absent frame or a missing form field. */
function assertBrowserPage(page: Page): void {
  if (!page || typeof page !== 'object' || typeof page.locator !== 'function' || typeof page.frames !== 'function') {
    const error = new TypeError('Browser target resolution received a non-Page argument.');
    error.name = 'BrowserPageContractError'; throw error;
  }
}

export function browserTarget(page: Page, args: Record<string, unknown>): Locator {
  assertBrowserPage(page);
  if (args.locator) {
    const spec = args.locator as { by: string; value: string; name?: string; exact?: boolean; within?: string; frame?: string; index?: number };
    const frame = spec.frame ? observedFrame(page, spec.frame) ?? page.frameLocator(spec.frame) : page;
    const scope = spec.within ? frame.locator(spec.within) : frame;
    const exact = spec.exact ?? true;
    let result: Locator;
    switch (spec.by) {
      case 'role': result = scope.getByRole(spec.value as Parameters<Page['getByRole']>[0], { name: spec.name, exact }); break;
      case 'label': result = scope.getByLabel(spec.value, { exact }); break;
      case 'placeholder': result = scope.getByPlaceholder(spec.value, { exact }); break;
      case 'text': result = scope.getByText(spec.value, { exact }); break;
      case 'test_id': result = scope.getByTestId(spec.value); break;
      case 'css': result = scope.locator(spec.value); break;
      default: throw new BrowserTargetInputError('Choose a standard Playwright locator: role, label, placeholder, text, test_id or css.');
    }
    // Playwright strictness exposes ambiguity to the agent instead of silently
    // choosing a potentially different answer/control. An index is explicit.
    return spec.index === undefined ? result : result.nth(spec.index);
  }
  if (args.selector) return page.locator(String(args.selector));
  const ref = String(args.ref ?? '');
  const found = locate(page, ref);
  if (!found) throw new BrowserTargetInputError('Use an observed ref, CSS selector or Playwright locator for this element.');
  return found;
}
