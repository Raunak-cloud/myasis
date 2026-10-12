/** Installation pilot, resolved for the account owning the run, never its operator. */
export function browserRunEnvironment(targetIsAdmin: boolean, mode: 'search' | 'live', pilotEnabled: string | undefined): Record<string, string> {
  const headless = targetIsAdmin && mode === 'search' && pilotEnabled === 'true';
  return {
    HEADLESS: String(headless),
    // Each account must launch its own persistent Chrome in the selected mode.
    BROWSER_CONNECT_CDP: 'false',
  };
}
