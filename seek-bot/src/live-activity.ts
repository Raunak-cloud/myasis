/** Shared browser-safe protocol types; no filesystem or runtime dependencies. */
export const LIVE_ACTIVITY_PHASES = ['starting', 'reviewing', 'applying', 'waiting', 'cooldown', 'finished'] as const;
type LiveActivityPhase = typeof LIVE_ACTIVITY_PHASES[number];
export interface LiveActivity { phase: LiveActivityPhase; detail?: string }
