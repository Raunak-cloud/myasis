import WebSocket from 'ws';

export interface SigninAssistStatus {
  state: 'waiting' | 'clicked' | 'unavailable' | 'failed';
  message: string;
}

interface DevToolsTarget {
  id?: string;
  parentId?: string;
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

interface ClickPoint {
  x: number;
  y: number;
  text: string;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Finds only an Indeed Google button that visibly names the account already
 * present in this Chrome profile. It never fills credentials or chooses a
 * different account.
 */
function googleAccountButtonExpression(email: string, click = false): string {
  const wanted = JSON.stringify(email.trim().toLowerCase());
  const clickControl = click ? 'control.click();' : '';
  return `(() => {
    const wanted = ${wanted};
    const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = (element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const controls = [...document.querySelectorAll('button, a, [role="button"]')].filter(visible);
    const control = controls.find((element) => {
      const text = clean(element.innerText || element.textContent);
      const lower = text.toLowerCase();
      return lower.includes(wanted) && (/continue as/i.test(text) || /google/i.test(text));
    });
    if (!control) return null;
    control.scrollIntoView({ block: 'center', inline: 'center' });
    const box = control.getBoundingClientRect();
    ${clickControl}
    return { x: box.left + box.width / 2, y: box.top + box.height / 2, text: clean(control.innerText || control.textContent) };
  })()`;
}

async function targets(debugPort: number): Promise<DevToolsTarget[]> {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) return [];
  return (await response.json()) as DevToolsTarget[];
}

function loginAdvanced(before: DevToolsTarget[], after: DevToolsTarget[]): boolean {
  const prior = new Set(before.map((target) => `${target.id}:${target.url}`));
  return after.some((target) => {
    const priorTarget = before.find((candidate) => candidate.id === target.id);
    const leftOriginalLogin = Boolean(
      priorTarget?.url && /\/(auth|account\/login)\b/i.test(priorTarget.url) && target.url !== priorTarget.url,
    );
    const changed = !prior.has(`${target.id}:${target.url}`);
    const meaningfulGooglePage = /accounts\.google\.com/i.test(target.url ?? '') && !/\/gsi\/button/i.test(target.url ?? '');
    const leftIndeedLogin = /indeed\./i.test(target.url ?? '') && !/\/(auth|account\/login)\b/i.test(target.url ?? '');
    return changed && (leftOriginalLogin || meaningfulGooglePage || leftIndeedLogin);
  });
}

async function devToolsCommand(webSocketUrl: string, method: string, params: Record<string, unknown>): Promise<any> {
  const socket = new WebSocket(webSocketUrl);
  const timeout = setTimeout(() => socket.terminate(), 4_000);

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return await new Promise<any>((resolve, reject) => {
      socket.on('message', (raw) => {
        try {
          const message = JSON.parse(String(raw)) as { id?: number; result?: any; error?: { message?: string } };
          if (message.id !== 1) return;
          if (message.error) reject(new Error(message.error.message ?? 'Browser-control command failed.'));
          else resolve(message.result);
        } catch (error) {
          reject(error);
        }
      });
      socket.once('close', () => reject(new Error('Browser-control connection closed.')));
      socket.once('error', reject);
      socket.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally {
    clearTimeout(timeout);
    socket.close();
  }
}

async function evaluatePoint(target: DevToolsTarget, expression: string): Promise<ClickPoint | null> {
  if (!target.webSocketDebuggerUrl) return null;
  const evaluated = await devToolsCommand(target.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    userGesture: true,
  });
  const point = evaluated?.result?.value as ClickPoint | null | undefined;
  return point && Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
}

function frameOffsetExpression(frameUrl: string): string {
  const wanted = JSON.stringify(frameUrl);
  return `(() => {
    const wanted = ${wanted};
    const frame = [...document.querySelectorAll('iframe')].find((element) => element.src === wanted);
    if (!frame) return null;
    const box = frame.getBoundingClientRect();
    return { x: box.left, y: box.top, text: '' };
  })()`;
}

async function dispatchClick(target: DevToolsTarget, point: ClickPoint): Promise<void> {
  if (!target.webSocketDebuggerUrl) throw new Error('Browser target is unavailable.');
  await devToolsCommand(target.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: point.x,
      y: point.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
  });
  await devToolsCommand(target.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: point.x,
      y: point.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
  });
}

/** Dispatches through the parent page when Google rendered an out-of-process iframe. */
async function clickViaDevTools(page: DevToolsTarget, pages: DevToolsTarget[], expression: string): Promise<ClickPoint | null> {
  const point = await evaluatePoint(page, expression);
  if (!point) return null;
  if (!page.parentId) {
    await dispatchClick(page, point);
    return point;
  }
  const parent = pages.find((candidate) => candidate.id === page.parentId);
  if (!parent || !page.url) return null;
  const offset = await evaluatePoint(parent, frameOffsetExpression(page.url));
  if (!offset) return null;
  const translated = { ...point, x: point.x + offset.x, y: point.y + offset.y };
  await dispatchClick(parent, translated);
  return translated;
}

/**
 * Selects the known Google account on Indeed, then stops. Passwords, account
 * creation, CAPTCHAs and verification remain explicit human handoffs.
 */
export async function assistIndeedGoogleSignin(options: {
  debugPort: number;
  email: string;
  active: () => boolean;
  update: (status: SigninAssistStatus) => void;
}): Promise<void> {
  const { debugPort, email, active, update } = options;
  const expression = googleAccountButtonExpression(email);
  const directClickExpression = googleAccountButtonExpression(email, true);
  const deadline = Date.now() + 45_000;

  while (active() && Date.now() < deadline) {
    try {
      const pages = await targets(debugPort);
      for (const page of pages) {
        if (!page.webSocketDebuggerUrl || !/(indeed\.|accounts\.google\.com\/gsi\/)/i.test(page.url ?? '')) continue;
        // A user-gesture Runtime click works for the normal button. If Google
        // isolates it in an out-of-process iframe, the translated mouse event
        // below is the compatible fallback.
        let direct: ClickPoint | null;
        try {
          direct = await evaluatePoint(page, directClickExpression);
        } catch {
          // A successful click can destroy this DevTools target immediately
          // as Indeed redirects. Treat the resulting navigation as success,
          // not as a failed browser-control command.
          const navigatedTargets = await targets(debugPort);
          if (loginAdvanced(pages, navigatedTargets)) {
            update({
              state: 'clicked',
              message: `Selected ${email} with Google. Complete any verification shown, then choose Done.`,
            });
            return;
          }
          continue;
        }
        if (!direct) continue;
        await wait(900);
        const afterDirectTargets = await targets(debugPort);
        const afterDirect = await evaluatePoint(page, expression).catch(() => null);
        if (!afterDirect || loginAdvanced(pages, afterDirectTargets)) {
          update({
            state: 'clicked',
            message: `Selected ${email} with Google. Complete any verification shown, then choose Done.`,
          });
          return;
        }
        const clicked = await clickViaDevTools(page, afterDirectTargets, expression);
        if (!clicked) continue;
        await wait(900);
        const afterMouseTargets = await targets(debugPort);
        const stillVisible = await evaluatePoint(page, expression).catch(() => null);
        if (stillVisible && !loginAdvanced(afterDirectTargets, afterMouseTargets)) continue;
        update({
          state: 'clicked',
          message: `Selected ${email} with Google. Complete any verification shown, then choose Done.`,
        });
        return;
      }
    } catch {
      // Chrome and the sign-in page often need a few seconds to become ready.
    }
    await wait(750);
  }

  if (active()) {
    update({
      state: 'failed',
      message: `Could not select ${email} automatically. You can still choose its Google button in the window.`,
    });
  }
}
