import type { Page } from 'patchright';
import { runAgent } from '../agent/agent.js';
import { distill } from '../browser/distill.js';
import { captureJson, embeddedJson, scrollToLoad, visit } from '../browser/session.js';
import { findRecords } from '../core/harvest.js';
import { BlockedError } from '../core/politeness.js';
import type { EvidenceStore } from '../core/store.js';
import type { Brief, Evidence, SourceId, Task } from '../core/types.js';
import type { CostMeter } from '../llm/celeris.js';
import { extractRecords } from '../llm/extract.js';

/**
 * A source is a declaration: what it yields, what its query means, whether
 * it can run with this configuration, and how to collect. The planner reads
 * the declarations; adding a platform is one new file in this folder and
 * one line in the registry.
 */
export interface Source {
  id: SourceId;
  label: string;
  /** For the planner: what this source yields and when it is worth using. */
  describe: string;
  /** For the planner: what `Task.query` must be for this source. */
  queryHint: string;
  /** Why it cannot run with the current configuration, or "" when it can. */
  unavailable(): string;
  /** Default items per task. */
  defaultLimit: number;
  run(task: Task, ctx: SourceContext): Promise<Evidence[]>;
}

export interface SourceContext {
  deadline?: number;
  collectionNotes?: string[];
  brief: Brief;
  store: EvidenceStore;
  meter: CostMeter;
  log: (line: string) => void;
}

/**
 * The three-tier read every browser source shares, most reliable first:
 *  1. the platform's own JSON — network responses and embedded hydration
 *     data — selected by what a record is, not where it sits;
 *  2. celeris-1 schema extraction over the rendered page text;
 *  3. the browser agent, when the data sits behind a search box or filters
 *     that no URL reaches.
 * Each tier runs only if the one before found nothing.
 */
export interface BrowseSpec<T extends Record<string, unknown>> {
  url: string;
  /** Network responses worth reading. */
  jsonUrl?: RegExp;
  /** Tier 1: is this JSON object one record? */
  isRecord?: (node: Record<string, unknown>) => boolean;
  /** Tier 1: record → evidence (return undefined to drop it). */
  fromRecord?: (node: Record<string, unknown>, page: Page) => Evidence | undefined;
  /** Tier 2/3: what to extract and its fields. */
  instruction: string;
  /** Tier 2 off: for pages whose text holds nothing the records need. */
  textFallback?: boolean;
  itemProperties: Record<string, unknown>;
  itemKey: (item: T) => string;
  fromItem: (item: T, sourceUrl: string) => Evidence | undefined;
  /** Tier 3: the goal handed to the agent; omit to skip the agent. */
  agentGoal?: string;
  allowedHosts?: string[];
  limit: number;
  maxScrolls?: number;
}

export async function browseAndExtract<T extends Record<string, unknown>>(page: Page, spec: BrowseSpec<T>, ctx: SourceContext): Promise<Evidence[]> {
  const capture = spec.jsonUrl ? captureJson(page, spec.jsonUrl) : undefined;
  const byId = new Map<string, Evidence>();
  const harvest = async () => {
    if (!spec.isRecord || !spec.fromRecord) return byId.size;
    const docs = [...(capture?.docs.map((doc) => doc.json) ?? []), ...(await embeddedJson(page)).map((doc) => doc.json)];
    for (const doc of docs) {
      for (const node of findRecords(doc, spec.isRecord)) {
        const item = spec.fromRecord(node, page);
        if (item && !byId.has(item.id)) byId.set(item.id, item);
      }
    }
    return byId.size;
  };

  try {
    await visit(page, spec.url);
    await harvest();
    if (spec.isRecord) {
      await scrollToLoad(page, { maxScrolls: spec.maxScrolls ?? 8, target: spec.limit, count: harvest });
    }
  } finally {
    await capture?.stop();
  }
  if (byId.size) {
    ctx.log(`  ${byId.size} records from the platform's own data`);
    return [...byId.values()].slice(0, spec.limit);
  }

  const facts = await distill(page, 60_000);
  if (spec.textFallback !== false && facts.markdown.length > 200) {
    const items = await extractRecords<T>({
      content: facts.markdown,
      instruction: spec.instruction,
      itemProperties: spec.itemProperties,
      key: spec.itemKey,
      meter: ctx.meter,
      maxItems: spec.limit,
      context: `Page: ${facts.title} — ${facts.url}`,
      log: ctx.log,
    });
    const evidence = items.map((item) => spec.fromItem(item, page.url())).filter((item): item is Evidence => Boolean(item));
    if (evidence.length) {
      ctx.log(`  ${evidence.length} records read from the page text`);
      return evidence;
    }
  }

  if (!spec.agentGoal) return [];
  ctx.log('  nothing on the landing page; handing over to the browser agent');
  const outcome = await runAgent(page, {
    goal: spec.agentGoal,
    startUrl: page.url(),
    recordProperties: spec.itemProperties,
    recordKey: (record) => spec.itemKey(record as T),
    meter: ctx.meter,
    maxRecords: spec.limit,
    allowedHosts: spec.allowedHosts,
    log: ctx.log,
  });
  ctx.log(`  agent ${outcome.status} after ${outcome.steps} steps: ${outcome.summary}`);
  if (!outcome.records.length && outcome.status !== 'done') {
    if (outcome.status === 'blocked') throw new BlockedError(new URL(spec.url).hostname, outcome.summary);
    throw new Error(`Browser collection incomplete (${outcome.status}): ${outcome.summary.slice(0, 180)}`);
  }
  return outcome.records
    .map((record) => spec.fromItem(record as unknown as T, record.sourceUrl))
    .filter((item): item is Evidence => Boolean(item));
}
