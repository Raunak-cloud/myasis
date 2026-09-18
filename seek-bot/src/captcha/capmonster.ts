import type { Frame, Page } from 'patchright';
import { INTERSTITIAL, type Challenge, type Solver } from './detect.js';

/**
 * CapMonster Cloud (https://docs.capmonster.cloud): the challenge's parameters
 * go to their API, a token comes back, and the token is placed where the
 * widget would have put it. Built-in proxies are used, so nothing about this
 * machine's network changes. hCaptcha is not a task type they offer.
 *
 * A token is one form field's worth of proof. Submitting stays with the agent
 * and its guards; the only callback invoked is the widget's own, which is what
 * a person's solve would have fired.
 */

const apiBase = () => (process.env.CAPMONSTER_API_URL || 'https://api.capmonster.cloud').replace(/\/+$/, '');
const apiKey = () => process.env.CAPMONSTER_API_KEY?.trim() ?? '';

/** getTaskResult: at most one call per 2s and 120 per task, per their limits. */
const FIRST_POLL_MS = 3_000;
const POLL_MS = 2_500;
/** reCAPTCHA tokens live ~2 minutes; a solve slower than this is not worth applying. */
const SOLVE_DEADLINE_MS = 100_000;

/** Errors about the account, not the task. Retrying them only earns an IP ban. */
const ACCOUNT_ERRORS = new Set(['ERROR_KEY_DOES_NOT_EXIST', 'ERROR_ZERO_BALANCE', 'ERROR_IP_NOT_ALLOWED', 'ERROR_IP_BANNED']);
let accountError: string | null = null;

class CapMonsterError extends Error {
  constructor(readonly code: string, description?: string) {
    super(description ? `${code}: ${description}` : code);
  }
}

interface ApiReply {
  errorId: number;
  errorCode?: string | null;
  errorDescription?: string | null;
}

async function call<T extends ApiReply>(method: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${apiBase()}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientKey: apiKey(), ...body }),
    signal: AbortSignal.timeout(15_000),
  });
  const reply = (await response.json()) as T;
  if (reply.errorId) {
    const code = reply.errorCode || `HTTP_${response.status}`;
    if (ACCOUNT_ERRORS.has(code)) accountError = code;
    throw new CapMonsterError(code, reply.errorDescription ?? undefined);
  }
  return reply;
}

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

export async function solveTask(task: Record<string, unknown>, deadlineMs = SOLVE_DEADLINE_MS): Promise<{ taskId: number; solution: Record<string, unknown> }> {
  const { taskId } = await call<ApiReply & { taskId: number }>('createTask', { task });
  const deadline = Date.now() + deadlineMs;
  for (let wait = FIRST_POLL_MS; Date.now() + wait < deadline; wait = POLL_MS) {
    await sleep(wait);
    const reply = await call<ApiReply & { status: string; solution?: Record<string, unknown> }>('getTaskResult', { taskId });
    if (reply.status === 'ready' && reply.solution) return { taskId, solution: reply.solution };
  }
  throw new CapMonsterError('TIMEOUT', `task ${taskId} was not solved in ${deadlineMs / 1000}s`);
}

export async function capMonsterBalance(): Promise<number> {
  return (await call<ApiReply & { balance: number }>('getBalance', {})).balance;
}

/** The last token applied per page, so a rejected one can be reported. */
const applied = new WeakMap<Page, number>();

/**
 * Tells CapMonster the page still showed a challenge after their token went
 * in. Their quality control is driven by these reports.
 */
export async function reportRejectedToken(page: Page): Promise<void> {
  const taskId = applied.get(page);
  if (!taskId) return;
  applied.delete(page);
  await call('reportIncorrectTokenCaptcha', { taskId }).catch(() => {});
}

/**
 * Patchright evaluates in an isolated world unless told otherwise. A widget
 * callback is a page global, so these run in the page's own world. No named
 * inner functions — see the esbuild note in browser.ts.
 */
const inPage = <Arg, R>(frame: Frame, fn: (arg: Arg) => R, arg: Arg): Promise<R> =>
  frame.evaluate(fn as never, arg as never, undefined, false) as Promise<R>;

async function solveTurnstile(page: Page, challenge: Extract<Challenge, { kind: 'turnstile' }>): Promise<number | null> {
  if (!challenge.siteKey) throw new CapMonsterError('NO_SITEKEY', 'the Turnstile widget exposes no site key');
  const { taskId, solution } = await solveTask({
    type: 'TurnstileTask',
    websiteURL: challenge.host.url(),
    websiteKey: challenge.siteKey,
    ...(challenge.action && { pageAction: challenge.action }),
    ...(challenge.cData && { data: challenge.cData }),
  });
  const placed = await inPage(challenge.host, (token: string) => {
    let done = false;
    for (const input of document.querySelectorAll<HTMLInputElement>('input[name="cf-turnstile-response"]')) {
      input.value = token;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      done = true;
    }
    const name = document.querySelector('[data-sitekey][data-callback]')?.getAttribute('data-callback');
    const callback = name ? (window as unknown as Record<string, unknown>)[name] : undefined;
    if (typeof callback === 'function') {
      callback(token);
      done = true;
    }
    return done;
  }, String(solution.token ?? ''));
  return placed ? taskId : null;
}

async function solveRecaptcha(page: Page, challenge: Extract<Challenge, { kind: 'recaptcha-v2' }>): Promise<number | null> {
  const { taskId, solution } = await solveTask(challenge.enterprise
    ? {
        type: 'RecaptchaV2EnterpriseTask',
        websiteURL: challenge.host.url(),
        websiteKey: challenge.siteKey,
        apiDomain: challenge.apiDomain,
        ...(challenge.dataS && { enterprisePayload: { s: challenge.dataS } }),
      }
    : {
        type: 'RecaptchaV2Task',
        websiteURL: challenge.host.url(),
        websiteKey: challenge.siteKey,
        isInvisible: challenge.invisible,
        ...(challenge.dataS && { recaptchaDataSValue: challenge.dataS }),
      });
  const placed = await inPage(challenge.host, ([token, siteKey]: [string, string]) => {
    let done = false;
    for (const area of document.querySelectorAll<HTMLTextAreaElement>('textarea[name="g-recaptcha-response"]')) {
      area.value = token;
      done = true;
    }
    // The widget's config tree is where grecaptcha keeps the site's callback,
    // whether it came from data-callback or from a render() call.
    const scope = window as unknown as Record<string, unknown> & { ___grecaptcha_cfg?: { clients?: Record<string, unknown> } };
    const stack: Array<{ value: unknown; depth: number }> = Object.values(scope.___grecaptcha_cfg?.clients ?? {}).map(value => ({ value, depth: 0 }));
    const seen = new Set<unknown>();
    while (stack.length) {
      const { value, depth } = stack.pop()!;
      if (!value || typeof value !== 'object' || value instanceof Node || seen.has(value) || depth > 4) continue;
      seen.add(value);
      try {
        const node = value as Record<string, unknown>;
        if (node.sitekey === siteKey && node.callback) {
          const callback = typeof node.callback === 'string' ? scope[node.callback] : node.callback;
          if (typeof callback === 'function') {
            callback(token);
            done = true;
          }
          break;
        }
        for (const key of Object.keys(node)) stack.push({ value: node[key], depth: depth + 1 });
      } catch {}
    }
    return done;
  }, [String(solution.gRecaptchaResponse ?? ''), challenge.siteKey]);
  return placed ? taskId : null;
}

/**
 * Cloudflare hands its full-page challenge the parameters in a single
 * turnstile.render() call, so they can only be read by standing in for
 * `turnstile` before the page's scripts run. The stand-in is registered on
 * this one tab, used for one reload of a page that is already blocked, and
 * removed — normal browsing never carries it.
 */
const CAPTURE_KEY = '__cmcChallenge';
const CHALLENGE_HOOK = `(() => {
  if (window.top !== window) return;
  const captured = {};
  Object.defineProperty(window, '${CAPTURE_KEY}', { value: captured });
  const standIn = new Proxy({}, { get: (_, name) =>
    name === 'render' ? (element, params) => { captured.params = params; return 'cmc'; }
    : name === 'ready' ? (fn) => { if (typeof fn === 'function') fn(); }
    : () => undefined });
  Object.defineProperty(window, 'turnstile', { configurable: true, get: () => standIn, set: () => {} });
})();`;

interface ChallengeParams { siteKey?: string; action?: string; cData?: string; pageData?: string }

async function solveCloudflareChallenge(page: Page): Promise<number | null> {
  const session = await page.context().newCDPSession(page);
  try {
    // New-document scripts only run on a session that has the Page domain enabled.
    await session.send('Page.enable');
    const { identifier } = await session.send('Page.addScriptToEvaluateOnNewDocument', { source: CHALLENGE_HOOK });
    let params: ChallengeParams | null = null;
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      for (let tries = 0; tries < 30 && !params; tries += 1) {
        await sleep(500);
        params = await inPage(page.mainFrame(), (key: string) => {
          const found = (window as unknown as Record<string, { params?: Record<string, string> }>)[key]?.params;
          return found ? { siteKey: found.sitekey, action: found.action, cData: found.cData, pageData: found.chlPageData } : null;
        }, CAPTURE_KEY).catch(() => null);
      }
    } finally {
      await session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }).catch(() => {});
    }
    if (!params?.siteKey || !params.pageData) throw new CapMonsterError('NO_PARAMS', 'the challenge page never rendered its widget');

    // Challenge tasks are only accepted with the User-Agent CapMonster currently solves as.
    const userAgent = await fetch('https://capmonster.cloud/api/useragent/actual', { signal: AbortSignal.timeout(10_000) })
      .then(response => response.text())
      .then(text => text.trim())
      .catch(() => page.evaluate(() => navigator.userAgent));
    const { taskId, solution } = await solveTask({
      type: 'TurnstileTask',
      cloudflareTaskType: 'token',
      websiteURL: page.url(),
      websiteKey: params.siteKey,
      pageAction: params.action ?? 'managed',
      data: params.cData ?? '',
      pageData: params.pageData,
      userAgent,
    });
    const called = await inPage(page.mainFrame(), ([key, token]: [string, string]) => {
      const callback = (window as unknown as Record<string, { params?: { callback?: unknown } }>)[key]?.params?.callback;
      if (typeof callback !== 'function') return false;
      callback(token);
      return true;
    }, [CAPTURE_KEY, String(solution.token ?? '')]);
    if (!called) throw new CapMonsterError('NO_CALLBACK', 'the challenge page navigated before the token arrived');
    // Cloudflare verifies the token and navigates to the real page.
    for (let tries = 0; tries < 20 && (await page.locator(INTERSTITIAL).count().catch(() => 1)); tries += 1) await sleep(1_000);
    return taskId;
  } catch (error) {
    // The stand-in is already unregistered; a reload gives a person the real challenge back.
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    throw error;
  } finally {
    await session.detach().catch(() => {});
  }
}

let warnedNoKey = false;

/** A key is set and the account has not failed this run. */
export function capMonsterReady(): boolean {
  if (accountError) return false;
  if (apiKey()) return true;
  if (!warnedNoKey) console.warn('[captcha] capmonster: CAPMONSTER_API_KEY is not set; solver skipped.');
  warnedNoKey = true;
  return false;
}

export const capMonsterSolver: Solver = {
  name: 'capmonster',
  supports: capMonsterReady,
  async solve(page, challenge) {
    try {
      const taskId = challenge.kind === 'turnstile' ? await solveTurnstile(page, challenge)
        : challenge.kind === 'recaptcha-v2' ? await solveRecaptcha(page, challenge)
        : await solveCloudflareChallenge(page);
      if (!taskId) {
        console.warn(`[captcha] capmonster: solved ${challenge.kind}, but the page offers nowhere to put the token.`);
        return false;
      }
      applied.set(page, taskId);
      return true;
    } catch (error) {
      console.warn(`[captcha] capmonster: ${challenge.kind} not solved (${(error as Error).message}).`);
      if (accountError) console.warn(`[captcha] capmonster: disabled for this run — ${accountError}.`);
      return false;
    }
  },
};
