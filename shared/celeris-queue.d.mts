export interface CelerisPermit { release(): void; defer(ms: number): void }
export class CelerisQueueDeadlineError extends Error {}
export function acquireCelerisPermit(options: {
  endpoint: string; deadline: number; leaseMs?: number; env?: Readonly<Record<string, string | undefined>>; signal?: AbortSignal;
}): Promise<CelerisPermit>;
export function celerisRetryDelay(retryAfter: string | null | undefined, attempt: number, now?: number, random?: () => number): number;
export function waitForCelerisRetry(ms: number, deadline: number): Promise<void>;
export function closeCelerisQueues(): void;
