/** Account-level application providers. Keep the administrator picker explicit. */
export const APPLICATION_AI_MODELS = [
  { value: 'celeris', label: 'Celeris' },
  { value: 'haiku', label: 'Claude Haiku 5.5' },
] as const;

export type ApplicationAiModel = (typeof APPLICATION_AI_MODELS)[number]['value'];

export function isApplicationAiModel(value: unknown): value is ApplicationAiModel {
  return APPLICATION_AI_MODELS.some(model => model.value === value);
}
