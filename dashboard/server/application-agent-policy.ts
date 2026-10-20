import { APPLICATION_AGENT_MODES, type ApplicationAgentMode } from '../../seek-bot/src/application-agent-mode.js';

export function applicationAgentSettingsError(updates: Record<string, unknown>, admin: boolean): { status: number; error: string } | null {
  if (updates.APPLICATION_AGENT_MODE_AUTHORIZED !== undefined) return { status: 403, error: 'Application mode authorization is managed by the server.' };
  if (updates.APPLICATION_AGENT_MODE === undefined) return null;
  if (!admin) return { status: 403, error: 'Application decision mode is available only to administrators.' };
  if (!(APPLICATION_AGENT_MODES as readonly unknown[]).includes(updates.APPLICATION_AGENT_MODE)) return { status: 400, error: 'Choose protected or agent-only application decisions.' };
  return null;
}

/** Rechecked against the active account on every manual, queued or scheduled run. */
export function applicationAgentModeForAccount(value: unknown, admin: boolean): ApplicationAgentMode {
  return admin && value === 'agent-only' ? 'agent-only' : 'protected';
}
