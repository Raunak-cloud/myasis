/** Credential-free choices shared by admin controls and worker authorization. */
export const APPLICATION_MODELS = ['celeris', 'minimax'] as const;
export type ApplicationModel = typeof APPLICATION_MODELS[number];
export const isApplicationModel = (value: unknown): value is ApplicationModel =>
  (APPLICATION_MODELS as readonly unknown[]).includes(value);
export const applicationModelLabel = (value: unknown): string =>
  value === 'minimax' ? 'MiniMax M3.1' : 'Celeris Magnus';
export const OPENROUTER_APPLICATION_MODELS = {
  minimax: { model: 'minimax/minimax-m3.1-flash' },
} as const;
