/** Uses the same per-account network route as normal runs; holds it for the benchmark. */
import { accountBrowserEnvironment } from '../server/runner.js';
import { browserRoute } from '../server/route.js';
import { getPool } from '../server/db/index.js';
import { fileURLToPath } from 'node:url';

const userId = process.argv.find(arg => arg.startsWith('--user='))?.slice(7);
try {
  if (process.argv.includes('--live')) {
    if (!userId || !/^\d+$/.test(userId)) throw new Error('--user=<admin account id> required');
    const policy = await accountBrowserEnvironment(userId, 'search');
    if (policy.HEADLESS !== 'true') throw new Error('Enable the admin headless discovery pilot before benchmarking this account');
    const route = await browserRoute(userId);
    process.env.BROWSER_PROXY_SERVER = route.proxyServer ?? '';
    process.env.BENCHMARK_ROUTE = route.status.using;
  }
  process.chdir(fileURLToPath(new URL('../../seek-bot', import.meta.url)));
  await import(new URL('../../seek-bot/scripts/benchmark-browser.mjs', import.meta.url).href);
  await getPool().end();
  process.exit(0);
} catch (error) {
  console.error((error as Error).message);
  await getPool().end();
  process.exit(1);
}
