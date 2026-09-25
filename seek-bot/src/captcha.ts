import type { BrowserContext, Page } from 'patchright';
import { capMonsterSolver } from './captcha/capmonster.js';
import { detectChallenge, hasCaptchaSurface, type Solver } from './captcha/detect.js';
import { watchRecaptchaV3 } from './captcha/recaptcha-v3.js';

export { reportRejectedToken } from './captcha/capmonster.js';

/**
 * CAPTCHA_SOLVER names the solvers to use, comma-separated and tried in order
 * until one applies a solution. `off`, empty, or unknown names solve nothing —
 * so a value naming a solver that has since been removed degrades to the rest.
 */
const SOLVERS: Record<string, Solver> = { capmonster: capMonsterSolver };
const attempts = new WeakMap<Page, { instance: string; time: number }>();

const chain = (): Solver[] =>
  (process.env.CAPTCHA_SOLVER ?? '').split(',').flatMap(name => SOLVERS[name.trim().toLowerCase()] ?? []);

export const captchaEnabled = () => chain().length > 0;

export type CaptchaHandling = 'none' | 'solved' | 'blocked';

/**
 * The single CAPTCHA ownership boundary. Browser agents call this rather than
 * touching challenge controls: CapMonster solves recognised types, while an
 * unknown or failed challenge is blocked from all AI interaction.
 */
export async function handleCaptchaWithCapMonster(page: Page): Promise<CaptchaHandling> {
  if (!(await hasCaptchaSurface(page))) return 'none';
  if (!captchaEnabled()) return 'blocked';
  return (await trySolveCaptcha(page)) ? 'solved' : 'blocked';
}

/**
 * Challenges that never show a wall cannot wait for the page judge to notice
 * them; they are handled as the browser meets them. Called once per context.
 */
export function watchCaptchas(context: BrowserContext): void {
  if (chain().includes(capMonsterSolver) && process.env.CAPMONSTER_RECAPTCHA_V3 === 'true') watchRecaptchaV3(context);
}

/** Returns true only when a solver applied a solution; callers must re-check the page. */
export async function trySolveCaptcha(page: Page): Promise<boolean> {
  const solvers = chain();
  if (!solvers.length) return false;
  try {
    let challenge = await detectChallenge(page);
    if (!challenge) return false;
    // A form may present a second, distinct challenge on the same URL after
    // the final submit click. The widget iframe URL carries a fresh instance
    // id; throttle only that exact instance, not the whole application page.
    const instance = challenge.kind === 'cloudflare-challenge'
      ? `${challenge.kind}|${page.url()}`
      : challenge.kind === 'turnstile'
        ? `${challenge.kind}|${challenge.instance ?? challenge.host.url()}|${challenge.siteKey ?? ''}|${challenge.action ?? ''}|${challenge.cData ?? ''}`
        : `${challenge.kind}|${challenge.instance}|${challenge.siteKey}`;
    const previous = attempts.get(page);
    if (previous?.instance === instance && Date.now() - previous.time < 60_000) return false;
    attempts.set(page, { instance, time: Date.now() });
    for (const solver of solvers) {
      if (!solver.supports(challenge)) continue;
      if (await solver.solve(page, challenge)) return true;
      // A failed try can leave a different page behind (a reload, a cleared check).
      challenge = await detectChallenge(page);
      if (!challenge) return true;
    }
    console.warn(`[captcha] ${challenge.kind} not solved; handing off to human.`);
    return false;
  } catch {
    return false;
  }
}
