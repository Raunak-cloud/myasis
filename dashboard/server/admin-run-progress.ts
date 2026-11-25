import { open, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { groupRunFilters, RUN_FILTER_LABELS, type RunFilterCounts } from '../../seek-bot/src/run-progress.js';
import type { AdminRunProgress } from '../src/admin-run-progress.js';
import { userDir } from './userdata.js';

interface ProgressRun {
  id: string;
  userId: string;
  finishedAt: string | null;
  running: boolean;
  logFile: string | null;
  health: unknown;
}

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const fields = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const sourceNames = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && /^[\w .-]{1,40}$/.test(item)))].slice(0, 12) : [];

function recordedProgress(health: unknown, legacy?: AdminRunProgress | null): AdminRunProgress | null {
  const record = fields(health);
  const search = fields(record.search);
  const filters: RunFilterCounts = {};
  const rawFilters = fields(search.filters);
  for (const key of Object.keys(RUN_FILTER_LABELS) as Array<keyof RunFilterCounts>) {
    const value = count(rawFilters[key]);
    if (value) filters[key] = value;
  }
  const reviewed = count(record.reviewed);
  const result: AdminRunProgress = {
    found: count(search.found) ?? legacy?.found ?? null,
    reviewed: reviewed ?? legacy?.reviewed ?? null,
    reviewedEstimated: reviewed === null && legacy?.reviewedEstimated === true,
    matched: count(search.matched) ?? legacy?.matched ?? null,
    reviewLimit: search.reviewLimit === 'unlimited' ? 'unlimited' : count(search.reviewLimit) ?? legacy?.reviewLimit ?? null,
    sources: Array.isArray(search.sources) ? sourceNames(search.sources) : legacy?.sources ?? [],
    filters: search.filters ? filters : legacy?.filters ?? {},
    needsAttention: count(record.needsHuman) ?? legacy?.needsAttention ?? null,
    errors: count(record.errors) ?? legacy?.errors ?? null,
    unconfirmed: count(record.unconfirmedSubmits) ?? legacy?.unconfirmed ?? null,
  };
  return result.found !== null || result.reviewed !== null || result.matched !== null || result.sources.length
    || result.needsAttention !== null || result.errors !== null || result.unconfirmed !== null ? result : null;
}

/** Read historical console output one line at a time. Only the aggregate is retained. */
async function readLegacyProgress(path: string): Promise<AdminRunProgress | null> {
  const file = await open(path, 'r').catch(() => null);
  if (!file) return null;
  const input = file.createReadStream({ encoding: 'utf8', highWaterMark: 64 * 1024 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const reasons = new Map<string, number>();
  let found: number | null = null, matched: number | null = null, reviews = 0, passes = 0, restored = 0;
  let needsAttention = 0, errors = 0, unconfirmed = 0, hasSummary = false, inFilters = false;
  let reviewLimit: AdminRunProgress['reviewLimit'] = null;
  let sources: string[] = [];
  try {
    for await (const line of lines) {
      // Diagnostic and trace objects can be large. Only console lines with the
      // existing search and outcome markers are relevant to this summary.
      if (line.length > 16_384 || line.includes('[run-diagnostic]')) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch { continue; }
      const raw = fields(value).text;
      if (typeof raw !== 'string') continue;
      const text = raw.trim().replace(/^\[worker:[a-z]+\]\s*/, '');
      let match: RegExpMatchArray | null;
      if ((match = text.match(/^(\d+) unique listings discovered\b/i))) found = count(Number(match[1]));
      else if ((match = text.match(/^(\d+) qualifying jobs\.?$/i))) matched = count(Number(match[1]));
      else if (/^✓\s+\d+\s+·/.test(text)) { reviews++; passes++; }
      else if (/^✗\s+\d+\s+·|^✗\s+.+\(from the search result(?:; not opened)?\)$/.test(text)) reviews++;
      else if (text.startsWith('Review slot restored:')) restored++;
      else if ((match = text.match(/^Platforms this run:\s*(.+)$/))) sources = sourceNames(match[1].split(',').map(name => name.trim()));
      else if (text.startsWith('overrides:') && (match = text.match(/\bMAX_EVALUATIONS=(\d+|none)(?=\s|$)/))) {
        reviewLimit = match[1] === 'none' ? 'unlimited' : count(Number(match[1]));
      } else if (/^⏸ needs your answer:/i.test(text)) needsAttention++;
      else if (/^Submission not confirmed:/i.test(text)) unconfirmed++;
      else if (/^✗ (?:unexpected )?error:|^! fit check failed|^Fatal:/i.test(text)) errors++;
      else if (/^(?:=== (?:Run|Semi auto) complete:|■ (?:run|scan) finished)/.test(text)) hasSummary = true;

      if (text === 'Filtered out:') {
        reasons.clear();
        inFilters = true;
      } else if (inFilters && text) {
        const reason = text.match(/^(\d+) × (.+)$/);
        if (reason && count(Number(reason[1])) !== null) reasons.set(reason[2], Number(reason[1]));
        else inFilters = false;
      }
    }
  } catch {
    return null; // Log rotation or an interrupted read must not fail the run list.
  } finally {
    lines.close();
    input.destroy();
  }
  const hasSearch = found !== null || matched !== null || reviews > 0;
  if (!hasSearch && !sources.length && !needsAttention && !errors && !unconfirmed) return null;
  return {
    found, reviewed: hasSearch ? Math.max(0, reviews - restored) : null, reviewedEstimated: hasSearch,
    matched: matched ?? (reviews ? Math.max(0, passes - restored) : null),
    reviewLimit, sources, filters: groupRunFilters(reasons),
    needsAttention: hasSummary || needsAttention ? needsAttention : null,
    errors: hasSummary || errors ? errors : null,
    unconfirmed: hasSummary || unconfirmed ? unconfirmed : null,
  };
}

const history = new Map<string, Promise<AdminRunProgress | null>>();

async function loadProgress(run: ProgressRun, directory: string): Promise<AdminRunProgress | null> {
  let health = run.health;
  if (run.running) {
    try {
      const live = fields(JSON.parse(await readFile(resolve(directory, 'run-health.json'), 'utf8')));
      if (live.runStartId === run.id) health = live;
    } catch { /* The worker might not have published progress yet. */ }
  }
  if (count(fields(fields(health).search).found) !== null) return recordedProgress(health);

  const file = resolve(directory, 'run-logs', basename(run.logFile ?? `${run.id}.jsonl`));
  if (!run.finishedAt) return recordedProgress(health, run.running ? await readLegacyProgress(file) : null);
  if (!run.logFile) return recordedProgress(health);
  let saved = history.get(file);
  if (!saved) {
    saved = readLegacyProgress(file);
    if (history.size >= 600) history.delete(history.keys().next().value!);
    history.set(file, saved);
  }
  return recordedProgress(health, await saved);
}

/** Bound concurrent reads when the Runs page opens a long history. */
export async function loadAdminRunProgress(runs: ProgressRun[], directoryFor = userDir): Promise<Map<string, AdminRunProgress | null>> {
  const progress = new Map<string, AdminRunProgress | null>();
  const pending = runs.values();
  await Promise.all(Array.from({ length: Math.min(6, runs.length) }, async () => {
    for (const run of pending) progress.set(run.id, await loadProgress(run, directoryFor(run.userId)));
  }));
  return progress;
}
