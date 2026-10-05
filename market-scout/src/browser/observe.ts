import type { Page } from 'patchright';
import { distill } from './distill.js';

/**
 * The agent's view of a page: numbered interactive elements plus the readable
 * content (the browser-use / Stagehand representation).
 *
 * The model only ever names a number this module just stamped on a real,
 * visible element; it never writes a selector or script. Numbers are
 * re-stamped every observation, so a stale one simply fails to resolve.
 */

export interface Control {
  ref: number;
  tag: string;
  role: string;
  label: string;
  /** Current value for inputs; target for links. */
  value: string;
  inViewport: boolean;
}

export interface Observation {
  url: string;
  title: string;
  controls: Control[];
  content: string;
  scroll: { y: number; height: number; viewport: number };
  screenshot?: string;
}

const MAX_CONTROLS = 160;

export async function observe(page: Page, options: { screenshot?: boolean; contentChars?: number } = {}): Promise<Observation> {
  const controls = await page
    .evaluate((max: number) => {
      for (const old of document.querySelectorAll('[data-scout-ref]')) old.removeAttribute('data-scout-ref');
      const selector = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="combobox"], [role="searchbox"], [contenteditable="true"]';
      const items: Array<{ ref: number; tag: string; role: string; label: string; value: string; inViewport: boolean; distance: number }> = [];
      let n = 0;
      for (const element of document.querySelectorAll<HTMLElement>(selector)) {
        const rect = element.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;
        if (!element.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true })) continue;
        const style = getComputedStyle(element);
        if (style.pointerEvents === 'none') continue;
        const tag = element.tagName.toLowerCase();
        const input = element as HTMLInputElement;
        const label = (
          element.getAttribute('aria-label') ||
          (input.labels?.[0]?.innerText ?? '') ||
          element.innerText ||
          input.placeholder ||
          element.getAttribute('title') ||
          element.getAttribute('alt') ||
          input.name ||
          ''
        ).replace(/\s+/g, ' ').trim().slice(0, 100);
        const value = tag === 'a' ? (element as HTMLAnchorElement).href.slice(0, 160) : tag === 'select' ? (element as HTMLSelectElement).selectedOptions[0]?.text ?? '' : 'value' in input ? String(input.value ?? '').slice(0, 80) : '';
        if (!label && !value && tag !== 'input' && tag !== 'textarea') continue;
        n += 1;
        element.setAttribute('data-scout-ref', String(n));
        const inViewport = rect.bottom > 0 && rect.top < innerHeight;
        items.push({
          ref: n,
          tag: tag === 'input' ? `input[${input.type || 'text'}]` : tag,
          role: element.getAttribute('role') ?? '',
          label,
          value,
          inViewport,
          distance: inViewport ? 0 : Math.abs(rect.top),
        });
      }
      // Keep what is on screen first, then what is nearest to it.
      return items.sort((a, b) => a.distance - b.distance).slice(0, max).sort((a, b) => a.ref - b.ref);
    }, MAX_CONTROLS)
    .catch(() => []);

  const facts = await distill(page, options.contentChars ?? 6_000).catch(() => undefined);
  const scroll = await page
    .evaluate(() => ({ y: Math.round(scrollY), height: document.documentElement.scrollHeight, viewport: innerHeight }))
    .catch(() => ({ y: 0, height: 0, viewport: 0 }));
  const screenshot = options.screenshot
    ? await page.screenshot({ type: 'jpeg', quality: 60 }).then((buffer) => `data:image/jpeg;base64,${buffer.toString('base64')}`).catch(() => undefined)
    : undefined;

  return {
    url: page.url(),
    title: await page.title().catch(() => ''),
    controls: controls.map(({ distance: _distance, ...control }) => control),
    content: facts?.markdown ?? '',
    scroll,
    screenshot,
  };
}

/** The observation as the model reads it. */
export function renderObservation(observation: Observation): string {
  const controls = observation.controls
    .map((c) => `[${c.ref}] ${c.tag}${c.role ? `(${c.role})` : ''} "${c.label}"${c.value ? ` → ${c.value}` : ''}${c.inViewport ? '' : ' (off-screen)'}`)
    .join('\n');
  const { y, height, viewport } = observation.scroll;
  const position = height ? `scrolled ${Math.round((y / Math.max(1, height - viewport)) * 100) || 0}% of ${height}px` : '';
  return [
    `URL: ${observation.url}`,
    `Title: ${observation.title}`,
    position,
    '',
    'Interactive elements:',
    controls || '(none)',
    '',
    'Page content:',
    observation.content || '(empty)',
  ].join('\n');
}

export function locateRef(page: Page, ref: number) {
  return page.locator(`[data-scout-ref="${ref}"]`).first();
}
