import { appReader, indexConfig, indexStore } from '../server/job-index/config.js';
import { minimaxReviewer } from '../server/job-index/review.js';
import { readEnv } from '../server/runner.js';
import { crawlCycle } from '../server/job-index/engine.js';

const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());
process.once('SIGINT', () => controller.abort());

const migrate = process.argv.includes('--migrate');
const once = process.argv.includes('--once');
let store: ReturnType<typeof indexStore> = null;
let reader: ReturnType<typeof appReader> | undefined;
try {
  if (!migrate && !once) throw Error('Choose --migrate or --once.');
  const config = indexConfig();
  store = indexStore();
  if (!config || !store) throw Error('Connect the external job database.');
  if (migrate) {
    await store.migrate();
  } else {
    reader = appReader(config);
    const reviewer = minimaxReviewer(store, (process.env.OPENROUTER_API_KEY ?? readEnv().OPENROUTER_API_KEY ?? '').trim());
    const stats = await crawlCycle(store, reader, {
      reviewer,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(4 * 60_000)]),
    });
    console.log('[job-index]', JSON.stringify(stats));
  }
} catch {
  console.warn('[job-index] Could not update the external job index. Check connection and source availability.');
  process.exitCode = 1;
} finally {
  await reader?.end();
  await store?.pool.end();
}
