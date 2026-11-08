/** Installation credentials stay on the server, never in candidate settings. */
export function adzunaConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return env.ADZUNA_ENABLED === 'true' && Boolean(env.ADZUNA_APP_ID?.trim() && env.ADZUNA_APP_KEY?.trim());
}
