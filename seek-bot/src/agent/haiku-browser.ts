import type { BrowserContext, Download, ElementHandle, FileChooser, Frame, Locator, Page, Route } from 'patchright';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertLive } from '../tool-run.js';
import type { AgentTermination, ToolContext, ToolResult } from './tools/context.js';

/** The native provider owns these names and input shapes. No Magnus tool remapping. */
export const HAIKU_BROWSER_CONFIGS = {
  javascript_exec: { enabled: false }, read_console: { enabled: false }, read_network: { enabled: false },
  file_upload: { enabled: true },
};
export const HAIKU_BROWSER_BATCH_HALTED = 'Not executed: an earlier action in this turn failed.';
type TextBlock = { type: 'text'; text: string };
type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: 'image/png'; data: string } };
type Change = { type: 'tab_opened'; tab_id: string }
  | { type: 'download_started' | 'download_completed' | 'download_failed'; download_id: string; url: string; error?: string };
export interface HaikuBrowserState {
  type: 'browser_state';
  tabs: Array<{ tab_id: string; title: string; url: string; active?: true }>;
  state_changes?: Change[];
}
export type HaikuBrowserContent = TextBlock | ImageBlock | HaikuBrowserState;
export interface HaikuBrowserResult {
  content: HaikuBrowserContent[];
  is_error?: boolean;
  terminal?: AgentTermination;
  pageChanged?: boolean;
}
export interface HaikuBrowserTargetInfo {
  label: string; tag: string; type: string; currentValue?: string; editable: boolean; sensitive: boolean; href?: string;
}
export interface HaikuBrowserMutation {
  name: string; input: Record<string, unknown>; page: Page; locator?: Locator; targetInfo?: HaikuBrowserTargetInfo;
}
export interface HaikuBrowserOptions {
  ownerDataDir: string;
  /** Supplied by the application loop: grounding, advance/submit and account rules. */
  beforeMutation: (action: HaikuBrowserMutation) => Promise<ToolResult | void>;
  /** Injectable DNS only for offline fixtures. Production uses all resolver answers. */
  resolveHost?: (host: string) => Promise<string[]>;
}
interface NativeRef { page: Page; frame: Frame; handle: ElementHandle<Element>; }
interface RegisteredDocument { id: string; path: string; }
const text = (value: string): TextBlock => ({ type: 'text', text: value });
const clean = (value: string, max = 4096) => value.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, ' ').slice(0, max);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const optionalMembers = new Set(['javascript_exec', 'read_console', 'read_network']);
const tabMembers = new Set(['new_tab', 'list_tabs', 'switch_tab', 'close_tab']);
const mutations = new Set(['navigate', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'hover',
  'left_click_drag', 'left_mouse_down', 'left_mouse_up', 'mouse_move', 'scroll', 'scroll_to', 'type', 'key', 'hold_key',
  'form_input', 'file_upload', 'new_tab', 'switch_tab', 'close_tab']);
const memberKeys: Record<string, string[]> = {
  navigate: ['url'], screenshot: [], zoom: ['region'], left_click: ['target', 'modifiers'], right_click: ['target', 'modifiers'],
  middle_click: ['target', 'modifiers'], double_click: ['target', 'modifiers'], triple_click: ['target', 'modifiers'], hover: ['target', 'modifiers'],
  left_click_drag: ['from', 'target'], left_mouse_down: ['target'], left_mouse_up: ['target'], mouse_move: ['target'],
  scroll: ['target', 'scroll_direction', 'scroll_amount'], scroll_to: ['target'], type: ['text'], key: ['text', 'repeat'],
  hold_key: ['text', 'duration'], wait: ['duration'], read_page: ['filter', 'depth', 'ref'], find: ['query'], get_page_text: [],
  form_input: ['target', 'value'], file_upload: ['target', 'paths', 'document_ids'], new_tab: [], list_tabs: [], switch_tab: [], close_tab: [],
};

function publicAddress(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(value) === 4) {
    const [a, b, c] = value.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31
      || a === 192 && (b === 168 || b === 0 || b === 2) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19)
      || a === 198 && b === 51 && c === 100 || a === 203 && b === 0 && c === 113);
  }
  if (isIP(value) !== 6) return false;
  // Only global unicast; exclude documentation/transition ranges and mapped private IPv4.
  return /^[23]/.test(value) && !value.startsWith('2001:db8:') && !value.startsWith('2002:');
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'about:' && url.pathname === 'blank') return 'about:blank';
    if (!['http:', 'https:'].includes(url.protocol)) return '[unsupported URL]';
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return clean(url.href);
  } catch { return '[unavailable URL]'; }
}

class WithheldMutation extends Error {
  constructor(readonly result: ToolResult) { super('The application guard withheld this browser action.'); }
}

/** Native Browser Use executor. Fixed implementation scripts read browser state;
 * model-authored JavaScript, arbitrary local files and unguarded mutations are unavailable. */
export class HaikuBrowserExecutor {
  private readonly context: BrowserContext;
  private readonly ownerRoot: string;
  private readonly attribute = `data-haiku-${randomUUID().replace(/-/g, '')}`;
  private readonly refs = new Map<string, NativeRef>();
  private readonly tabs = new Map<Page, string>();
  private readonly documents = new Map<string, RegisteredDocument>();
  private readonly pendingChanges = new Map<string, Change>();
  private readonly listeners = new Map<Page, { navigation: (frame: Frame) => void; download: (download: Download) => void; filechooser: (chooser: FileChooser) => void }>();
  private readonly pendingChoosers = new Map<Page, Array<Promise<string>>>();
  private readonly ready: Promise<void>;
  private readonly resolver: (host: string) => Promise<string[]>;
  private refSequence = 0;
  private tabSequence = 0;
  private downloadSequence = 0;
  private active: Page;

  constructor(private readonly ctx: ToolContext, private readonly options: HaikuBrowserOptions) {
    if (typeof options.beforeMutation !== 'function') throw new Error('Native browser mutations require an application guard.');
    this.ownerRoot = realpathSync(resolve(options.ownerDataDir));
    if (!statSync(this.ownerRoot).isDirectory()) throw new Error('The account document directory is unavailable.');
    this.context = ctx.page.context(); this.active = ctx.page;
    this.resolver = options.resolveHost ?? (async host => (await lookup(host, { all: true, verbatim: true })).map(item => item.address));
    for (const page of this.context.pages()) this.track(page);
    this.context.on('page', this.onPage);
    this.ready = this.context.route('**/*', this.networkGuard).then(() => {});
  }

  private readonly onPage = (page: Page) => { this.track(page); this.pendingChanges.set(`tab:${this.tabs.get(page)}`, { type: 'tab_opened', tab_id: this.tabs.get(page)! }); };
  private readonly networkGuard = async (route: Route) => {
    try {
      const request = route.request(), value = request.url();
      if (!/^https?:/i.test(value)) return await route.fallback();
      await this.publicUrl(value);
      return await route.fallback();
    } catch { await route.abort('blockedbyclient').catch(() => {}); }
  };

  async publicUrl(value: string): Promise<string> {
    let url: URL;
    try { url = new URL(/^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`); }
    catch { throw new Error('Navigation refused: invalid URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Navigation refused: only http and https URLs without embedded credentials are allowed.');
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || !host.includes('.') && !isIP(host)) throw new Error('Navigation refused: private or local destinations are unavailable.');
    const addresses = isIP(host) ? [host] : await this.resolver(host).catch(() => []);
    if (!addresses.length || addresses.some(address => !publicAddress(address))) throw new Error('Navigation refused: the destination does not resolve exclusively to public addresses.');
    return url.href;
  }

  registerDocument(id: string, path: string): RegisteredDocument {
    if (!id || id.length > 256 || /[\x00-\x1f]/.test(id)) throw new Error('Invalid staged document identifier.');
    const file = this.ownedFile(path);
    const document = { id, path: file }; this.documents.set(id, document); return document;
  }
  private ownedFile(path: string): string {
    const file = realpathSync(isAbsolute(path) ? path : resolve(this.ownerRoot, path));
    const inside = relative(this.ownerRoot, file);
    if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside) || !statSync(file).isFile()) throw new Error('Only staged documents inside this account directory may be uploaded.');
    return file;
  }

  private track(page: Page): void {
    if (this.tabs.has(page)) return;
    if (this.tabs.size >= 100) throw new Error('The native browser tab limit was reached.');
    this.tabs.set(page, `tab-${++this.tabSequence}`);
    const navigation = (frame: Frame) => { this.pendingChoosers.delete(page); for (const [ref, item] of this.refs) if (item.page === page && (frame === page.mainFrame() || item.frame === frame)) { this.refs.delete(ref); void item.handle.dispose().catch(() => {}); } };
    const download = (item: Download) => {
      const id = `download-${++this.downloadSequence}`, url = safeUrl(item.url());
      this.pendingChanges.set(id, { type: 'download_started', download_id: id, url });
      // Downloads are reported but never become uploadable task documents.
      void item.failure().then(error => this.pendingChanges.set(id, error
        ? { type: 'download_failed', download_id: id, url, error: clean(error) }
        : { type: 'download_completed', download_id: id, url })).catch(() => {});
    };
    const filechooser = (chooser: FileChooser) => {
      const queue = this.pendingChoosers.get(page) ?? [];
      if (queue.length >= 10) return;
      // A real chooser event is the provenance for this otherwise hidden input.
      // No upload occurs until a separate guarded native file_upload call.
      queue.push(this.remember(chooser.element() as ElementHandle<Element>, page).then(ref => `File chooser opened for actual file input [${ref}]. Use file_upload with registered document_ids.`).catch(() => 'The file chooser is no longer available. Reopen it before uploading.'));
      this.pendingChoosers.set(page, queue);
    };
    page.on('framenavigated', navigation); page.on('download', download); page.on('filechooser', filechooser); this.listeners.set(page, { navigation, download, filechooser });
  }

  private page(input: Record<string, unknown>): Page {
    const id = input.tab_id;
    if (id !== undefined && (typeof id !== 'string' || !id || id.length > 4096 || clean(id) !== id)) throw new Error('Invalid tab_id.');
    const page = id === undefined ? this.active : [...this.tabs].find(([tab, tabId]) => tabId === id && !tab.isClosed())?.[0];
    if (!page || page.isClosed()) throw new Error('The requested tab is not open. Use list_tabs.');
    this.ctx.page = page; return page;
  }
  private async state(): Promise<HaikuBrowserState> {
    const pages = this.context.pages().filter(page => !page.isClosed());
    for (const page of pages) this.track(page);
    if (!pages.includes(this.active) && pages.length) this.active = pages[0];
    if (!this.active.isClosed()) this.ctx.page = this.active;
    const tabs = await Promise.all(pages.map(async page => ({ tab_id: this.tabs.get(page)!, title: clean(await this.visibleText(page, await page.title().catch(() => ''))), url: safeUrl(page.url()), ...(page === this.active ? { active: true as const } : {}) })));
    const changes = [...this.pendingChanges.values()].filter(change => change.type !== 'tab_opened' || tabs.some(tab => tab.tab_id === change.tab_id));
    this.pendingChanges.clear();
    return { type: 'browser_state', tabs, ...(changes.length ? { state_changes: changes } : {}) };
  }

  private async target(ref: unknown, page: Page): Promise<Locator> {
    if (typeof ref !== 'string' || !/^ref_\d+$/.test(ref)) throw new Error('Use a current native ref from read_page or find.');
    const item = this.refs.get(ref);
    if (!item || item.page !== page || !await item.handle.evaluate(el => el.isConnected).catch(() => false)) throw new Error(`${ref} is stale or not found on the current page. Re-read the page to get fresh references.`);
    const locator = item.frame.locator(`[${this.attribute}="${ref}"]`);
    if (await locator.count() !== 1 || !await locator.evaluate((el, held) => el === held, item.handle).catch(() => false)) throw new Error(`${ref} is stale or not found on the current page. Re-read the page to get fresh references.`);
    return locator;
  }
  private async remember(handle: ElementHandle<Element>, page: Page): Promise<string> {
    if (!await handle.evaluate(el => el.isConnected).catch(() => false)) { await handle.dispose(); throw new Error('The element is no longer in this tab.'); }
    const existing = await handle.getAttribute(this.attribute);
    const prior = existing ? this.refs.get(existing) : undefined;
    if (prior?.page === page && await prior.handle.evaluate((el, candidate) => el === candidate, handle).catch(() => false)) { await handle.dispose(); return existing!; }
    const ref = `ref_${++this.refSequence}`, frame = await handle.ownerFrame();
    if (!frame) throw new Error('The element is no longer in this tab.');
    await handle.evaluate((el, data) => el.setAttribute(data.attribute, data.ref), { attribute: this.attribute, ref });
    this.refs.set(ref, { page, frame, handle }); return ref;
  }
  private async info(locator: Locator): Promise<HaikuBrowserTargetInfo> {
    return locator.evaluate(el => {
      const input = el as HTMLInputElement;
      const label = el.getAttribute('aria-label') || [...(input.labels ?? [])].map(item => item.getClientRects().length && !['hidden', 'collapse'].includes(getComputedStyle(item).visibility) ? item.innerText : '').join(' ') || el.getAttribute('placeholder') || el.getAttribute('title') || (el as HTMLElement).innerText || el.tagName;
      const type = input.type || el.getAttribute('role') || '';
      const editable = el.matches('input,textarea,select,[contenteditable="true"],[role="textbox"],[role="combobox"]')
        && !(el.tagName === 'INPUT' && ['submit', 'button', 'reset', 'image', 'hidden'].includes(input.type));
      const sensitive = editable && /password|one[-_ ]?time|\botp\b|verification.?code|security.?code|authentication.?code|secret|token/i.test(`${type} ${label} ${input.autocomplete ?? ''} ${input.name ?? ''} ${input.id ?? ''}`);
      return { label: label.replace(/\s+/g, ' ').trim().slice(0, 500), tag: el.tagName.toLowerCase(), type, sensitive, editable,
        ...(!sensitive && 'value' in input ? { currentValue: input.type === 'checkbox' || input.type === 'radio' ? String(input.checked) : String(input.value) } : {}),
        ...(el.closest('a[href]') ? { href: (el.closest('a[href]') as HTMLAnchorElement).href } : {}) };
    });
  }

  private async point(value: unknown, page: Page): Promise<{ x: number; y: number }> {
    if (!record(value) || value.type !== 'coordinate' || !Number.isInteger(value.x) || !Number.isInteger(value.y)) throw new Error('A coordinate target requires integer viewport pixels.');
    const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    if (Number(value.x) < 0 || Number(value.y) < 0 || Number(value.x) >= size.width || Number(value.y) >= size.height) throw new Error('The coordinate is outside the current viewport.');
    return { x: Number(value.x), y: Number(value.y) };
  }
  private async resolveTarget(value: unknown, page: Page): Promise<{ locator?: Locator; point?: { x: number; y: number }; targetInfo?: HaikuBrowserTargetInfo }> {
    if (!record(value)) throw new Error('A native target object is required.');
    if (value.type === 'ref') { const locator = await this.target(value.ref, page); return { locator, targetInfo: await this.info(locator) }; }
    const point = await this.point(value, page);
    const marker = `point_${randomUUID().replace(/-/g, '')}`, pointAttribute = `${this.attribute}-point`;
    let frame = page.mainFrame(), local = point;
    let locator: Locator | undefined;
    for (let depth = 0; depth < 20; depth++) {
      const handle = await frame.evaluateHandle(({ x, y }) => document.elementFromPoint(x, y), local);
      const element = handle.asElement();
      if (!element) { await handle.dispose(); break; }
      const child = await element.contentFrame();
      if (child) {
        const box = await element.boundingBox(), border = await element.evaluate(el => ({ x: (el as HTMLElement).clientLeft, y: (el as HTMLElement).clientTop }));
        await handle.dispose();
        if (!box) break;
        local = { x: point.x - box.x - border.x, y: point.y - box.y - border.y }; frame = child; continue;
      }
      await element.evaluate((el, data) => (el.closest('button,a,input,textarea,select,label,[role],[contenteditable]') ?? el).setAttribute(data.attribute, data.marker), { attribute: pointAttribute, marker });
      await handle.dispose();
      locator = frame.locator(`[${pointAttribute}="${marker}"]`).first(); break;
    }
    return { point, locator, ...(locator ? { targetInfo: await this.info(locator) } : {}) };
  }
  private async focus(page: Page): Promise<Locator | undefined> {
    let frame = page.mainFrame();
    for (let depth = 0; depth < 20; depth++) {
      const handle = await frame.evaluateHandle(() => document.activeElement);
      const element = handle.asElement();
      if (!element) { await handle.dispose(); return undefined; }
      const child = await element.contentFrame();
      if (!child) {
        const attribute = `${this.attribute}-focus`, marker = randomUUID().replace(/-/g, '');
        await element.evaluate((el, data) => el.setAttribute(data.attribute, data.marker), { attribute, marker }); await handle.dispose();
        return frame.locator(`[${attribute}="${marker}"]`);
      }
      await handle.dispose();
      frame = child;
    }
    return undefined;
  }

  private async protectedValues(page: Page): Promise<string[]> {
    const values = await Promise.all(page.frames().map(frame => frame.evaluate(() => {
      const protectedValues: string[] = [];
      for (const el of document.querySelectorAll('input,textarea,[contenteditable="true"]')) {
        const input = el as HTMLInputElement;
        const label = el.getAttribute('aria-label') || [...(input.labels ?? [])].map(item => item.getClientRects().length && !['hidden', 'collapse'].includes(getComputedStyle(item).visibility) ? item.innerText : '').join(' ') || el.getAttribute('placeholder') || '';
        if (/password|one[-_ ]?time|\botp\b|verification.?code|security.?code|authentication.?code|secret|token/i.test(`${input.type ?? ''} ${label} ${input.autocomplete ?? ''} ${input.name ?? ''} ${input.id ?? ''}`)) {
          el.setAttribute('data-haiku-protected-field', 'true');
          const value = input.value ?? (el as HTMLElement).innerText;
          if (value) protectedValues.push(value);
        } else el.removeAttribute('data-haiku-protected-field');
      }
      return protectedValues;
    }).catch(() => [])));
    return [...new Set(values.flat())];
  }
  private async visibleText(page: Page, value: string): Promise<string> {
    let result = value;
    for (const secret of await this.protectedValues(page)) result = result.split(secret).join('[protected value]');
    return result.replace(/https?:\/\/[^\s"<>]+/gi, url => safeUrl(url));
  }

  private async read(page: Page, input: Record<string, unknown>): Promise<string> {
    if (input.filter !== undefined && !['all', 'interactive'].includes(String(input.filter))) throw new Error('read_page filter must be all or interactive.');
    const depth = input.depth === undefined ? 15 : Number(input.depth);
    if (!Number.isInteger(depth) || depth < 1 || depth > 100) throw new Error('read_page depth must be an integer from 1 to 100.');
    const scoped = input.ref === undefined ? null : await this.target(input.ref, page);
    const snapshot = scoped ? await scoped.ariaSnapshot({ mode: 'ai', depth, timeout: 10000 }) : await page.ariaSnapshot({ mode: 'ai', depth, timeout: 10000 });
    const lines: string[] = []; let clipped = false;
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    for (const line of snapshot.split('\n')) {
      const aria = /\[ref=([^\]]+)\]/.exec(line);
      if (!aria) { if (input.filter !== 'interactive') lines.push(line); continue; }
      const locator = page.locator(`aria-ref=${aria[1]}`);
      const handle = await locator.elementHandle({ timeout: 2000 }).catch(() => null);
      if (!handle) continue;
      const info = await this.info(locator).catch(() => null);
      if (!info) { await handle.dispose(); continue; }
      const box = await handle.boundingBox();
      if (input.filter !== 'all' && (!box || box.x + box.width <= 0 || box.y + box.height <= 0 || box.x >= viewport.width || box.y >= viewport.height)) { await handle.dispose(); continue; }
      if (input.filter === 'interactive' && !info.editable && !/^(button|a|select|summary)$/.test(info.tag) && !/button|link|checkbox|radio|option|switch|tab|menuitem/.test(info.type) && !(info.tag === 'input' && /^(submit|reset|image)$/.test(info.type))) { await handle.dispose(); continue; }
      const ref = await this.remember(handle as ElementHandle<Element>, page);
      lines.push(info.sensitive ? `${line.match(/^\s*/)?.[0] ?? ''}${info.tag} ${JSON.stringify(info.label)} [${ref}] [protected value]` : line.replace(aria[0], `[${ref}]`));
      if (lines.join('\n').length >= 49000) { clipped = true; break; }
    }
    const output = lines.join('\n');
    return await this.visibleText(page, output.slice(0, 49000)) + (clipped ? '\n[Output capped at 50,000 characters; narrow depth or supply ref.]' : '');
  }

  async execute(name: string, rawInput: unknown): Promise<HaikuBrowserResult> {
    await this.ready;
    const beforePage = this.ctx.page;
    try {
      assertLive();
      if (optionalMembers.has(name) || !memberKeys[name]) throw new Error(`${name} is not enabled in this environment.`);
      if (!record(rawInput)) throw new Error('Native browser input must be an object.');
      const input = rawInput;
      if (Object.keys(input).some(key => key !== 'tab_id' && !memberKeys[name].includes(key))) throw new Error(`Unexpected input for native ${name}.`);
      if (['switch_tab', 'close_tab'].includes(name) && input.tab_id === undefined) throw new Error('tab_id is required.');
      const page = name === 'new_tab' || name === 'list_tabs' ? this.active : this.page(input);
      if (!['new_tab', 'list_tabs', 'close_tab'].includes(name) && page.url() !== 'about:blank') await this.publicUrl(page.url());
      let resolved: Awaited<ReturnType<HaikuBrowserExecutor['resolveTarget']>> = {};
      if (input.target !== undefined) resolved = await this.resolveTarget(input.target, page);
      else if (['type', 'key', 'hold_key'].includes(name)) { resolved.locator = await this.focus(page); if (resolved.locator) resolved.targetInfo = await this.info(resolved.locator); }
      if (resolved.targetInfo?.href) await this.publicUrl(resolved.targetInfo.href);
      if (['form_input', 'type', 'file_upload', 'key', 'hold_key'].includes(name) && resolved.targetInfo?.sensitive) throw new Error('Protected credentials use the application authentication helper; their values were not read or changed.');
      if (mutations.has(name) && !['key', 'hold_key'].includes(name)) {
        assertLive();
        const decision = await this.options.beforeMutation({ name, input, page, locator: resolved.locator, targetInfo: resolved.targetInfo });
        if (decision) throw new WithheldMutation(decision);
        assertLive();
      }
      const content = await this.perform(name, input, page, resolved);
      // Flush browser-originated chooser events before composing this action's result.
      if (['left_click', 'double_click', 'triple_click', 'key'].includes(name) && !page.isClosed()) await page.evaluate(() => undefined).catch(() => {});
      const choosers = this.pendingChoosers.get(page); this.pendingChoosers.delete(page);
      if (choosers && !tabMembers.has(name)) content.push(...(await Promise.all(choosers)).map(text));
      // Redirects and site-created tabs are checked after completion as well as at the wire.
      for (const tab of this.context.pages()) if (!tab.isClosed() && tab.url() !== 'about:blank') await this.publicUrl(tab.url());
      const state = await this.state();
      return { content: tabMembers.has(name) ? [state] : [...content, state], pageChanged: beforePage !== this.ctx.page };
    } catch (error) {
      if (error instanceof WithheldMutation) return {
        content: [text(error.result.kind === 'ok' ? error.result.message : 'reason' in error.result.outcome ? error.result.outcome.reason : 'The application guard ended this attempt.')],
        is_error: true, ...(error.result.kind === 'terminal' ? { terminal: error.result.outcome } : {}),
      };
      return { content: [text(`Error: ${clean((error as Error).message, 1000)}`)], is_error: true };
    }
  }

  async executeBatch(calls: Array<{ id: string; name: string; input: unknown; toolset_name?: string }>): Promise<Array<HaikuBrowserResult & { tool_use_id: string; toolset_name: 'browser' }>> {
    const results: Array<HaikuBrowserResult & { tool_use_id: string; toolset_name: 'browser' }> = []; let failed = false;
    for (const call of calls) {
      const result: HaikuBrowserResult = failed ? { content: [text(HAIKU_BROWSER_BATCH_HALTED)], is_error: true } : call.toolset_name !== 'browser'
        ? { content: [text('Error: this executor accepts only the browser toolset namespace.')], is_error: true }
        : await this.execute(call.name, call.input);
      results.push({ ...result, tool_use_id: call.id, toolset_name: 'browser' }); failed ||= Boolean(result.is_error || result.terminal);
    }
    return results;
  }

  private async perform(name: string, input: Record<string, unknown>, page: Page, target: Awaited<ReturnType<HaikuBrowserExecutor['resolveTarget']>>): Promise<HaikuBrowserContent[]> {
    const literal = (key: string): string => { if (typeof input[key] !== 'string' || !String(input[key]).length) throw new Error(`${key} must be non-empty text.`); return String(input[key]); };
    const duration = () => { if (typeof input.duration !== 'number' || !Number.isFinite(input.duration) || input.duration < 0 || input.duration > 30) throw new Error('duration must be 0 to 30 seconds.'); return input.duration * 1000; };
    const locator = () => { if (!record(input.target) || input.target.type !== 'ref' || !target.locator) throw new Error(`${name} requires a native RefTarget.`); return target.locator; };
    if (name === 'navigate') {
      const value = literal('url');
      if (value === 'back') await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 });
      else if (value === 'forward') await page.goForward({ waitUntil: 'domcontentloaded', timeout: 20000 });
      else if (value === 'reload') { await this.publicUrl(page.url()); await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }); }
      else await page.goto(await this.publicUrl(value), { waitUntil: 'domcontentloaded', timeout: 20000 });
      return [text(`Navigated to ${safeUrl(page.url())}.`)];
    }
    if (name === 'read_page') return [text(await this.read(page, input))];
    if (name === 'find') {
      const query = literal('query').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
      const lines = (await this.read(page, { filter: 'all', depth: 30 })).split('\n').filter(line => /\[ref_\d+\]/.test(line));
      const ranked = lines.map((line, index) => ({ line, index, score: query.reduce((n, term) => n + Number(line.toLowerCase().includes(term)), 0) })).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 20);
      return [text(ranked.map(item => item.line).join('\n') || 'No matching accessible elements were found. Try read_page or screenshot.')];
    }
    if (name === 'get_page_text') return [text(await this.visibleText(page, (await page.locator('body').innerText({ timeout: 10000 })).slice(0, 50000)))];
    if (name === 'screenshot' || name === 'zoom') {
      await this.protectedValues(page);
      const masks = page.frames().map(frame => frame.locator('[data-haiku-protected-field="true"]'));
      let png = await page.screenshot({ type: 'png', fullPage: false, mask: masks, timeout: 10000 });
      if (name === 'zoom') {
        const region = input.region;
        if (!Array.isArray(region) || region.length !== 4 || !region.every(Number.isInteger)) throw new Error('zoom region must be [x0,y0,x1,y1] viewport pixels.');
        await this.point({ type: 'coordinate', x: region[0], y: region[1] }, page);
        await this.point({ type: 'coordinate', x: region[2] - 1, y: region[3] - 1 }, page);
        if (region[2] <= region[0] || region[3] <= region[1]) throw new Error('zoom region must have positive width and height.');
        const data = await page.evaluate(async ({ encoded, region }) => {
          const image = new Image(); image.src = `data:image/png;base64,${encoded}`; await image.decode();
          const width = region[2] - region[0], height = region[3] - region[1], factor = Math.min(2, 1568 / width, 1568 / height);
          const canvas = document.createElement('canvas'); canvas.width = Math.round(width * factor); canvas.height = Math.round(height * factor);
          canvas.getContext('2d')!.drawImage(image, region[0], region[1], width, height, 0, 0, canvas.width, canvas.height);
          return canvas.toDataURL('image/png').split(',')[1];
        }, { encoded: png.toString('base64'), region: region as number[] });
        png = Buffer.from(data, 'base64');
      }
      return [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } }];
    }
    if (name === 'new_tab') { const tab = await this.context.newPage(); this.track(tab); this.active = tab; this.ctx.page = tab; await tab.bringToFront(); return []; }
    if (name === 'list_tabs') return [];
    if (name === 'switch_tab') { this.active = page; this.ctx.page = page; await page.bringToFront(); return []; }
    if (name === 'close_tab') { await page.close(); const next = this.context.pages().find(tab => !tab.isClosed()); if (next) { this.active = next; this.ctx.page = next; await next.bringToFront(); } return []; }
    if (name === 'wait') { await page.waitForTimeout(duration()); return [text('Wait completed.')]; }
    if (name === 'scroll_to') { await locator().scrollIntoViewIfNeeded({ timeout: 10000 }); return [text('Scrolled the referenced element into view.')]; }
    if (name === 'form_input') {
      const field = locator(), value = input.value;
      if (!['string', 'number', 'boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) throw new Error('form_input value must be text, a finite number or a boolean.');
      if (['checkbox', 'radio'].includes(target.targetInfo?.type ?? '')) { if (typeof value !== 'boolean') throw new Error('Checkbox and radio form_input values must be boolean.'); await field.setChecked(value, { timeout: 10000 }); }
      else if (target.targetInfo?.tag === 'select') { const options = await field.locator('option').evaluateAll(els => els.map(el => ({ value: (el as HTMLOptionElement).value, text: el.textContent?.trim() }))); const option = options.find(option => option.value === String(value)) ?? options.find(option => option.text === String(value)); if (!option) throw new Error('The requested select value is not an offered option.'); await field.selectOption(option.value, { timeout: 10000 }); }
      else await field.fill(String(value), { timeout: 10000 });
      return [text('Set the referenced form value. Inspect the saved value and validation before continuing.')];
    }
    if (name === 'file_upload') {
      const field = locator(); if (target.targetInfo?.type !== 'file') throw new Error('file_upload requires the actual file-input ref.');
      const paths = input.paths ?? [], ids = input.document_ids ?? [];
      if (!Array.isArray(paths) || !Array.isArray(ids) || !paths.length && !ids.length || [...paths, ...ids].some(value => typeof value !== 'string') || paths.length + ids.length > 10) throw new Error('Provide 1 to 10 staged paths or document_ids.');
      const files = [...paths.map(path => this.ownedFile(String(path))), ...ids.map(id => { const doc = this.documents.get(String(id)); if (!doc) throw new Error('Unknown staged task document.'); return this.ownedFile(doc.path); })];
      if (files.some(file => ![...this.documents.values()].some(doc => doc.path === file))) throw new Error('Only explicitly registered task documents may be uploaded.');
      await field.setInputFiles([...new Set(files)], { timeout: 10000 }); return [text('Uploaded registered task document(s). Inspect the form for acceptance.')];
    }
    if (name === 'type') { if (!target.targetInfo?.editable) throw new Error('type requires an editable focused element.'); await page.keyboard.type(literal('text')); return [text('Typed text at the current focus.')]; }
    if (name === 'key' || name === 'hold_key') {
      const sequence = literal('text').split(/\s+/).map(chord => chord.split('+').map(key => ({ ctrl: 'Control', control: 'Control', cmd: 'Meta', meta: 'Meta', shift: 'Shift', alt: 'Alt' })[key.toLowerCase()] ?? key).join('+'));
      const repeat = input.repeat === undefined ? 1 : input.repeat;
      if (sequence.length > 100 || !Number.isInteger(repeat) || Number(repeat) < 1 || Number(repeat) > 100) throw new Error('key repeat must be 1 to 100.');
      const guardKey = async (chord: string) => {
        assertLive();
        const locator = await this.focus(page), targetInfo = locator ? await this.info(locator) : undefined;
        if (targetInfo?.sensitive) throw new Error('Protected credentials use the application authentication helper; their values were not read or changed.');
        const decision = await this.options.beforeMutation({ name, input: { ...input, text: chord, repeat: 1 }, page, locator, targetInfo });
        if (decision) throw new WithheldMutation(decision);
        assertLive();
      };
      if (name === 'hold_key') { if (sequence.length !== 1) throw new Error('hold_key accepts one key or chord.'); const delay = duration(); await guardKey(sequence[0]); const keys = sequence[0].split('+'); try { for (const key of keys) await page.keyboard.down(key); await page.waitForTimeout(delay); } finally { for (const key of keys.reverse()) await page.keyboard.up(key).catch(() => {}); } }
      else for (let count = 0; count < Number(repeat); count++) for (const chord of sequence) { await guardKey(chord); await page.keyboard.press(chord); }
      return [text('Key action completed.')];
    }
    if (name === 'scroll') {
      const point = await this.point(input.target, page), amount = input.scroll_amount ?? 3, direction = input.scroll_direction;
      if (!Number.isInteger(amount) || Number(amount) < 1 || Number(amount) > 10 || !['up', 'down', 'left', 'right'].includes(String(direction))) throw new Error('scroll requires a direction and 1 to 10 wheel notches.');
      await page.mouse.move(point.x, point.y); const delta = Number(amount) * 120;
      await page.mouse.wheel(direction === 'left' ? -delta : direction === 'right' ? delta : 0, direction === 'up' ? -delta : direction === 'down' ? delta : 0); return [text('Scrolled at the requested viewport position.')];
    }
    if (name === 'left_click_drag') { const from = await this.point(input.from, page), to = await this.point(input.target, page); await page.mouse.move(from.x, from.y); try { await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 10 }); } finally { await page.mouse.up(); } return [text('Dragged between viewport coordinates.')]; }
    if (name === 'mouse_move' || name === 'left_mouse_down' || name === 'left_mouse_up') { const point = await this.point(input.target, page); await page.mouse.move(point.x, point.y); if (name === 'left_mouse_down') await page.mouse.down(); if (name === 'left_mouse_up') await page.mouse.up(); return [text('Pointer action completed.')]; }
    if (name === 'hover' || ['left_click', 'right_click', 'middle_click', 'double_click', 'triple_click'].includes(name)) {
      const modifiers = input.modifiers === undefined ? [] : literal('modifiers').split('+').map(key => ({ ctrl: 'Control', control: 'Control', cmd: 'Meta', meta: 'Meta', shift: 'Shift', alt: 'Alt' })[key.toLowerCase()]);
      if (modifiers.some(key => !key)) throw new Error('Unsupported click modifier.');
      const options = { button: (name === 'right_click' ? 'right' : name === 'middle_click' ? 'middle' : 'left') as 'left' | 'right' | 'middle', clickCount: name === 'double_click' ? 2 : name === 'triple_click' ? 3 : 1 };
      for (const key of modifiers) await page.keyboard.down(key!);
      try { if (name === 'hover') { if (target.point) await page.mouse.move(target.point.x, target.point.y); else await locator().hover({ timeout: 10000 }); } else if (target.point) await page.mouse.click(target.point.x, target.point.y, options); else await locator().click({ ...options, timeout: 10000 }); }
      finally { for (const key of modifiers.reverse()) await page.keyboard.up(key!).catch(() => {}); }
      return [text(name === 'hover' ? 'Hovered over the target.' : 'Clicked the native target. Inspect its result before continuing.')];
    }
    throw new Error(`${name} is not implemented.`);
  }

  async dispose(): Promise<void> {
    await this.ready.catch(() => {}); await this.context.unroute('**/*', this.networkGuard).catch(() => {});
    this.context.off('page', this.onPage);
    for (const [page, handlers] of this.listeners) { page.off('framenavigated', handlers.navigation); page.off('download', handlers.download); page.off('filechooser', handlers.filechooser); }
    await Promise.all([...this.refs.values()].map(item => item.handle.dispose().catch(() => {}))); this.refs.clear();
  }
}
