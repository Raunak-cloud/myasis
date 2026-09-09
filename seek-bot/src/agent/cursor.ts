import type { BrowserContext, Page } from 'patchright';
import { config } from '../config.js';

/**
 * A drawn pointer that glides to whatever the agent is about to click.
 *
 * Purely a window onto what is already happening: the agent clicks elements
 * directly, so no real pointer is involved and this changes nothing about how
 * a click is dispatched. It sits on top of the page with pointer events off,
 * and it reports honestly — if the agent clicks the wrong control, the pointer
 * glides to the wrong control.
 *
 * Nothing here costs a model call. The only price is the glide itself, which
 * is a short wait before each click, and it is skipped entirely when the
 * browser is headless because there is nobody to watch it.
 */

const CURSOR_ID = '__myasis_cursor';
const GLIDE_MS = 420;

/**
 * Injected on every navigation so the pointer survives page changes.
 *
 * Written as one nameless function on purpose — see the note in observe.ts
 * about esbuild's `__name` helper not existing inside the browser.
 */
function cursorInitScript(cursorId: string): string {
  return `(() => {
  if (window.top !== window.self) return;              // main frame only
  const ID = ${JSON.stringify(cursorId)};
  const build = () => {
    if (document.getElementById(ID) || !document.body) return;
    const el = document.createElement('div');
    el.id = ID;
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = [
      'position:fixed','left:0','top:0','width:26px','height:26px',
      'z-index:2147483647','pointer-events:none','will-change:transform',
      'transition:transform ${GLIDE_MS}ms cubic-bezier(.33,.9,.32,1)',
      'filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))',
    ].join(';');
    el.innerHTML =
      '<svg width="26" height="26" viewBox="0 0 24 24" fill="none">' +
      '<path d="M5.6 2.4 L5.6 18.9 L9.9 14.9 L12.6 21.2 L15.6 19.9 L12.9 13.8 L18.6 13.8 Z"' +
      ' fill="#ffffff" stroke="#12121a" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    /*
     * Park it on screen, not off the edge.
     *
     * It used to start at -60,-60 and only became visible at the first click,
     * which on a job board is several pages away — so it looked broken. Resting
     * near the middle means you can see it is there and waiting.
     */
    let x = Math.round(window.innerWidth * 0.5);
    let y = Math.round(window.innerHeight * 0.55);
    try {
      const saved = JSON.parse(sessionStorage.getItem(ID) || 'null');
      if (saved) { x = saved.x; y = saved.y; }
    } catch {}
    el.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    document.body.appendChild(el);

    // A slow breath so it reads as present and idle rather than a stuck image.
    el.animate(
      [{ opacity: 1 }, { opacity: 0.55 }, { opacity: 1 }],
      { duration: 2600, iterations: Infinity, easing: 'ease-in-out' },
    );
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build, { once: true });
  } else {
    build();
  }
  // Some sites wipe the body mid-render; put it back if it disappears.
  setInterval(build, 1000);
})();`;
}

export async function installCursor(ctx: BrowserContext): Promise<void> {
  if (!config.celeris.showCursor || config.headless) return;
  await ctx.addInitScript(cursorInitScript(CURSOR_ID)).catch(() => {});
}

/**
 * Glides the pointer onto a stamped ref and returns once it has arrived.
 *
 * Resolves immediately when the pointer is disabled, when the element cannot be
 * found, or when anything throws — this is decoration, and it must never be
 * able to fail an application.
 */
export async function glideTo(page: Page, ref: string): Promise<void> {
  if (!config.celeris.showCursor || config.headless) return;

  const moved = await page
    .evaluate(
      ({ id, wanted }) => {
        const cursor = document.getElementById(id);
        if (!cursor) return false;

        // Same deep walk the tools use, so shadow-DOM controls are found too.
        let target: Element | null = null;
        const roots: Array<Document | ShadowRoot> = [document];
        while (roots.length && !target) {
          const root = roots.pop()!;
          for (const element of root.querySelectorAll('*')) {
            if (element.getAttribute('data-agent-ref') === wanted) { target = element; break; }
            if (element.shadowRoot) roots.push(element.shadowRoot);
          }
        }
        if (!target) return false;

        const box = target.getBoundingClientRect();
        if (!box.width && !box.height) return false;
        const x = Math.round(box.left + box.width / 2);
        const y = Math.round(box.top + box.height / 2);

        cursor.style.transform = 'translate(' + x + 'px,' + y + 'px)';
        try { sessionStorage.setItem(id, JSON.stringify({ x, y })); } catch {}
        return true;
      },
      { id: CURSOR_ID, wanted: ref },
    )
    .catch(() => false);

  if (moved) await page.waitForTimeout(GLIDE_MS + 40);
}

/** A quick pulse where the click landed, so the moment is visible. */
export async function flashClick(page: Page): Promise<void> {
  if (!config.celeris.showCursor || config.headless) return;
  await page
    .evaluate((id) => {
      const cursor = document.getElementById(id);
      if (!cursor) return;
      const match = /translate\((-?\d+)px,\s*(-?\d+)px\)/.exec(cursor.style.transform || '');
      if (!match) return;

      const ring = document.createElement('div');
      ring.setAttribute('aria-hidden', 'true');
      ring.style.cssText = [
        'position:fixed', 'left:' + match[1] + 'px', 'top:' + match[2] + 'px',
        'width:14px', 'height:14px', 'margin:-7px 0 0 -7px', 'border-radius:50%',
        'border:2px solid #6366f1', 'background:rgba(99,102,241,.28)',
        'z-index:2147483646', 'pointer-events:none',
      ].join(';');
      document.body.appendChild(ring);
      ring
        .animate(
          [
            { transform: 'scale(.5)', opacity: 1 },
            { transform: 'scale(2.6)', opacity: 0 },
          ],
          { duration: 460, easing: 'cubic-bezier(.2,.7,.3,1)' },
        )
        .addEventListener('finish', () => ring.remove());
    }, CURSOR_ID)
    .catch(() => {});
}
