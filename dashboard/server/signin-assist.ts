import WebSocket from 'ws';

export interface SigninAssistStatus {
  state: 'waiting' | 'clicked' | 'unavailable' | 'failed';
  message: string;
}

interface DevToolsTarget {
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
export function googleAccountButtonExpression(email: string): string {
  const wanted = JSON.stringify(email.trim().toLowerCase());
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
    return { x: box.left + box.width / 2, y: box.top + box.height / 2, text: clean(control.innerText || control.textContent) };
  })()`;
}

async function targets(debugPort: number): Promise<DevToolsTarget[]> {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) return [];
  return (await response.json()) as DevToolsTarget[];
}

async function clickViaDevTools(webSocketUrl: string, expression: string): Promise<ClickPoint | null> {
  const socket = new WebSocket(webSocketUrl);
  const timeout = setTimeout(() => socket.terminate(), 4_000);
  let nextId = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const rejectPending = (message: string) => {
    for (const request of pending.values()) request.reject(new Error(message));
    pending.clear();
  };

  socket.on('message', (raw) => {
    try {
      const message = JSON.parse(String(raw)) as { id?: number; result?: any; error?: { message?: string } };
      if (!message.id) return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message ?? 'Browser-control command failed.'));
      else request.resolve(message.result);
    } catch {
      /* Ignore protocol events and malformed messages. */
    }
  });
  socket.on('close', () => rejectPending('Browser-control connection closed.'));
  socket.on('error', () => rejectPending('Browser-control connection failed.'));

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const command = (method: string, params: Record<string, unknown>) =>
      new Promise<any>((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });

    const evaluated = await command('Runtime.evaluate', {
      expression,
      returnByValue: true,
      userGesture: true,
    });
    const point = evaluated?.result?.value as ClickPoint | null | undefined;
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    await command('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: point.x,
      y: point.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await command('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: point.x,
      y: point.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    return point;
  } finally {
    clearTimeout(timeout);
    rejectPending('Browser-control connection closed.');
    socket.close();
  }
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
  const deadline = Date.now() + 45_000;

  while (active() && Date.now() < deadline) {
    try {
      const pages = await targets(debugPort);
      for (const page of pages) {
        if (!page.webSocketDebuggerUrl || !/(indeed\.|accounts\.google\.com\/gsi\/)/i.test(page.url ?? '')) continue;
        const clicked = await clickViaDevTools(page.webSocketDebuggerUrl, expression);
        if (!clicked) continue;
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
