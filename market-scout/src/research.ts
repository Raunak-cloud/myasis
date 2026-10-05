import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from './config.js';
import { closeBrowser } from './browser/session.js';
import { planFollowUp, planTasks } from './core/planner.js';
import { reviewEvidence } from './core/quality.js';
import { candidateUrl, discoverMarket } from './core/discovery.js';
import { BlockedError } from './core/politeness.js';
import { EvidenceStore } from './core/store.js';
import type { Brief, Task, TaskResult } from './core/types.js';
import { analyzeAds } from './insights/ads.js';
import { analyzeCompetitors } from './insights/competitors.js';
import { analyzeKeywords } from './insights/keywords.js';
import { analyzeSocial } from './insights/social.js';
import { BudgetExceededError, CostMeter } from './llm/celeris.js';
import { mapLimit } from './llm/extract.js';
import { renderHtml, renderMarkdown } from './report/render.js';
import { synthesize, type Report } from './report/synthesize.js';
import { sourceById } from './sources/index.js';

/**
 * One research run, end to end:
 *   plan → collect (round 1) → plan follow-ups from what came back → collect
 *   (round 2) → measure → write the brief → fact-check → render.
 *
 * Everything collected is written to disk as it arrives, so a stopped run can
 * be reported on with `--resume`.
 */

export interface RunOptions {
  runDir?: string;
  maxTasks?: number;
  followUps?: number;
  /** Skip collection and report on what the run directory already holds. */
  reportOnly?: boolean;
  /** Run these tasks instead of planning. */
  tasks?: Task[];
  log?: (line: string) => void;
}

export interface RunOutput {
  report: Report;
  dir: string;
  files: { html: string; markdown: string; json: string; evidence: string };
}

export async function runResearch(brief: Brief, options: RunOptions = {}): Promise<RunOutput> {
  if (brief.ownWebsite) {
    const ownWebsite = candidateUrl(brief.ownWebsite);
    if (!ownWebsite) throw new Error('Your website must be a public HTTPS address.');
    brief = { ...brief, ownWebsite, websites: [...new Set([...brief.websites, ownWebsite])] };
  }
  const log = options.log ?? ((line: string) => console.log(line));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const slug = (brief.brand || brief.niche || 'research').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  const dir = resolve(options.runDir ?? join(config.dataDir, 'runs', `${stamp}-${slug}`));
  const store = new EvidenceStore(dir);
  const meter = new CostMeter(config.budget.usd);
  const deadline = Date.now() + config.budget.maxMs;
  const coverage: TaskResult[] = [];
  store.writeJson('brief.json', brief);
  log(`Run folder: ${dir}`);

  const runTasks = async (planned: Task[]) => {
    const tasks = interleave(planned);
    log(`\n${tasks.length} tasks:\n${tasks.map((t) => `  · ${t.source} "${t.query}" (${t.limit}) — ${t.why}`).join('\n')}`);
    await mapLimit(tasks, Math.max(1, config.budget.concurrency), async (task) => {
      const source = sourceById(task.source)!;
      const started = Date.now();
      const record = (ok: boolean, count: number, note: string) => {
        coverage.push({ task, ok, count, note, ms: Date.now() - started });
        log(`${ok ? '✓' : '✗'} ${task.source} "${task.query}": ${ok ? `${count} items` : note} (${Math.round((Date.now() - started) / 1000)}s)`);
      };
      if (Date.now() > deadline) return record(false, 0, 'run time limit reached before this task');
      if (meter.remaining < 0.25) return record(false, 0, 'model budget reserved for analysis');
      log(`→ ${task.source} "${task.query}"`);
      try {
        const items = await source.run(task, { brief, store, meter, log });
        store.add(items);
        record(true, items.length, items.length ? '' : 'No matching public evidence was returned.');
      } catch (error) {
        const note =
          error instanceof BlockedError ? error.message : error instanceof BudgetExceededError ? 'model budget spent' : (error as Error).message.split('\n')[0].slice(0, 240);
        record(false, 0, note);
      }
    });
  };

  try {
    if (!options.reportOnly) {
      if (brief.autoDiscover !== false && (brief.autoDiscover || !brief.websites.length || !brief.audience || !brief.niche)) {
        brief = await discoverMarket(brief, store, meter, log);
        store.writeJson('brief.json', brief);
        store.writeJson('discovery.json', brief.discovery);
      }
      const maxTasks = options.maxTasks ?? 14;
      const first = options.tasks ?? (await planTasks(brief, meter, maxTasks));
      if (!options.tasks && brief.ownWebsite && !first.some((t) => t.source === 'website' && t.query === brief.ownWebsite)) {
        first.unshift({ source: 'website', query: brief.ownWebsite, limit: 6, why: 'Audit your own website for page-specific improvements.' });
        if (first.length > maxTasks) first.pop();
      }
      await runTasks(first);
      const followUps = options.tasks ? [] : await planFollowUp(brief, coverage, reviewEvidence(store.all(), brief).evidence, meter, options.followUps ?? 6);
      if (followUps.length && Date.now() < deadline) await runTasks(followUps);
      store.writeJson('coverage.json', coverage);
    }
  } finally {
    await closeBrowser();
  }

  log(`\nCollected ${store.size} items. Analysing…`);
  const { evidence: all, quality } = reviewEvidence(store.all(), brief);
  store.writeJson('quality.json', quality);
  log(`Evidence review: ${quality.included} usable, ${quality.excluded} irrelevant, ${quality.unverified} awaiting verification.`);
  const [keywords, ads, social, competitors] = await Promise.all([
    analyzeKeywords(all, brief, meter),
    analyzeAds(all, meter),
    analyzeSocial(all, meter),
    analyzeCompetitors(all, meter),
  ]);
  const insights = { keywords, ads, social, competitors };
  store.writeJson('insights.json', insights);

  log('Building source-checked findings…');
  // The brief gets a little headroom past the collection budget: a run that collected everything should not end unreported.
  meter.reserve(0.15);
  const runCoverage = options.reportOnly ? readCoverage(store) : coverage;
  // The measured insights stand on their own; a failed write-up must not lose them.
  const draft = await synthesize(brief, insights, runCoverage, store, meter).catch((error: Error) => {
    log(`The written brief failed (${error.message.slice(0, 200)}); rendering the measured insights only.`);
    return {
      brief,
      generatedAt: new Date().toISOString(),
      headline: 'Measured insights (the written brief could not be produced)',
      executiveSummary: [],
      sections: [],
      recommendations: [],
      caveats: [`The written brief failed: ${error.message.slice(0, 200)}. Re-run with --resume to try again.`],
      insights,
      coverage: runCoverage,
    };
  });
  const report: Report = { ...draft, quality, version: 3, status: draft.sections.length && runCoverage.some((r) => r.ok && r.count > 0) ? 'ready' : 'partial', cost: meter.summary() };

  const files = {
    json: store.writeJson('report.json', report),
    markdown: join(dir, 'report.md'),
    html: join(dir, 'report.html'),
    evidence: join(dir, 'evidence.jsonl'),
  };
  writeFileSync(files.markdown, renderMarkdown(report, store));
  writeFileSync(files.html, renderHtml(report, store));
  log(`\nDone. ${meter.summary()}\n  ${files.html}\n  ${files.markdown}`);
  return { report, dir, files };
}

/**
 * Round-robin by source. Tasks for one source mostly hit one host, which is
 * paced one request at a time, so running them side by side only queues them;
 * interleaving keeps every concurrent slot on a different host.
 */
export function interleave(tasks: Task[]): Task[] {
  const bySource = new Map<string, Task[]>();
  for (const task of tasks) bySource.set(task.source, [...(bySource.get(task.source) ?? []), task]);
  const queues = [...bySource.values()];
  const out: Task[] = [];
  while (out.length < tasks.length) for (const queue of queues) if (queue.length) out.push(queue.shift()!);
  return out;
}

function readCoverage(store: EvidenceStore): TaskResult[] {
  try {
    return JSON.parse(readFileSync(join(store.dir, 'coverage.json'), 'utf8')) as TaskResult[];
  } catch {
    return [];
  }
}
