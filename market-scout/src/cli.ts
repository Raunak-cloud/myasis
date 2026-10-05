#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { config } from './config.js';
import { runAgent } from './agent/agent.js';
import { closeBrowser, withPage } from './browser/session.js';
import { EvidenceStore } from './core/store.js';
import type { Brief, SourceId } from './core/types.js';
import { CostMeter } from './llm/celeris.js';
import { runResearch } from './research.js';
import { SOURCES, sourceById } from './sources/index.js';

const HELP = `market-scout — public marketing research with a Celeris browser agent

  research   Plan, collect, analyse and write an evidence-cited brief
    --product "what you sell"     --niche "category"        --brand "name"
    --competitors "a,b,c"         --sites "https://a.com,b.com"
    --country AU  --language en   --audience "who buys"     --goal "..." (repeatable)
    --sources "meta-ads,reddit"   --max-tasks 14  --follow-ups 6  --budget 1.5
    --brief brief.json            (any of the above as JSON)
    --resume <run dir>            (re-analyse and re-write a run's report)
    --run-dir <dir>               (where to write the run; default .scout/runs/<time>-<brand>)

  collect <source> "<query>"      Run one source and print what it found
  agent <url> "<goal>"            Let the browser agent research one goal
  sources                         List sources and whether each can run
  ui                              Open the local web interface (http://127.0.0.1:5190)

Every model call is Celeris: celeris-1 for extraction and tagging,
celeris-1-magnus for planning, browsing, analysis and writing.`;

const list = (value: unknown) => (typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter(Boolean) : []);

// Started by the web interface: a stop request closes the browser cleanly before exiting.
process.on('message', (message: { type?: string }) => {
  if (message?.type !== 'stop') return;
  console.log('Stopping: closing the browser. Evidence collected so far is kept; use "Write report" to report on it.');
  void closeBrowser().finally(() => process.exit(130));
});
// The channel must not keep a finished run alive.
process.channel?.unref();

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      product: { type: 'string' },
      niche: { type: 'string' },
      brand: { type: 'string' },
      competitors: { type: 'string' },
      sites: { type: 'string' },
      country: { type: 'string' },
      language: { type: 'string' },
      audience: { type: 'string' },
      goal: { type: 'string', multiple: true },
      sources: { type: 'string' },
      'max-tasks': { type: 'string' },
      'follow-ups': { type: 'string' },
      'run-dir': { type: 'string' },
      budget: { type: 'string' },
      brief: { type: 'string' },
      resume: { type: 'string' },
      limit: { type: 'string' },
      headed: { type: 'boolean' },
    },
  });
  if (values.budget) config.budget.usd = Number(values.budget);
  if (values.headed) config.browser.headless = false;

  switch (command) {
    case 'sources': {
      for (const source of SOURCES) {
        const why = source.unavailable();
        console.log(`${why ? '✗' : '✓'} ${source.id.padEnd(16)} ${source.label}${why ? `\n    ${why}` : ''}\n    query: ${source.queryHint}`);
      }
      return;
    }

    case 'collect': {
      const [id, query] = positionals;
      const source = sourceById(id as SourceId);
      if (!source || !query) throw new Error('Usage: collect <source> "<query>"');
      const why = source.unavailable();
      if (why) throw new Error(why);
      const meter = new CostMeter(config.budget.usd);
      const store = new EvidenceStore(join(config.dataDir, 'collect'));
      try {
        const items = await source.run(
          { source: source.id, query, limit: Number(values.limit) || source.defaultLimit, why: 'manual' },
          { brief: briefFrom(values), store, meter, log: console.log },
        );
        store.add(items);
        for (const item of items.slice(0, 40)) {
          const metrics = Object.entries(item.metrics).map(([k, v]) => `${k}=${v}`).join(' ');
          console.log(`- [${item.kind}] ${item.author ? `${item.author}: ` : ''}${(item.title || item.text).slice(0, 100).replace(/\s+/g, ' ')}${metrics ? `  (${metrics})` : ''}\n  ${item.url}`);
        }
        console.log(`\n${items.length} items · ${meter.summary()} · saved to ${store.dir}`);
      } finally {
        await closeBrowser();
      }
      return;
    }

    case 'agent': {
      const [url, goal] = positionals;
      if (!url || !goal) throw new Error('Usage: agent <url> "<goal>"');
      const meter = new CostMeter(config.budget.usd);
      try {
        const result = await withPage((page) =>
          runAgent(page, {
            goal,
            startUrl: url,
            recordProperties: {
              title: { type: 'string' },
              text: { type: 'string' },
              author: { type: 'string' },
              date: { type: 'string' },
              link: { type: 'string' },
            },
            recordKey: (r) => `${String(r.link ?? '')}|${String(r.text ?? '').slice(0, 80)}`,
            meter,
            maxRecords: Number(values.limit) || 30,
            log: console.log,
          }),
        );
        console.log(JSON.stringify(result, null, 2));
        console.log(meter.summary());
      } finally {
        await closeBrowser();
      }
      return;
    }

    case 'research': {
      if (values.resume) {
        const brief = JSON.parse(readFileSync(join(values.resume, 'brief.json'), 'utf8')) as Brief;
        await runResearch(brief, { runDir: values.resume, reportOnly: true });
        return;
      }
      const brief = briefFrom(values);
      if (!brief.product && !brief.niche) throw new Error('Give at least --product or --niche (or --brief file.json).');
      await runResearch(brief, {
        runDir: values['run-dir'],
        maxTasks: Number(values['max-tasks']) || undefined,
        followUps: values['follow-ups'] !== undefined ? Number(values['follow-ups']) : undefined,
      });
      return;
    }

    case 'ui': {
      const { startUi } = await import('./ui/server.js');
      await startUi();
      return;
    }

    default:
      console.log(HELP);
  }
}

function briefFrom(values: Record<string, unknown>): Brief {
  const file = typeof values.brief === 'string' && existsSync(values.brief) ? (JSON.parse(readFileSync(values.brief, 'utf8')) as Partial<Brief>) : {};
  const text = (key: string) => (typeof values[key] === 'string' ? (values[key] as string).trim() : '');
  return {
    product: text('product') || file.product || '',
    niche: text('niche') || file.niche || '',
    brand: text('brand') || file.brand || '',
    competitors: list(values.competitors).length ? list(values.competitors) : file.competitors ?? [],
    websites: list(values.sites).length ? list(values.sites) : file.websites ?? [],
    country: (text('country') || file.country || 'AU').toUpperCase(),
    language: (text('language') || file.language || 'en').toLowerCase(),
    audience: text('audience') || file.audience || '',
    goals: (values.goal as string[] | undefined)?.length ? (values.goal as string[]) : file.goals ?? [],
    sources: (list(values.sources).length ? list(values.sources) : file.sources ?? []) as SourceId[],
  };
}

main().catch(async (error) => {
  console.error(`\n✗ ${(error as Error).message}`);
  await closeBrowser();
  process.exit(1);
});
