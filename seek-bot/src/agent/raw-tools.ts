import type { Dialog, Frame, Locator, Page, Request, Route } from 'patchright';
import { answerFields, acceptBrowserDialog, reviewBrowserScript } from '../llm.js';
import type { FormField } from '../types.js';
import { isAustralianGovernmentUrl } from '../site-policy.js';
import type { ToolSchema } from './celeris.js';
import { isForbiddenDestination, siteDomain } from './guards.js';
import {
  coverLetterDocument,
  coverLetterSent,
  gateAdvance,
  resumeDocument,
  resumeSent,
  type ToolContext,
  type ToolResult,
} from './tools.js';

/**
 * The general browser toolset: what a person at DevTools has, for everything
 * the purpose-built tools do not reach — a form inside an iframe, a widget
 * that ignores synthetic input, a tab the site opened, a request that fails
 * without a word on the page.
 *
 * General does not mean ungoverned. The rules live below the tools, where no
 * tool can step around them:
 *
 * - Every press that might send the application goes through `gateAdvance`,
 *   the same gate as a listed click, and a form post nothing announced is
 *   caught on the network and put through it too.
 * - While a general tool runs, a request that would carry the candidate's
 *   email or phone to a site the application is not on is refused.
 * - A form these tools changed is audited against the candidate's record
 *   before it is sent (see `auditBeforeSubmit`), so a typed or scripted value
 *   cannot slip an unsupported claim past grounding.
 * - Scripts are read by a model before they run; one that would send data
 *   elsewhere or act on the page's own instructions is refused.
 */

const ok = (message: string): ToolResult => ({ kind: 'ok', message });

/** Refs from an accessibility snapshot: "e12", or "f1e3" inside the first iframe. */
const SNAPSHOT_REF = /^(?:f\d+)?e\d+$/;

/** Finds the element a ref names, whichever listing it came from. */
export function locate(page: Page, ref: string): Locator | null {
  if (/^a\d+$/.test(ref)) return page.locator(`[data-ref-id="${ref}"]`).first();
  if (/^f\d+$/.test(ref)) return page.locator(`[data-field-id="${ref}"]`).first();
  if (SNAPSHOT_REF.test(ref)) return page.locator(`aria-ref=${ref}`);
  return null;
}

interface ElementFacts {
  tag: string;
  role: string;
  type: string;
  name: string;
  href: string | null;
  fieldRef: string | null;
  actionRef: string | null;
  options: string[];
  required: boolean;
  editable: boolean;
}

/** What an element is, read from the element itself (in whatever frame it lives). */
async function describe(locator: Locator): Promise<ElementFacts | null> {
  return locator
    .evaluate((element) => {
      const el = element as HTMLElement;
      const input = element as HTMLInputElement;
      const compact = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
      const labelled = element.getAttribute('aria-labelledby');
      const labelText = labelled
        ? labelled.split(/\s+/).map((id) => compact(element.ownerDocument.getElementById(id)?.textContent)).join(' ')
        : '';
      const ownLabel = 'labels' in input && input.labels?.length ? compact(input.labels[0].textContent) : '';
      const name = compact(element.getAttribute('aria-label')) || labelText || ownLabel || compact(el.innerText)
        || compact(input.value) || compact(element.getAttribute('placeholder')) || compact(element.getAttribute('title'));
      const link = element.closest('a[href]') as HTMLAnchorElement | null;
      return {
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role') ?? '',
        type: (input.type ?? '').toLowerCase(),
        name: name.slice(0, 200),
        href: link ? link.href : null,
        fieldRef: element.closest('[data-field-id]')?.getAttribute('data-field-id') ?? null,
        actionRef: element.closest('[data-ref-id]')?.getAttribute('data-ref-id') ?? null,
        options: element instanceof HTMLSelectElement ? [...element.options].map((option) => compact(option.text)).filter(Boolean).slice(0, 200) : [],
        required: input.required === true || element.getAttribute('aria-required') === 'true',
        editable: element.matches('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]'),
      };
    }, undefined, { timeout: 5_000 })
    .catch(() => null);
}

/**
 * A fingerprint of everything visible in the tab, iframes included — the
 * main-frame check misses a click that changes only an embedded form.
 */
async function surface(page: Page): Promise<string> {
  return framesState(page.frames());
}

/**
 * The same fingerprint for the embedded frames alone. The agent loop's
 * no-progress check reads the main frame's observation, so a form inside an
 * iframe (JobAdder, many council and university sites) looked unchanged
 * while the agent was filling it, and the application was abandoned as stuck.
 */
export async function embeddedSurface(page: Page): Promise<string> {
  return framesState(page.frames().filter((frame) => frame !== page.mainFrame()));
}

async function framesState(frames: Frame[]): Promise<string> {
  const parts = await Promise.all(frames.map((frame) => frame
    .evaluate(() => {
      const values = [...document.querySelectorAll('input, textarea, select')]
        .slice(0, 80).map((el) => `${(el as HTMLInputElement).value}:${(el as HTMLInputElement).checked}`).join('|');
      return `${location.href}\n${(document.body?.innerText ?? '').slice(0, 6_000)}\n${values}`;
    })
    .catch(() => '')));
  return parts.join('\n--\n');
}

async function changedAfter(page: Page, before: string, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(250).catch(() => {});
    if (page.isClosed()) return true;
    if ((await surface(page)) !== before) return true;
  }
  return false;
}

/** Whether a request carries the candidate's email or phone number. */
function carriesCandidateData(request: Request, ctx: ToolContext): boolean {
  let haystack = `${request.url()}\n${request.postData() ?? ''}`;
  try { haystack = decodeURIComponent(haystack); } catch {}
  haystack = haystack.toLowerCase();
  const email = ctx.profile.email?.trim().toLowerCase();
  if (email && haystack.includes(email)) return true;
  const phone = (ctx.profile.phone ?? '').replace(/\D/g, '').slice(-8);
  return phone.length === 8 && haystack.replace(/\D/g, '').includes(phone);
}

/** Every site the application is on right now: each open tab and each frame in it. */
function applicationSites(ctx: ToolContext): Set<string> {
  const sites = new Set<string>();
  for (const page of ctx.page.context().pages()) {
    for (const frame of page.frames()) {
      const url = frame.url();
      if (/^https?:/.test(url)) sites.add(siteDomain(url));
    }
  }
  return sites;
}

/**
 * Runs a general tool with the network watched. Two things are caught at
 * the wire, where no tool can go around them: a form post that would send the
 * application without having passed the submit gate (put through the gate
 * now, and dropped if it fails), and the candidate's contact details leaving
 * for a site the application is not on.
 */
async function watched(ctx: ToolContext, label: string, run: () => Promise<ToolResult>): Promise<ToolResult> {
  ctx.lastActionLabel = label;
  let held: ToolResult | null = null;
  const refused: string[] = [];
  const handler = async (route: Route) => {
    const request = route.request();
    const url = request.url();
    try {
      if (!/^https?:/.test(url)) return await route.fallback();
      if (request.isNavigationRequest() && isForbiddenDestination(url)) {
        refused.push(`navigation to ${url}`);
        return await route.abort('blockedbyclient');
      }
      if (carriesCandidateData(request, ctx) && !applicationSites(ctx).has(siteDomain(url))) {
        refused.push(`sending the candidate's details to ${new URL(url).host}`);
        return await route.abort('blockedbyclient');
      }
      if (request.isNavigationRequest() && request.method() !== 'GET' && !ctx.submitCleared && !ctx.pressJudged && !held) {
        const fields = new URLSearchParams(request.postData() ?? '');
        const names = [...fields.keys()].slice(0, 30).join(', ');
        const gate = await gateAdvance(ctx, `form sent to ${new URL(url).pathname}`, `posted fields: ${names || 'unknown'}`);
        if (!gate.proceed) {
          held = gate.result;
          return await route.abort('blockedbyclient');
        }
      }
      return await route.fallback();
    } catch {
      // A route already handled (the page navigated away) needs nothing more.
    }
  };
  const context = ctx.page.context();
  await context.route('**/*', handler);
  ctx.submitCleared = false;
  ctx.pressJudged = false;
  try {
    const result = await run();
    // A post fired late (an animation, a debounce) still lands inside the watch.
    await ctx.page.waitForTimeout(600).catch(() => {});
    if (refused.length) ctx.log(`  ⛔ refused ${refused.join('; ')}`);
    if (held) return held;
    if (refused.length && result.kind === 'ok') {
      return ok(`${result.message}\nRefused by the browser guard: ${refused.join('; ')}. The candidate's details go only to the application.`);
    }
    return result;
  } finally {
    ctx.submitCleared = false;
    ctx.pressJudged = false;
    await context.unroute('**/*', handler).catch(() => {});
  }
}

const NEED_SNAPSHOT = 'That ref is not on the page any more. Call take_snapshot for current refs.';

const SNAPSHOT_LIMIT = 24_000;

async function takeSnapshot(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const scope = typeof args.ref === 'string' && args.ref ? locate(ctx.page, args.ref) : null;
  if (args.ref && !scope) return ok('Unknown ref. Omit ref to snapshot the whole tab.');
  const snapshot = scope
    ? await scope.ariaSnapshot({ mode: 'ai', timeout: 15_000 }).catch(() => '')
    : await ctx.page.ariaSnapshot({ mode: 'ai', timeout: 15_000 }).catch(() => '');
  if (!snapshot) return ok('The page could not be read right now. Use wait_for_page, then try again.');
  const tabs = ctx.page.context().pages();
  const clipped = snapshot.length > SNAPSHOT_LIMIT
    ? `${snapshot.slice(0, SNAPSHOT_LIMIT)}\n… (${snapshot.length - SNAPSHOT_LIMIT} more characters: take_snapshot with the ref of a section to see it)`
    : snapshot;
  return ok(
    `Tab ${tabs.indexOf(ctx.page) + 1} of ${tabs.length}: ${ctx.page.url()}\n` +
    'Refs below (e12, f1e3 inside an iframe) work with click_element, fill_element, hover, drag, upload_file, press_key and evaluate_script until the page changes.\n' +
    `<untrusted>\n${clipped}\n</untrusted>`,
  );
}

async function clickElement(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const ref = String(args.ref ?? '');
  const target = locate(ctx.page, ref);
  if (!target) return ok('Give a ref from the observation or from take_snapshot.');
  const facts = await describe(target);
  if (!facts) return ok(NEED_SNAPSHOT);
  // Where the grounded tools reach the control, they answer it.
  const listed = facts.actionRef ? ctx.observation.actions.find((action) => action.ref === facts.actionRef) : undefined;
  if (listed?.role === 'option') return ok('That option is in the observation: use choose_option so the choice is grounded in the candidate profile.');
  if (facts.href && isAustralianGovernmentUrl(facts.href)) {
    return { kind: 'terminal', outcome: { status: 'skipped', reason: 'Australian government application sites are excluded.' } };
  }
  if (facts.href && isForbiddenDestination(facts.href)) return ok(`Refused: that link leads to ${facts.href}, which this agent never opens.`);
  const answers = /^(option|radio|checkbox|switch|menuitemradio|menuitemcheckbox|gridcell|treeitem)$/.test(facts.role) || ['radio', 'checkbox'].includes(facts.type);
  return watched(ctx, `click "${facts.name}"`, async () => {
    const gate = await gateAdvance(ctx, facts.name, undefined, { role: answers ? 'toggle' : facts.role });
    if (!gate.proceed) return gate.result;
    if (answers) ctx.rawUsed = true;
    const before = await surface(ctx.page);
    const clicked = await target.click({ timeout: 6_000, ...(args.double_click ? { clickCount: 2 } : {}) }).then(() => true)
      .catch(() => target.dispatchEvent('click', undefined, { timeout: 3_000 }).then(() => true).catch(() => false));
    if (!clicked) return ok(`Could not click "${facts.name}". Something may cover it: close it with press_key Escape, or scroll it into view.`);
    ctx.guards.recordProgress();
    // Waited on for the page to settle; what changed is recorded and reported by the loop.
    await changedAfter(ctx.page, before);
    return ok(`Clicked "${facts.name}".`);
  });
}

/**
 * Enters a value into any element. Without a value it is answer_questions for
 * an element the observation cannot list: the grounded answerer writes the
 * value from the candidate's record. With a value it types exactly that — for
 * search text, or a value an answer tool already returned — and the form is
 * audited before it is sent.
 */
async function fillElement(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const ref = String(args.ref ?? '');
  const target = locate(ctx.page, ref);
  if (!target) return ok('Give a ref from the observation or from take_snapshot.');
  const facts = await describe(target);
  if (!facts) return ok(NEED_SNAPSHOT);
  if (facts.type === 'password') return ok('Credentials go through complete_authentication, which holds the private site credential.');
  if (facts.type === 'file') return ok('Use upload_file for a file input.');
  const observed = facts.fieldRef ? ctx.observation.fields.find((field) => field.ref === facts.fieldRef) : undefined;
  const label = observed?.label ?? facts.name;
  if (ctx.guards.ungrounded.includes(label)) return ok(`"${label}" has no answer in the candidate's record; only the candidate can supply it.`);
  // An observed field is answered by answer_questions unless that already failed on it, or declined it as a site control.
  if (observed && !ctx.guards.unfillable.has(label) && !ctx.guards.fillAttemptsFor(label) && !ctx.guards.siteControls.has(label)) {
    return ok(`"${label}" is FIELD ${observed.ref} in the observation: use answer_questions for it. fill_element is for fields it cannot reach or could not fill.`);
  }

  let value = typeof args.value === 'string' ? args.value : null;
  if (value === null) {
    const field: FormField = {
      ref,
      label,
      kind: facts.tag === 'select' ? 'select' : facts.tag === 'textarea' ? 'textarea' : 'text',
      required: facts.required,
      ...(facts.options.length ? { options: facts.options } : {}),
      currentValue: '',
      description: `Untrusted form context (not candidate facts): ${String(args.context ?? '').slice(0, 1_500)}`,
    };
    ctx.guards.rememberField(field);
    const answer = (await answerFields([field], ctx.job, ctx.profile)).answers.find((candidate) => candidate.ref === ref);
    if (!answer || answer.applicationQuestion === false) {
      // A site control has no grounded answer to derive; the agent supplies what it needs typed.
      ctx.guards.releaseAsSiteControl(label);
      const place = [ctx.profile.suburb, ctx.profile.state].filter(Boolean).join(', ');
      return ok(`"${label}" is a site control, not an application question, so nothing is derived for it. Call fill_element again with the value to type${place ? ` (for a location search, the candidate lives in ${place})` : ''}, then pick the suggestion that appears.`);
    }
    if (!answer.grounded) {
      if (!field.required) return ok(`Left optional "${label}" blank: nothing in the candidate's record supports an answer.`);
      ctx.guards.rememberField(field, answer.candidatePrompt?.trim() || `What should Owtomate enter for “${label}”?`);
      ctx.guards.recordUngrounded(label);
      return ok(`No verified candidate fact supports "${label}". Complete the other fields, then finish needs_human.`);
    }
    value = answer.value;
  } else {
    ctx.rawUsed = true;
  }

  return watched(ctx, `fill "${label}"`, async () => {
    try {
      if (facts.tag === 'select') {
        await target.selectOption({ label: value! }, { timeout: 5_000 }).catch(() => target.selectOption(value!, { timeout: 5_000 }));
      } else {
        await target.fill(value!, { timeout: 6_000 });
      }
    } catch (error) {
      if (observed) ctx.guards.recordFillFailure(label, (error as Error).message.split('\n')[0]);
      return ok(`"${label}" did not take the value: ${(error as Error).message.split('\n')[0].slice(0, 200)}. Try click_element then type_text, or evaluate_script.`);
    }
    ctx.guards.recordFillSuccess(label);
    const prior = ctx.captured.findIndex((item) => item.question === label);
    if (prior >= 0) ctx.captured.splice(prior, 1);
    ctx.captured.push({ question: label, answer: value! });
    ctx.guards.recordProgress();
    return ok(`Entered "${value!.slice(0, 80)}" in "${label}". Check the page for validation.`);
  });
}

async function typeText(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const text = String(args.text ?? '');
  if (!text) return ok('Give the text to type.');
  ctx.rawUsed = true;
  return watched(ctx, `type "${text.slice(0, 40)}"`, async () => {
    const before = await surface(ctx.page);
    await ctx.page.keyboard.type(text, { delay: 25 });
    ctx.captured.push({ question: 'typed text', answer: text });
    await changedAfter(ctx.page, before, 2_500);
    return ok(`Typed "${text.slice(0, 80)}" into the focused element (if nothing below shows it landed, click the right element first).`);
  });
}

async function hover(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const target = locate(ctx.page, String(args.ref ?? ''));
  if (!target) return ok('Give a ref from the observation or from take_snapshot.');
  const hovered = await target.hover({ timeout: 5_000 }).then(() => true).catch(() => false);
  return ok(hovered ? 'Hovered. Take a snapshot to see what appeared.' : NEED_SNAPSHOT);
}

async function drag(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const from = locate(ctx.page, String(args.from_ref ?? ''));
  const to = locate(ctx.page, String(args.to_ref ?? ''));
  if (!from || !to) return ok('Give from_ref and to_ref from the observation or from take_snapshot.');
  ctx.rawUsed = true;
  return watched(ctx, 'drag', async () => {
    const dragged = await from.dragTo(to, { timeout: 8_000 }).then(() => true).catch(() => false);
    return ok(dragged ? 'Dragged. Check the result.' : NEED_SNAPSHOT);
  });
}

/**
 * Sends one of the candidate's approved documents to an upload: a file input
 * directly, or any button that opens the file picker. Never an arbitrary file.
 */
async function uploadFile(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const target = locate(ctx.page, String(args.ref ?? ''));
  if (!target) return ok('Give a ref from the observation or from take_snapshot.');
  const facts = await describe(target);
  if (!facts) return ok(NEED_SNAPSHOT);
  const which = args.document === 'cover_letter' ? 'cover_letter' : 'resume';
  const accept = facts.type === 'file' ? (await target.getAttribute('accept').catch(() => null)) ?? '' : '';
  const format = typeof args.format === 'string' && /^(pdf|docx|doc|rtf|txt)$/.test(args.format) ? `.${args.format}` : '';
  let file: string;
  let sent: () => void;
  if (which === 'resume') {
    const document = await resumeDocument(ctx, accept, format);
    if ('error' in document) return ok(`${document.error} Look for another way to supply the resume; otherwise finish with cannot_complete.`);
    file = document.file;
    sent = () => resumeSent(ctx, document.label);
  } else {
    const document = await coverLetterDocument(ctx, format || accept);
    if (!document) return ok(`The cover letter could not be produced as "${format || accept}". Look for a text box instead.`);
    file = document.file;
    sent = () => coverLetterSent(ctx, document);
  }
  try {
    if (facts.type === 'file') {
      await target.setInputFiles(file, { timeout: 10_000 });
    } else {
      const chooser = await Promise.all([
        ctx.page.waitForEvent('filechooser', { timeout: 8_000 }),
        target.click({ timeout: 6_000 }),
      ]).then(([opened]) => opened).catch(() => null);
      if (chooser) await chooser.setFiles(file, { timeout: 10_000 });
      else {
        /**
         * Upload widgets often keep the real input hidden beside their button
         * and open no picker for an automated click (go.programmed.com.au's
         * "Upload new document"). The input nearest the button — inside the
         * closest container that has one — is that upload's own.
         */
        // Only when that container holds exactly one: with a resume and a cover-letter input side by side, guessing could send the wrong document.
        const inputs = target.locator('xpath=ancestor-or-self::*[.//input[@type="file"]][1]//input[@type="file"]');
        if ((await inputs.count().catch(() => 0)) !== 1) throw new Error('no file picker opened and the control has no single file input of its own');
        await inputs.setInputFiles(file, { timeout: 10_000 });
      }
    }
  } catch (error) {
    return ok(`The upload did not open or take the file: ${(error as Error).message.split('\n')[0].slice(0, 160)}. Snapshot the page and use the upload's own input or button.`);
  }
  sent();
  ctx.guards.recordProgress();
  return ok(`Sent the approved ${which === 'resume' ? 'resume' : 'cover letter'}. Check the page shows the file and no upload error.`);
}

/**
 * Runs the agent's own JavaScript in the page — or, with a ref, with that
 * element as the function's argument, in whatever frame it lives. A model
 * reads the script first: one that would send the application goes through
 * the submit gate, one that would do anything no application needs is refused.
 */
async function evaluateScript(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const source = String(args.function ?? '').trim();
  if (!/^(async\s*)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|^(async\s+)?function\b/.test(source)) {
    return ok('function must be a JavaScript function, e.g. "() => document.title" or "(el) => el.value" with a ref.');
  }
  const ref = typeof args.ref === 'string' && args.ref ? args.ref : '';
  const target = ref ? locate(ctx.page, ref) : null;
  if (ref && !target) return ok('Give a ref from the observation or from take_snapshot.');

  let review: Awaited<ReturnType<typeof reviewBrowserScript>>;
  try {
    review = await reviewBrowserScript(source, { url: ctx.page.url(), title: ctx.observation.title, text: ctx.observation.text });
  } catch {
    return ok('The script could not be reviewed right now, so it was not run. Try again, or reach the control another way.');
  }
  if (review.unsafe) {
    ctx.log(`  ⛔ script refused: ${review.reason.slice(0, 160)}`);
    return ok(`Script refused: ${review.reason} Scripts may only read the page and operate its controls for this application.`);
  }
  ctx.log(`  ⌘ script: ${source.replace(/\s+/g, ' ').slice(0, 160)}`);
  ctx.rawUsed = true;
  return watched(ctx, `script: ${review.reason}`, async () => {
    if (review.sendsApplication) {
      const gate = await gateAdvance(ctx, review.reason || 'script submit', undefined, { knownSubmit: true });
      if (!gate.proceed) return gate.result;
    }
    const before = await surface(ctx.page);
    let value: unknown;
    try {
      // The page's own world, where its app state lives. The source is only
      // ever evaluated in the page, never in this process.
      const running = (async () => {
        if (!target) return ctx.page.evaluate(`(${source})()`, undefined, undefined, false);
        const element = await target.elementHandle({ timeout: 5_000 });
        const frame = await element.ownerFrame();
        if (!frame) throw new Error('that element is no longer in a frame');
        const fn = await frame.evaluateHandle(`(${source})`, undefined, undefined, false);
        try {
          return await fn.evaluate((f, el) => (f as unknown as (node: unknown) => unknown)(el), element);
        } finally {
          await fn.dispose().catch(() => {});
          await element.dispose().catch(() => {});
        }
      })();
      value = await Promise.race([
        running,
        new Promise((_, reject) => setTimeout(() => reject(new Error('the script ran for more than 20 seconds')), 20_000)),
      ]);
    } catch (error) {
      return ok(`Script error: ${(error as Error).message.split('\n')[0].slice(0, 300)}`);
    }
    let text: string;
    try { text = value === undefined ? 'undefined' : JSON.stringify(value); } catch { text = String(value); }
    const changed = await changedAfter(ctx.page, before, 2_000);
    return ok(`Script returned: <untrusted>${(text ?? 'undefined').slice(0, 6_000)}</untrusted>${changed ? '\nThe page changed.' : ''}`);
  });
}

async function navigatePage(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const type = String(args.type ?? 'url');
  if (type !== 'url' && ctx.submissionAttempted) {
    return ok('Not after a submit: going back or reloading can send the application again. Inspect the page as it is.');
  }
  if (type === 'back') {
    return watched(ctx, 'go back', async () => ok(await ctx.page.goBack({ timeout: 20_000 }).then(() => 'Went back.').catch(() => 'There is no earlier page in this tab.')));
  }
  if (type === 'forward') {
    return watched(ctx, 'go forward', async () => ok(await ctx.page.goForward({ timeout: 20_000 }).then(() => 'Went forward.').catch(() => 'There is no later page in this tab.')));
  }
  if (type === 'reload') {
    if (ctx.captured.length || ctx.resumeUsed || ctx.coverLetter) {
      return ok('Reload withheld: application data was entered and a reload would lose it. Recover on the page as it is.');
    }
    return watched(ctx, 'reload', async () => {
      await ctx.page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
      return ok('Reloaded.');
    });
  }
  let url: URL;
  try { url = new URL(String(args.url ?? ''), ctx.page.url()); } catch { return ok('Give a full http(s) URL.'); }
  if (!/^https?:$/.test(url.protocol)) return ok('Only http(s) pages can be opened.');
  if (isAustralianGovernmentUrl(url.href)) {
    return { kind: 'terminal', outcome: { status: 'skipped', reason: 'Australian government application sites are excluded.' } };
  }
  if (isForbiddenDestination(url.href)) return ok(`Refused: ${url.href} is somewhere this agent never goes.`);
  const email = ctx.profile.email?.toLowerCase();
  if (email && decodeURIComponent(url.href).toLowerCase().includes(email)) return ok('Refused: the address carries the candidate\'s email.');
  return watched(ctx, `open ${url.host}`, async () => {
    await ctx.page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    return ok(`Opened ${ctx.page.url()}.`);
  });
}

async function listPages(ctx: ToolContext): Promise<ToolResult> {
  const tabs = ctx.page.context().pages().filter((tab) => !tab.isClosed());
  const lines = await Promise.all(tabs.map(async (tab, index) =>
    `${index + 1}. ${tab === ctx.page ? '(current) ' : ''}${(await tab.title().catch(() => '')).slice(0, 80)} — ${tab.url()}`));
  return ok(`Open tabs:\n${lines.join('\n')}`);
}

async function selectPage(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const tabs = ctx.page.context().pages().filter((tab) => !tab.isClosed());
  const tab = tabs[Number(args.index) - 1];
  if (!tab) return ok(`No tab ${String(args.index)}. Call list_pages.`);
  if (args.close === true) {
    if (tab === ctx.page) return ok('The current tab holds the application; select another tab before closing this one.');
    await tab.close().catch(() => {});
    return ok(`Closed tab ${String(args.index)}.`);
  }
  ctx.page = tab;
  await tab.bringToFront().catch(() => {});
  return ok(`Switched to tab ${String(args.index)}: ${tab.url()}. A fresh observation of it follows.`);
}

async function waitFor(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const text = String(args.text ?? '').trim().toLowerCase();
  if (!text) return ok('Give the text to wait for.');
  const deadline = Date.now() + Math.min(Math.max(Number(args.seconds) || 10, 1), 30) * 1_000;
  while (Date.now() < deadline) {
    for (const frame of ctx.page.frames()) {
      const body = await frame.evaluate(() => document.body?.innerText ?? '').catch(() => '');
      if (body.toLowerCase().includes(text)) return ok(`"${String(args.text)}" is on the page.`);
    }
    await ctx.page.waitForTimeout(500).catch(() => {});
  }
  return ok(`"${String(args.text)}" did not appear.`);
}

async function getDiagnostics(ctx: ToolContext): Promise<ToolResult> {
  const lines = ctx.diagnostics?.get(ctx.page) ?? [];
  return ok(lines.length
    ? `Recent failed requests and console errors on this tab (newest last):\n<untrusted>\n${lines.slice(-30).join('\n')}\n</untrusted>`
    : 'No failed requests or console errors recorded on this tab.');
}

/**
 * What every tab the agent works in needs from the start: its dialogs
 * answered — an unanswered alert freezes the page, and the browser's own
 * default dismisses the "Submit your application?" confirm — and a record of
 * failed requests and console errors for get_diagnostics.
 */
export function watchTab(page: Page, ctx: ToolContext): void {
  const diagnostics = (ctx.diagnostics ??= new WeakMap());
  if (diagnostics.has(page)) return;
  const lines: string[] = [];
  diagnostics.set(page, lines);
  const note = (line: string) => {
    lines.push(line.slice(0, 300));
    if (lines.length > 60) lines.shift();
  };
  page.on('response', (response) => {
    if (response.status() >= 400 && ['xhr', 'fetch', 'document'].includes(response.request().resourceType())) {
      note(`${response.status()} ${response.request().method()} ${response.url().split('?')[0]}`);
    }
  });
  page.on('requestfailed', (request) => {
    if (['xhr', 'fetch', 'document'].includes(request.resourceType())) note(`failed ${request.method()} ${request.url().split('?')[0]}: ${request.failure()?.errorText ?? ''}`);
  });
  page.on('console', (message) => { if (message.type() === 'error') note(`console: ${message.text()}`); });
  page.on('pageerror', (error) => note(`page error: ${error.message}`));
  page.on('dialog', (dialog: Dialog) => void answerDialog(dialog, ctx));
}

async function answerDialog(dialog: Dialog, ctx: ToolContext): Promise<void> {
  const type = dialog.type();
  const message = dialog.message();
  let accept = type === 'alert';
  if (type === 'confirm' || type === 'beforeunload') {
    accept = await acceptBrowserDialog({ type, message }, ctx.lastActionLabel ?? 'none').catch(() => false);
  }
  await (accept ? dialog.accept() : dialog.dismiss()).catch(() => {});
  (ctx.dialogs ??= []).push(`The site showed a ${type} dialog: "${message.slice(0, 300)}" — ${accept ? 'accepted' : 'dismissed'}.`);
  ctx.log(`  · ${type} dialog ${accept ? 'accepted' : 'dismissed'}: ${message.slice(0, 100)}`);
}

export const RAW_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'take_snapshot',
    description:
      'The whole tab as an accessibility tree, iframes included, with refs (e12; f1e3 inside an iframe) usable by the browser tools. ' +
      'Use it when a control is missing from the observation, the form is embedded in an iframe, or a widget will not respond. Pass ref to see one section in full.',
    parameters: { type: 'object', properties: { ref: { type: 'string', description: 'Optional: a snapshot ref to see just that section.' } }, required: [] },
  },
  {
    name: 'click_element',
    description:
      'Click any element by ref (observation or snapshot), in any frame. Submitting passes the same checks as click. ' +
      'Prefer click for observation ACTIONS and choose_option for options it lists.',
    parameters: {
      type: 'object',
      properties: { ref: { type: 'string' }, double_click: { type: 'boolean' } },
      required: ['ref'],
    },
  },
  {
    name: 'fill_element',
    description:
      'Enter a value in an input, textarea, select or editable element by ref, in any frame. Omit value to have the candidate\'s verified record answer it ' +
      '(like answer_questions, for fields the observation does not list or could not fill). Pass value only for search text or a value an answer tool already returned. ' +
      'Never invent candidate facts: the form is checked against the candidate\'s record before it is sent.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        value: { type: 'string', description: 'Exact text or option label. Omit for a grounded answer.' },
        context: { type: 'string', description: 'The question as the page words it, when the element\'s own label is unclear.' },
      },
      required: ['ref'],
    },
  },
  {
    name: 'type_text',
    description: 'Type text into the focused element with real keystrokes, for widgets that ignore filled values (search-as-you-type, masked dates). Click the element first.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'hover',
    description: 'Hover over an element by ref, to reveal a menu or tooltip.',
    parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] },
  },
  {
    name: 'drag',
    description: 'Drag one element onto another, by refs (sliders, ranking lists, drop zones).',
    parameters: { type: 'object', properties: { from_ref: { type: 'string' }, to_ref: { type: 'string' } }, required: ['from_ref', 'to_ref'] },
  },
  {
    name: 'upload_file',
    description:
      'Send the candidate\'s approved resume or the grounded cover letter to an upload: its file input, or any button that opens a file picker (drop zones, "Upload from device"). ' +
      'Only these documents can be sent.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        document: { type: 'string', enum: ['resume', 'cover_letter'] },
        format: { type: 'string', enum: ['pdf', 'docx', 'doc', 'rtf', 'txt'], description: 'Only when the page names the accepted file types.' },
      },
      required: ['ref', 'document'],
    },
  },
  {
    name: 'evaluate_script',
    description:
      'Run a JavaScript function in the page and get its JSON result: "() => ..." for the page, or "(el) => ..." with ref to receive that element (in its own frame). ' +
      'For reading hidden state or driving a control no other tool can operate. Keep it short and specific to this application; scripts are reviewed first and any that sends data elsewhere is refused. ' +
      'Never use it to write candidate answers — use answer_questions or fill_element.',
    parameters: {
      type: 'object',
      properties: { function: { type: 'string' }, ref: { type: 'string', description: 'Optional element passed as the first argument.' } },
      required: ['function'],
    },
  },
  {
    name: 'navigate_page',
    description: 'Open a URL in this tab, or go back, forward or reload. Back and reload are refused after a submit (they can send it twice) and reload after data was entered.',
    parameters: {
      type: 'object',
      properties: { type: { type: 'string', enum: ['url', 'back', 'forward', 'reload'] }, url: { type: 'string' } },
      required: ['type'],
    },
  },
  {
    name: 'list_pages',
    description: 'List the open tabs.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'select_page',
    description: 'Work in another open tab (1-based index from list_pages), or close one with close: true.',
    parameters: { type: 'object', properties: { index: { type: 'number' }, close: { type: 'boolean' } }, required: ['index'] },
  },
  {
    name: 'wait_for',
    description: 'Wait until some text appears anywhere in the tab, iframes included (up to 30 seconds).',
    parameters: { type: 'object', properties: { text: { type: 'string' }, seconds: { type: 'number' } }, required: ['text'] },
  },
  {
    name: 'take_screenshot',
    description: 'See the page: the next observation comes with a screenshot.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_diagnostics',
    description: 'Failed network requests and console errors on this tab — use when a submit or a step does nothing and the page shows no reason.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];

/** Runs a general browser tool, or returns null when the name is not one. */
export async function runRawTool(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<ToolResult | null> {
  switch (name) {
    case 'take_snapshot': return takeSnapshot(ctx, args);
    case 'click_element': return clickElement(ctx, args);
    case 'fill_element': return fillElement(ctx, args);
    case 'type_text': return typeText(ctx, args);
    case 'hover': return hover(ctx, args);
    case 'drag': return drag(ctx, args);
    case 'upload_file': return uploadFile(ctx, args);
    case 'evaluate_script': return evaluateScript(ctx, args);
    case 'navigate_page': return navigatePage(ctx, args);
    case 'list_pages': return listPages(ctx);
    case 'select_page': return selectPage(ctx, args);
    case 'wait_for': return waitFor(ctx, args);
    case 'take_screenshot':
      ctx.wantScreenshot = true;
      return ok('A screenshot comes with the next observation.');
    case 'get_diagnostics': return getDiagnostics(ctx);
    default: return null;
  }
}

/** Runs one keypress under the same watch as the other general tools; Enter on a form is a possible submit. */
export async function pressWatched(ctx: ToolContext, key: string, run: () => Promise<ToolResult>): Promise<ToolResult> {
  if (!/(^|\+)(Enter|NumpadEnter| |Space)$/.test(key)) return run();
  const focus = await ctx.page.evaluate(() => {
    let element: Element | null = document.activeElement;
    // Follow focus into same-origin frames.
    while (element instanceof HTMLIFrameElement && element.contentDocument?.activeElement) element = element.contentDocument.activeElement;
    if (!element || element === document.body) return null;
    const form = (element as HTMLInputElement).form ?? element.closest('form');
    const submitter = form?.querySelector('button[type="submit"], input[type="submit"], button:not([type])') as HTMLElement | null;
    const compact = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
    return {
      control: compact(element.getAttribute('aria-label') || (element as HTMLElement).innerText || element.getAttribute('name')).slice(0, 120),
      button: element.matches('button, [role="button"], input[type="submit"], a') ,
      submitter: submitter ? compact(submitter.innerText || (submitter as HTMLInputElement).value).slice(0, 120) : '',
    };
  }).catch(() => null);
  // A key that presses a button is that button; Enter in a field is the form's own submit.
  const label = focus?.button ? focus.control : focus?.submitter ?? '';
  return watched(ctx, `press ${key}${label ? ` on "${label}"` : ''}`, async () => {
    if (label) {
      const gate = await gateAdvance(ctx, label, focus?.button ? undefined : `Enter pressed in "${focus?.control ?? ''}"`);
      if (!gate.proceed) return gate.result;
    }
    return run();
  });
}
