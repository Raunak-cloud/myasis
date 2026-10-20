import { applicationModelEnvironment } from './application-model.js';

export const APPLICATION_AGENT_MODES = ['protected', 'agent-only'] as const;
export type ApplicationAgentMode = (typeof APPLICATION_AGENT_MODES)[number];

/** This flag is issued only by the dashboard after checking the account owner.
 * It is never a saved preference or inherited from a shared worker environment.
 * Mode changes application decisions, not dry-run, source access or spending limits. */
export function isAgentOnlyApplication(
  env: Readonly<Record<string, string | undefined>> = applicationModelEnvironment(),
): boolean {
  return env.APPLICATION_AGENT_MODE === 'agent-only'
    && env.APPLICATION_AGENT_MODE_AUTHORIZED === 'true';
}
