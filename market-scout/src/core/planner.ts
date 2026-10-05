import { SOURCES, sourceById } from '../sources/index.js';
import { askJson, type CostMeter } from '../llm/celeris.js';
import { searchEngineOf } from './politeness.js';
import type { Brief, Evidence, SourceId, Task, TaskResult } from './types.js';

/**
 * Turns a brief into collection tasks, and a first round's findings into a
 * second round — the "deep research" loop: search broadly, look at what came
 * back, then go after the leads it surfaced (an advertiser nobody named, a
 * subreddit where the audience actually talks, a rival's landing page).
 *
 * Magnus plans; code validates. A task for a source that cannot run, or a
 * duplicate, is dropped, and a deterministic baseline guarantees the core
 * coverage even if planning fails.
 */

function catalog(brief: Brief): string {
  return SOURCES.filter((source) => !brief.sources.length || brief.sources.includes(source.id))
    .map((source) => {
      const why = source.unavailable();
      return `- ${source.id}: ${source.label}. ${source.describe}\n  query: ${source.queryHint}\n  default limit: ${source.defaultLimit}${why ? `\n  UNAVAILABLE: ${why}` : ''}`;
    })
    .join('\n');
}

function allowed(brief: Brief, id: SourceId): boolean {
  const source = sourceById(id);
  return Boolean(source && !source.unavailable() && (!brief.sources.length || brief.sources.includes(id)));
}

export function baselinePlan(brief: Brief): Task[] {
  const seed = brief.niche || brief.product;
  const tasks: Task[] = [
    { source: 'autocomplete', query: seed, limit: 200, why: 'What people search for in this niche.' },
    { source: 'meta-ads', query: seed, limit: 50, why: 'Ads running in the niche.' },
    ...brief.competitors.slice(0, 5).map((name): Task => ({ source: 'meta-ads', query: name, limit: 40, why: `${name}'s Facebook and Instagram ads.` })),
    ...brief.websites.slice(0, 5).map((url): Task => ({ source: 'website', query: url, limit: 7, why: 'Positioning, pricing, SEO and stack.' })),
    { source: 'reddit', query: seed, limit: 40, why: 'Voice of customer.' },
    { source: 'youtube', query: seed, limit: 25, why: 'Content demand.' },
    { source: 'tiktok-creative', query: 'hashtags', limit: 30, why: 'Trending hashtags.' },
  ];
  return tasks.filter((task) => allowed(brief, task.source));
}

const TASKS_SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: SOURCES.map((source) => source.id) },
          query: { type: 'string' },
          limit: { type: 'integer' },
          why: { type: 'string' },
        },
      },
    },
  },
};

export function validateTasks(brief: Brief, tasks: unknown, existing: Task[], max: number): Task[] {
  const seen = new Set(existing.map((task) => `${task.source}|${task.query.trim().toLowerCase()}`));
  const out: Task[] = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (out.length >= max) break;
    if (!task || typeof task.source !== 'string' || typeof task.query !== 'string' || !task.query.trim()) continue;
    const source = sourceById(task.source);
    const key = `${task.source}|${task.query.trim().toLowerCase()}`;
    if (!source || !task.query?.trim() || seen.has(key) || !allowed(brief, task.source)) continue;
    // A task that can only open a search-engine results page would be refused at the browser; do not spend a slot on it.
    if (task.source === 'agent' && searchEngineOf(task.query.split('::')[0].trim())) continue;
    if (task.source === 'website' || task.source === 'agent') {
      try { const url = new URL(task.query.split('::')[0].trim()); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) continue; } catch { continue; }
    }
    if (task.source === 'google-ads' && /\.[a-z]{2,}\b/i.test(task.query)) {
      const domain = task.query.replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '').toLowerCase();
      if (!brief.websites.some((u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase() === domain; } catch { return false; } })) continue;
    }
    seen.add(key);
    out.push({ source: source.id, query: task.query.trim().slice(0, 2000), why: `Collect available public evidence from ${source.label}; results may be limited.`, limit: Math.min(source.defaultLimit * 2, Math.max(5, Number.isFinite(task.limit) ? Math.floor(task.limit) : source.defaultLimit)) });
  }
  return out;
}

export async function planTasks(brief: Brief, meter: CostMeter, maxTasks: number): Promise<Task[]> {
  const baseline = baselinePlan(brief);
  const core = validateTasks(brief, baseline.filter((t) => t.source === 'website' || t.source === 'autocomplete'), [], maxTasks);
  try {
    const reply = await askJson<{ tasks: Task[] }>({
      model: 'celeris-1-magnus',
      system: 'You are a senior marketing researcher planning data collection. Choose the sources and exact queries that best answer the brief. Prefer specific queries (brand names, precise phrases, @handles, domains) over vague ones. Never plan tasks for UNAVAILABLE sources.',
      prompt: `BRIEF\n${JSON.stringify(brief, null, 2)}\n\nSOURCES\n${catalog(brief)}\n\nPlan up to ${maxTasks} tasks that together answer the goals: SEO keywords and questions, public ad examples without claims of performance, what organic content gets traction, the audience's own words, and how competitors position and price. Cover each competitor on the ad libraries that suit them (B2B → linkedin-ads too; any → google-ads by domain). Use 2-3 different autocomplete seeds when the niche has several angles.`,
      schema: TASKS_SCHEMA,
      meter,
      effort: 'medium',
      maxTokens: 4_000,
    });
    const planned = validateTasks(brief, reply.tasks ?? [], core, Math.max(0, maxTasks - core.length));
    return [...core, ...planned, ...validateTasks(brief, baseline, [...core, ...planned], Math.max(0, maxTasks - core.length - planned.length))];
  } catch {
    return [...core, ...validateTasks(brief, baseline, core, Math.max(0, maxTasks - core.length))];
  }
}

/** Leads worth following, mined from round one: names, places and handles that came up. */
function leads(evidence: Evidence[]): string {
  const count = (values: string[]) => {
    const tally = new Map<string, number>();
    for (const value of values.filter(Boolean)) tally.set(value, (tally.get(value) ?? 0) + 1);
    return [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([value, n]) => `${value} (${n})`).join(', ');
  };
  const hosts = evidence.flatMap((item) => {
    // Ad landing pages, outbound links, and sites the agent visited: the competitors the brief did not name.
    const url = String(item.attributes.landingUrl ?? item.attributes.outboundUrl ?? (item.source === 'agent' ? item.url : '') ?? '');
    try {
      return url ? [new URL(url).host.replace(/^www\./, '')] : [];
    } catch {
      return [];
    }
  });
  return [
    `Advertisers seen: ${count(evidence.filter((item) => item.kind === 'ad').map((item) => item.author))}`,
    `Websites seen (ad landing pages, outbound links, sites the agent visited) — audit the competitors among them with the website source: ${count(hosts)}`,
    `Subreddits: ${count(evidence.map((item) => String(item.attributes.subreddit ?? '')))}`,
    `Creators/accounts: ${count(evidence.filter((item) => item.kind === 'video' || item.kind === 'post').map((item) => item.author))}`,
    `Hashtags: ${count(evidence.flatMap((item) => (Array.isArray(item.attributes.hashtags) ? item.attributes.hashtags : [])))}`,
  ].join('\n');
}

export async function planFollowUp(brief: Brief, results: TaskResult[], evidence: Evidence[], meter: CostMeter, maxTasks: number): Promise<Task[]> {
  if (maxTasks <= 0) return [];
  const done = results.map((result) => `- ${result.task.source} "${result.task.query}": ${result.ok ? `${result.count} items` : `failed — ${result.note}`}`).join('\n');
  try {
    const reply = await askJson<{ tasks: Task[] }>({
      model: 'celeris-1-magnus',
      system: 'You are a senior marketing researcher reviewing a first round of data collection and deciding what to collect next. Follow concrete leads; fill gaps; do not repeat tasks. Never plan tasks for UNAVAILABLE sources or for sources that were blocked.',
      prompt: `BRIEF\n${JSON.stringify(brief, null, 2)}\n\nSOURCES\n${catalog(brief)}\n\nROUND ONE\n${done}\n\nLEADS FOUND\n${leads(evidence)}\n\nPlan up to ${maxTasks} follow-up tasks: competitors discovered in the ads but not yet researched (their ads on other libraries, their websites), the communities where the audience talks, top creators' profiles, and any goal round one left thin. Return an empty list if coverage is already sufficient.`,
      schema: TASKS_SCHEMA,
      meter,
      effort: 'medium',
      maxTokens: 4_000,
    });
    const scope = (task: Task) => {
      if (task.source === 'website' || task.source === 'agent') { try { return `${task.source}|${new URL(task.query.split('::')[0].trim()).hostname}`; } catch { return task.source; } }
      return task.source;
    };
    const blockedSources = new Set(results.filter((result) => !result.ok && /refused|blocked|wall|challenge|captcha/i.test(result.note)).map((result) => scope(result.task)));
    return validateTasks(brief, reply.tasks, results.map((result) => result.task), maxTasks).filter((task) => !blockedSources.has(scope(task)));
  } catch {
    return [];
  }
}
