export interface CaptchaSolveResult { status?: string }
export interface CaptchaRetryOutcome { status: 'solved' | 'cleared' | 'failed'; attempts: number }
export interface CaptchaAttemptDiagnostic { elapsedMs: number; phase: 'solve' | 'detect'; error?: unknown; response?: CaptchaSolveResult }
export interface CaptchaRetryDependencies {
  solve: () => Promise<CaptchaSolveResult>;
  /** Read-only: false when the original page changed or its challenge disappeared. */
  stillChallenged: () => Promise<boolean>;
  pause: () => Promise<void>;
  onAttempt?: (attempt: number, status: string, details: CaptchaAttemptDiagnostic) => void;
  now?: () => number;
}

export async function captchaRequestWithin<T>(request: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('CAPTCHA request deadline')), timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Only completed solver failures are retried. A timed-out request is never duplicated. */
export async function retryCaptchaSolve(deps: CaptchaRetryDependencies,
  limits = { attempts: 3, attemptMs: 90_000, totalMs: 180_000 },
): Promise<CaptchaRetryOutcome> {
  const now = deps.now ?? Date.now;
  const deadline = now() + limits.totalMs;
  let attempts = 0;
  for (; attempts < limits.attempts;) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    attempts++;
    const started = now();
    let result: CaptchaSolveResult;
    try {
      result = await captchaRequestWithin(deps.solve, Math.min(limits.attemptMs, remaining));
    } catch (error) {
      deps.onAttempt?.(attempts, 'request_failed', { elapsedMs: now() - started, phase: 'solve', error });
      // The request may still be running; stop rather than overlap a second solve.
      return { status: 'failed', attempts };
    }
    const status = ['solve_finished', 'solve_failed', 'not_detected', 'invalid'].includes(result?.status ?? '') ? result.status! : 'invalid';
    deps.onAttempt?.(attempts, status, { elapsedMs: now() - started, phase: 'solve', response: result });
    if (status === 'solve_finished') return { status: 'solved', attempts };
    if (status === 'invalid') break;
    // Read-only detection exceptions also stop the retry; they never authorize navigation.
    let challenged: boolean;
    try {
      const remaining = deadline - now();
      if (remaining <= 0) break;
      challenged = await captchaRequestWithin(deps.stillChallenged, Math.min(15_000, remaining));
    }
    catch (error) {
      deps.onAttempt?.(attempts, 'detection_failed', { elapsedMs: now() - started, phase: 'detect', error });
      break;
    }
    if (!challenged) return { status: 'cleared', attempts };
    if (attempts < limits.attempts && now() < deadline) await deps.pause();
  }
  return { status: 'failed', attempts };
}
