/** Credential-free choices shared by admin controls and worker authorization. */
export const APPLICATION_MODELS = ['celeris', 'minimax'] as const;
export type ApplicationModel = typeof APPLICATION_MODELS[number];
/** Customer application, writing and supervision route. Comparisons stay isolated. */
export const CUSTOMER_APPLICATION_MODEL: ApplicationModel = 'celeris';
export const isApplicationModel = (value: unknown): value is ApplicationModel =>
  (APPLICATION_MODELS as readonly unknown[]).includes(value);
export const applicationModelLabel = (value: unknown): string =>
  value === 'minimax' ? 'MiniMax M3.1' : 'Celeris Magnus';
/** Server-owned transport capabilities. Credentials never belong in this catalogue.
 * Published USD/token estimates; actual provider charges always take precedence. */
export const OPENROUTER_APPLICATION_MODELS = {
  minimax: { model: 'minimax/minimax-m3.1-flash', initialEffort: 'medium', efforts: ['low', 'medium', 'high'],
    reducedEffort: 'low', temperature: true, serializedTools: true,
    rates: { prompt: 0.00000015, cached: 0.000000015, completion: 0.0000006 } },
} as const;
