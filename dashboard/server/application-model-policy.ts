export const APPLICATION_MODELS = ['celeris'] as const;

export function applicationModelSettingsError(updates: Record<string, unknown>, admin: boolean): { status: number; error: string } | null {
  if (updates.APPLICATION_AI_MODEL === undefined) return null;
  if (!admin) return { status: 403, error: 'Application model selection is available only to administrators.' };
  if (!(APPLICATION_MODELS as readonly unknown[]).includes(updates.APPLICATION_AI_MODEL)) return { status: 400, error: 'Only Celeris Magnus is supported.' };
  return null;
}

/** Execution-time enforcement also covers stale saved settings and auto runs. */
export function applicationModelForAccount(_value: unknown, _admin: boolean): 'celeris' {
  return 'celeris';
}
