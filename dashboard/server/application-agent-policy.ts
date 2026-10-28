
export function applicationAgentSettingsError(updates: Record<string, unknown>, admin: boolean): { status: number; error: string } | null {
  if (updates.APPLICATION_AGENT_MODE_AUTHORIZED !== undefined) return { status: 403, error: 'Application mode authorization is managed by the server.' };
  if (updates.APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN !== undefined) {
    if (!admin) return { status: 403, error: 'Screenshot testing is available only to administrators.' };
    if (!['true', 'false'].includes(String(updates.APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN))) return { status: 400, error: 'Choose whether screenshots each step are on or off.' };
  }
  if (updates.APPLICATION_AGENT_MODE === undefined) return null;
  if (!admin) return { status: 403, error: 'Application decision mode is available only to administrators.' };
  if (!(['agent-only'] as readonly unknown[]).includes(updates.APPLICATION_AGENT_MODE)) return { status: 400, error: 'Only Agent-only application decisions are supported.' };
  return null;
}

/** Rechecked against the active account on every manual, queued or scheduled run. */
export function applicationAgentModeForAccount(_value: unknown, _admin: boolean): 'agent-only' {
  return 'agent-only';
}

/** Every account gets screenshots; only admins may explicitly opt out for testing. */
export function applicationScreenshotsForAccount(value: unknown, admin: boolean): 'true' | 'false' {
  return admin && value === 'false' ? 'false' : 'true';
}
