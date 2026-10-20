/** @public Shared with dashboard/server/job-sources.ts. */
export const EMPLOYER_BROWSER_PROVIDERS = ['local', 'brightdata'] as const;
type EmployerBrowserProvider = typeof EMPLOYER_BROWSER_PROVIDERS[number];
type Environment = Record<string, string | undefined>;

/** Server policy applies to every employer form; stale account choices cannot bypass it. */
export function employerBrowserProvider(env: Environment): EmployerBrowserProvider {
  if (env.BRIGHTDATA_BROWSER_ENABLED === 'true') return 'brightdata';
  const selected = env.EMPLOYER_BROWSER_PROVIDER || 'local';
  if (!EMPLOYER_BROWSER_PROVIDERS.includes(selected as EmployerBrowserProvider)) throw new Error('Choose a supported employer browser.');
  if (selected === 'local') return 'local';
  throw new Error('Bright Data employer browsers are not enabled on this server.');
}

/** The endpoint is fixed; neither a client nor a saved setting can choose a secret recipient. */
export function brightDataBrowserEndpoint(env: Environment): string {
  const username = env.BRIGHTDATA_BROWSER_USERNAME?.trim();
  const password = env.BRIGHTDATA_BROWSER_PASSWORD?.trim();
  if (!username || !/^brd-customer-[a-zA-Z0-9_-]+-zone-[a-zA-Z0-9_-]+$/.test(username) || !password) {
    throw new Error('Configure the Bright Data Browser API zone username and password before starting this pilot.');
  }
  return `wss://${encodeURIComponent(username)}:${encodeURIComponent(password)}@brd.superproxy.io:9222`;
}
