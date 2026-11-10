import type { CelerisRequest, ChatMessage } from './celeris.js';
import { generationRecoveryTranscript } from './agent-only-transcript.js';

export type ReasoningEffort = 'low' | 'medium' | 'high';

/** Also bounds untyped/resumed callers at the provider boundary. */
export function boundedReasoningEffort(value: unknown, fallback: ReasoningEffort): ReasoningEffort {
  return value === undefined ? fallback : value === 'low' || value === 'medium' ? value : 'high';
}

export class GenerationWindowError extends Error {}

/** Generation retries only: never executes or replays an application action.
 * Three attempts share a hard four-minute ceiling and the original spend meter.
 * Every retry reserves its full inference window, including after queueing;
 * an explicit enclosing deadline always wins over the recovery allowance. */
export class GenerationRecovery {
  readonly hardDeadline: number;
  deadline: number;
  timeoutMs: number;
  resampled = false;
  private timeoutAdapted = false;
  private readonly originalTokens: number;

  constructor(private readonly request: CelerisRequest, private readonly baseTimeoutMs: number,
    maxTokens: number) {
    this.timeoutMs = baseTimeoutMs;
    this.originalTokens = Math.max(1, maxTokens);
    this.hardDeadline = Math.min(Date.now() + 240_000, request.deadline ?? Infinity);
    this.deadline = Math.min(Date.now() + Math.max(60_000, baseTimeoutMs + 15_000), this.hardDeadline);
  }

  assertWindow(attempt: number, fullInitialWindow = false): void {
    if (Date.now() >= this.deadline || (attempt > 0 || fullInitialWindow) && this.deadline - Date.now() < this.timeoutMs)
      throw new GenerationWindowError('Not enough time remains for a full generation retry; no additional request was sent.');
  }

  /** Retry-After is never shortened, nor allowed to create an unbounded wait. */
  get backoffDeadline(): number { return Math.min(Date.now() + 60_000, this.hardDeadline); }

  refreshWindow(): void {
    this.deadline = Math.min(Date.now() + Math.max(60_000, this.timeoutMs + 15_000), this.hardDeadline);
  }

  adapt(body: Record<string, unknown>, failure: 'unusable' | 'timeout', growOutput = false): boolean {
    if (failure === 'unusable' ? this.resampled : this.timeoutAdapted) return false;
    if (failure === 'unusable') this.resampled = true;
    else this.timeoutAdapted = true;
    if (growOutput) body.max_tokens = Math.min(16_384, Number(body.max_tokens) * 2);
    // More potential output needs proportionate inference time, not the old
    // 45-second timeout. This is bounded, not an unlimited extension.
    const ratio = Math.max(1, Number(body.max_tokens) / this.originalTokens);
    this.timeoutMs = Math.max(this.baseTimeoutMs, Math.min(90_000, this.baseTimeoutMs * ratio));
    const lower = (value: unknown) => boundedReasoningEffort(value, 'low') === 'high' ? 'medium' : 'low';
    if (!this.request.preserveReasoningEffort && body.chat_template_kwargs) {
      const kwargs = body.chat_template_kwargs as Record<string, unknown>;
      if (kwargs.enable_thinking) body.chat_template_kwargs = { ...kwargs, reasoning_effort: lower(kwargs.reasoning_effort) };
    }
    if (!this.request.preserveReasoningEffort && body.reasoning) body.reasoning = { ...(body.reasoning as object), effort: lower((body.reasoning as Record<string, unknown>).effort) };
    body.messages = [...generationRecoveryTranscript(this.request.messages), { role: 'user', content:
      'The previous generation did not finish. Return one concise, complete response in the required format. Keep every required accuracy check and its source evidence, using brief conclusions. Do not repeat the full history, candidate documents or unrelated unchanged field values. Do not infer missing facts, waive review or replay browser actions. No action from the incomplete response was executed.' } satisfies ChatMessage];
    this.refreshWindow();
    return true;
  }
}

export function generationFailure(provider: string, error: unknown, earlier?: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  const preceding = earlier && earlier !== error ? ` Earlier generation failed: ${earlier instanceof Error ? earlier.message : String(earlier)}.` : '';
  return new Error(`${provider} generation failed: ${detail}.${preceding}`, { cause: error });
}
