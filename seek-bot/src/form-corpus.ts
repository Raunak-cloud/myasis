import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import type { Page } from 'patchright';
import { config } from './config.js';
import type { Observation } from './agent/observe.js';
import { offersCoverLetter } from './agent/cover-letter-opportunity.js';
import { hasCaptchaSurface } from './captcha/detect.js';
import { platformOf } from './agent/lessons.js';
import { preparePrivateAuthenticationFields, privateAuthenticationValues, redactPrivateAuthenticationText } from './private-auth-fields.js';

/**
 * A corpus of real employer form pages, recorded as the agent meets them and
 * replayed after every change (form-replay.ts), so a change that breaks how a
 * real Workday, Oracle or LiveHire page is read is caught before a live run.
 *
 * Each page is kept once: the rendered document with its form state (values,
 * checks, selections) and its stylesheets inlined, scripts removed, so it
 * renders the same offline; and what the code of the day read from it (the
 * fields, actions, whether it offers a letter, whether a security check is
 * showing). Stored with the account's data, since the pages hold the
 * candidate's own details as typed into the form; capped per platform.
 *
 * Not kept: open shadow roots and iframe contents (the snapshot is the main
 * document), and anything the page's scripts would do on interaction. Replay
 * checks how a page is read, not how its widgets behave.
 */
const CORPUS_DIR = (): string => process.env.FORM_CORPUS_DIR ?? resolve(config.dataDir, 'form-corpus');
const PER_PLATFORM = 25;
const CAPTURE_BUDGET_MS = 2_000;

/** Optional diagnostics share one short deadline, including provider CDP calls. */
async function withinCapture<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([operation(), new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    })]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export interface FormExpectation {
  url: string;
  host: string;
  platform: string;
  capturedAt: string;
  fields: Array<{ label: string; kind: string; required: boolean; options: number }>;
  actions: string[];
  coverLetterOffered: boolean;
  captcha: boolean;
}

/** Remote child-frame documents are not part of the saved HTML. Keep its
 * expectation equally scoped; dedicated live browser fixtures cover frames. */
function mainDocumentObservation(observation: Observation): Observation {
  if (!observation.frames?.length) return observation;
  return { ...observation,
    fields: observation.fields.filter(field => !/^frame\d+:/.test(field.ref)),
    actions: observation.actions.filter(action => !/^frame\d+:/.test(action.ref)),
    text: observation.mainDocumentText ?? observation.text,
  };
}

export function expectationOf(observation: Observation, captcha: boolean, url: string, capturedAt = new Date().toISOString()): FormExpectation {
  observation = mainDocumentObservation(observation);
  const host = new URL(url).hostname.toLowerCase();
  return {
    url,
    host,
    platform: platformOf(host),
    capturedAt,
    fields: observation.fields.map((field) => ({ label: field.label, kind: field.kind, required: field.required, options: field.options?.length ?? 0 })),
    actions: observation.actions.map((action) => action.text.slice(0, 80)),
    coverLetterOffered: offersCoverLetter(observation),
    captcha,
  };
}

/** The same page, whatever the values typed into it: its address and the shape of its form. */
function signatureOf(url: string, observation: Observation): string {
  const { hostname, pathname } = new URL(url);
  const shape = observation.fields.map((field) => `${field.kind}:${field.label}`).sort().join('|');
  return createHash('sha256').update(`${hostname}${pathname.replace(/\d{4,}/g, '#')}\n${shape}`).digest('hex').slice(0, 16);
}

/** Attempts per distinct page this run; a page caught mid-change is tried again on a later turn, a few times at most. */
const attempts = new Map<string, number>();
const MAX_ATTEMPTS = 3;

/**
 * Whether every field the observation read is still in the page and still
 * shown, after the snapshot was taken.
 *
 * The expectation comes from the observation and the snapshot is taken a
 * moment later. On a page still changing — Workday swapping its sign-in and
 * create-account dialogs — the two disagreed: the observation held both
 * dialogs' fields, the snapshot only one, and every replay of that page then
 * reported fields "no longer found" that the code had never lost. A page
 * whose fields went away in between is not recorded this time.
 *
 * Shown is judged the way field extraction judges it: the control itself, a
 * label of it, or the widget box around it has a size and is not hidden.
 */
async function fieldsStillShown(page: Page, observation: Observation): Promise<boolean> {
  const refs = observation.fields.map((field) => field.ref);
  return page.evaluate((wanted: string[]) => {
    const shown = (element: Element | null): boolean => {
      if (!element) return false;
      const style = getComputedStyle(element);
      return element.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const found = new Map<string, boolean>();
    const roots: Array<Document | ShadowRoot> = [document];
    for (let i = 0; i < roots.length; i++) {
      for (const element of roots[i].querySelectorAll('*')) {
        if (element.shadowRoot) roots.push(element.shadowRoot);
        const stamp = element.getAttribute('data-field-id');
        if (!stamp) continue;
        const ref = stamp.split(':')[0];
        const input = element as HTMLInputElement;
        const labels = [...(input.labels ?? [])];
        let widget: Element | null = element.parentElement;
        for (let depth = 0; widget && depth < 3; depth++) {
          const style = getComputedStyle(widget);
          if (style.display === 'none' || style.visibility === 'hidden' || style.contentVisibility === 'hidden') {
            widget = null;
            break;
          }
          if (shown(widget)) break;
          widget = widget.parentElement;
        }
        // Match extractFields: a visible parent cannot resurrect a conditional
        // text/select control that disappeared after the observation.
        const visible = shown(element)
          || /^(radio|checkbox)$/.test(input.type) && labels.some((label) => shown(label))
          || (element.getAttribute('role') === 'combobox' || element.hasAttribute('aria-haspopup')) && shown(widget);
        found.set(ref, Boolean(found.get(ref)) || visible);
      }
    }
    return wanted.every((ref) => found.get(ref) === true);
  }, refs).catch(() => false);
}

/** Records this page into the corpus, once per distinct page; never fails an application. */
export async function recordFormPage(page: Page, observation: Observation): Promise<void> {
  try {
    observation = mainDocumentObservation(observation);
    const signal = AbortSignal.timeout(CAPTURE_BUDGET_MS);
    if (!observation.fields.length) return;
    const url = page.url();
    const signature = signatureOf(url, observation);
    const tried = attempts.get(signature) ?? 0;
    if (tried >= MAX_ATTEMPTS) return;
    attempts.set(signature, tried + 1);
    const expectation = expectationOf(observation, await withinCapture(signal, () => hasCaptchaSurface(page)), url);
    const dir = join(CORPUS_DIR(), expectation.platform.replace(/[^\w.-]+/g, '_'));
    if (existsSync(join(dir, `${signature}.json`))) {
      attempts.set(signature, MAX_ATTEMPTS);
      return;
    }
    const html = await snapshotPage(page, signal);
    if (!html || !(await withinCapture(signal, () => fieldsStillShown(page, observation)))) return;
    signal.throwIfAborted();
    attempts.set(signature, MAX_ATTEMPTS);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${signature}.html.gz`), gzipSync(html));
    writeFileSync(join(dir, `${signature}.json`), JSON.stringify(expectation, null, 2));
    prune(dir);
  } catch { /* Best-effort diagnostics stop at their short capture deadline. */ }
}

/** The page as rendered, self-contained: form state written into the markup, stylesheets inlined, scripts gone. */
async function snapshotPage(page: Page, signal: AbortSignal): Promise<string | null> {
  await withinCapture(signal, () => preparePrivateAuthenticationFields(page));
  const privateValues = await withinCapture(signal, () => privateAuthenticationValues(page));
  const captured = await withinCapture(signal, () => page.evaluate(() => {
    const clone = document.documentElement.cloneNode(true) as HTMLElement;
    /**
     * Each element of the copy gets what the live one shows but its markup
     * does not: the value typed, the box checked, the option chosen, whether
     * it is hidden (a field behind a collapsed section, a dialog not yet open;
     * a stylesheet may not be recoverable offline). Open shadow roots are
     * copied in too, as declarative shadow DOM: chat widgets and some form
     * components (Paradox's assistant on Nestlé's page) live in one, and the
     * observation reads them.
     */
    const bake = (liveRoot: ParentNode, copyRoot: ParentNode): void => {
      const live = [...liveRoot.querySelectorAll('*')];
      const copied = [...copyRoot.querySelectorAll('*')];
      live.forEach((element, index) => {
        const copy = copied[index];
        if (!copy) return;
        if (element instanceof HTMLInputElement) {
          if (element.hasAttribute('data-owtomate-private-auth')) copy.removeAttribute('value');
          else if (element.type === 'checkbox' || element.type === 'radio') {
            if (element.checked) copy.setAttribute('checked', ''); else copy.removeAttribute('checked');
          } else if (element.type !== 'password' && element.type !== 'file') copy.setAttribute('value', element.value);
        } else if (element instanceof HTMLTextAreaElement) copy.textContent = element.hasAttribute('data-owtomate-private-auth') ? '' : element.value;
        else if (element instanceof HTMLOptionElement) {
          if (element.selected) copy.setAttribute('selected', ''); else copy.removeAttribute('selected');
        }
        if (element instanceof HTMLElement || element instanceof SVGElement) {
          const style = getComputedStyle(element);
          const baked = [
            style.display === 'none' ? 'display:none !important' : '',
            style.visibility === 'hidden' ? 'visibility:hidden !important' : '',
            style.opacity === '0' ? 'opacity:0 !important' : '',
          ].filter(Boolean).join(';');
          if (baked) copy.setAttribute('style', `${copy.getAttribute('style') ?? ''};${baked}`);
        }
        const shadow = element.shadowRoot;
        if (shadow) {
          const holder = document.createElement('div');
          shadow.childNodes.forEach((node) => holder.appendChild(node.cloneNode(true)));
          bake(shadow, holder);
          holder.querySelectorAll('script').forEach((node) => node.remove());
          const template = document.createElement('template');
          template.setAttribute('shadowrootmode', 'open');
          template.innerHTML = holder.innerHTML;
          copy.insertBefore(template, copy.firstChild);
        }
      });
    };
    bake(document.documentElement, clone);
    clone.querySelectorAll('script, noscript, link[rel="preload"], link[rel="modulepreload"]').forEach((node) => node.remove());
    const rules: string[] = [];
    const external: string[] = [];
    for (const sheet of [...document.styleSheets]) {
      try { rules.push([...sheet.cssRules].map((rule) => rule.cssText).join('\n')); }
      catch { if (sheet.href) external.push(sheet.href); }
    }
    clone.querySelectorAll('link[rel="stylesheet"], style').forEach((node) => node.remove());
    return { html: clone.outerHTML, css: rules.join('\n'), external };
  })).catch(() => null);
  if (!captured) return null;
  /**
   * Every stylesheet's text, read from the browser itself rather than the
   * network: a sheet from another origin (Workday's CDN) cannot be read from
   * the page's script, and fetching it again may not reach the same file. The
   * browser already holds each one, in the order the page applies them.
   */
  const fetched = await stylesheetTexts(page, signal).catch(() => [] as string[]);
  signal.throwIfAborted();
  if (!fetched.length) {
    for (const href of captured.external.slice(0, 12)) {
      const css = await withinCapture(signal, () => page.context().request.get(href, { timeout: CAPTURE_BUDGET_MS })
        .then((response) => (response.ok() ? response.text() : ''))).catch(() => '');
      signal.throwIfAborted();
      if (css) fetched.push(css);
    }
  } else captured.css = '';
  const style = `<style data-owt-snapshot>${[captured.css, ...fetched].join('\n').replace(/<\/style/gi, '<\\/style')}</style>`;
  return redactPrivateAuthenticationText(`<!doctype html>\n${captured.html.replace(/<head([^>]*)>/i, `<head$1>${style}`)}`, privateValues);
}

/** The text of every stylesheet in the page's main document, as the browser holds it. */
async function stylesheetTexts(page: Page, signal: AbortSignal): Promise<string[]> {
  const cdp = await withinCapture(signal, () => page.context().newCDPSession(page).then(session => {
    // A session created after the deadline still belongs to this collector.
    if (signal.aborted) void session.detach().catch(() => {});
    return session;
  }));
  try {
    const sheets: Array<{ id: string; frameId: string }> = [];
    cdp.on('CSS.styleSheetAdded', (event: { header: { styleSheetId: string; frameId: string } }) => {
      sheets.push({ id: event.header.styleSheetId, frameId: event.header.frameId });
    });
    const tree = await withinCapture(signal, () => cdp.send('Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
    await withinCapture(signal, () => cdp.send('DOM.enable'));
    await withinCapture(signal, () => cdp.send('CSS.enable'));
    await withinCapture(signal, () => page.waitForTimeout(150));
    const main = tree.frameTree.frame.id;
    const texts = await Promise.all(sheets.filter((sheet) => sheet.frameId === main).map((sheet) =>
      withinCapture(signal, () => cdp.send('CSS.getStyleSheetText', { styleSheetId: sheet.id }) as Promise<{ text: string }>).then((reply) => reply.text).catch(() => '')));
    await withinCapture(signal, () => cdp.send('CSS.disable')).catch(() => {});
    return texts.filter(Boolean);
  } finally {
    // Detach is best effort; an unresponsive provider must not hold the form.
    const detached = cdp.detach().catch(() => {});
    if (!signal.aborted) await withinCapture(signal, () => detached).catch(() => {});
  }
}

/** Keeps the most recent pages per platform. */
function prune(dir: string): void {
  const pages = readdirSync(dir).filter((name) => name.endsWith('.json'))
    .map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const old of pages.slice(PER_PLATFORM)) {
    for (const file of [old.name, old.name.replace(/\.json$/, '.html.gz')]) {
      try { unlinkSync(join(dir, file)); } catch { /* already gone */ }
    }
  }
}

/** Every recorded page under these corpus directories. */
export function corpusPages(dirs: string[]): Array<{ json: string; html: string; expectation: FormExpectation }> {
  const pages: Array<{ json: string; html: string; expectation: FormExpectation }> = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.json') && existsSync(path.replace(/\.json$/, '.html.gz'))) {
        try {
          pages.push({ json: path, html: gunzipSync(readFileSync(path.replace(/\.json$/, '.html.gz'))).toString('utf8'), expectation: JSON.parse(readFileSync(path, 'utf8')) });
        } catch { /* an unreadable page is skipped and reported by its absence */ }
      }
    }
  };
  for (const dir of dirs) walk(dir);
  return pages;
}
