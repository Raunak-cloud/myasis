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
export const CORPUS_DIR = (): string => process.env.FORM_CORPUS_DIR ?? resolve(config.dataDir, 'form-corpus');
const PER_PLATFORM = 25;

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

export function expectationOf(observation: Observation, captcha: boolean, url: string, capturedAt = new Date().toISOString()): FormExpectation {
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

const seen = new Set<string>();

/** Records this page into the corpus, once per distinct page; never fails an application. */
export async function recordFormPage(page: Page, observation: Observation): Promise<void> {
  try {
    if (!observation.fields.length) return;
    const url = page.url();
    const signature = signatureOf(url, observation);
    if (seen.has(signature)) return;
    seen.add(signature);
    const expectation = expectationOf(observation, await hasCaptchaSurface(page).catch(() => false), url);
    const dir = join(CORPUS_DIR(), expectation.platform.replace(/[^\w.-]+/g, '_'));
    if (existsSync(join(dir, `${signature}.json`))) return;
    const html = await snapshotPage(page);
    if (!html) return;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${signature}.html.gz`), gzipSync(html));
    writeFileSync(join(dir, `${signature}.json`), JSON.stringify(expectation, null, 2));
    prune(dir);
  } catch { /* the corpus is for testing; an application never waits on it */ }
}

/** The page as rendered, self-contained: form state written into the markup, stylesheets inlined, scripts gone. */
export async function snapshotPage(page: Page): Promise<string | null> {
  const captured = await page.evaluate(() => {
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
          if (element.type === 'checkbox' || element.type === 'radio') {
            if (element.checked) copy.setAttribute('checked', ''); else copy.removeAttribute('checked');
          } else if (element.type !== 'password' && element.type !== 'file') copy.setAttribute('value', element.value);
        } else if (element instanceof HTMLTextAreaElement) copy.textContent = element.value;
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
  }).catch(() => null);
  if (!captured) return null;
  /**
   * Every stylesheet's text, read from the browser itself rather than the
   * network: a sheet from another origin (Workday's CDN) cannot be read from
   * the page's script, and fetching it again may not reach the same file. The
   * browser already holds each one, in the order the page applies them.
   */
  const fetched = await stylesheetTexts(page).catch(() => [] as string[]);
  if (!fetched.length) {
    for (const href of captured.external.slice(0, 12)) {
      const css = await page.context().request.get(href, { timeout: 8_000 }).then((response) => (response.ok() ? response.text() : '')).catch(() => '');
      if (css) fetched.push(css);
    }
  } else captured.css = '';
  const style = `<style data-owt-snapshot>${[captured.css, ...fetched].join('\n').replace(/<\/style/gi, '<\\/style')}</style>`;
  return `<!doctype html>\n${captured.html.replace(/<head([^>]*)>/i, `<head$1>${style}`)}`;
}

/** The text of every stylesheet in the page's main document, as the browser holds it. */
async function stylesheetTexts(page: Page): Promise<string[]> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const sheets: Array<{ id: string; frameId: string }> = [];
    cdp.on('CSS.styleSheetAdded', (event: { header: { styleSheetId: string; frameId: string } }) => {
      sheets.push({ id: event.header.styleSheetId, frameId: event.header.frameId });
    });
    const tree = await cdp.send('Page.getFrameTree') as { frameTree: { frame: { id: string } } };
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    await page.waitForTimeout(150);
    const main = tree.frameTree.frame.id;
    const texts = await Promise.all(sheets.filter((sheet) => sheet.frameId === main).map((sheet) =>
      (cdp.send('CSS.getStyleSheetText', { styleSheetId: sheet.id }) as Promise<{ text: string }>).then((reply) => reply.text).catch(() => '')));
    await cdp.send('CSS.disable').catch(() => {});
    return texts.filter(Boolean);
  } finally {
    await cdp.detach().catch(() => {});
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
