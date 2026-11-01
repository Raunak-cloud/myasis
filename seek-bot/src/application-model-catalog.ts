/** Credential-free choices shared by admin controls and worker authorization. */
export const APPLICATION_MODELS = ['celeris', 'minimax', 'qwen'] as const;
export type ApplicationModel = typeof APPLICATION_MODELS[number];
export const isApplicationModel = (value: unknown): value is ApplicationModel =>
  (APPLICATION_MODELS as readonly unknown[]).includes(value);
export const applicationModelLabel = (value: unknown): string =>
  value === 'qwen' ? 'Qwen 3.7 Flash' : value === 'minimax' ? 'MiniMax M3.1' : 'Celeris Magnus';
export const OPENROUTER_APPLICATION_MODELS = {
  minimax: { model: 'minimax/minimax-m3.1-flash', structuredOutput: 'json_schema' },
  qwen: { model: 'qwen/qwen3.7-flash', structuredOutput: 'json_object' },
} as const;
