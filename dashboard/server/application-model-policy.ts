const APPLICATION_MODELS = ['celeris', 'minimax'] as const;

export function applicationModelSettingsError(updates: Record<string, unknown>, admin: boolean): { status: number; error: string } | null {
  if (updates.APPLICATION_AI_MODEL === undefined) return null;
  if (!admin) return { status: 403, error: 'Application model selection is available only to administrators.' };
  if (!(APPLICATION_MODELS as readonly unknown[]).includes(updates.APPLICATION_AI_MODEL)) return { status: 400, error: 'Choose Celeris Magnus or MiniMax M3.1.' };
  return null;
}

/** Execution-time enforcement also covers stale saved settings and auto runs. */
export function applicationModelForAccount(value: unknown, admin: boolean): 'celeris' | 'minimax' {
  return admin && value === 'minimax' ? 'minimax' : 'celeris';
}
