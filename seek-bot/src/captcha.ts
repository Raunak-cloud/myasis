import type { Page } from 'patchright';
import { capMonsterSolver } from './captcha/capmonster.js';
import { clickSolver } from './captcha/click.js';
import { detectChallenge, type Solver } from './captcha/detect.js';

export { reportRejectedToken } from './captcha/capmonster.js';

/**
 * CAPTCHA_SOLVER is an ordered chain, e.g. `click,capmonster`: each solver
 * that supports the challenge on the page gets one try, in order, until one
 * applies a solution. `off`, empty, or unknown names solve nothing.
 */
const SOLVERS: Record<string, Solver> = { click: clickSolver, capmonster: capMonsterSolver };
const attempts = new WeakMap<Page, { url: string; time: number }>();

const chain = (): Solver[] =>
  (process.env.CAPTCHA_SOLVER ?? '').split(',').flatMap(name => SOLVERS[name.trim().toLowerCase()] ?? []);

export const captchaEnabled = () => chain().length > 0;

/** Returns true only when a solver applied a solution; callers must re-check the page. */
export async function trySolveCaptcha(page: Page): Promise<boolean> {
  const solvers = chain();
  if (!solvers.length) return false;
  const previous = attempts.get(page);
  if (previous?.url === page.url() && Date.now() - previous.time < 60_000) return false;
  try {
    let challenge = await detectChallenge(page);
    if (!challenge) return false;
    attempts.set(page, { url: page.url(), time: Date.now() });
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
