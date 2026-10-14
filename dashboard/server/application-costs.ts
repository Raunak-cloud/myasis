import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { query } from './db/index.js';
import { summariseApplicationCosts, type UsageEvent } from '../src/application-cost.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseCostEvent(line: string): UsageEvent | null {
  try {
    const value = JSON.parse(line) as UsageEvent;
    if (!value || !uuid.test(value.id) || !uuid.test(value.runId) || !Number.isFinite(Date.parse(value.at)) || !['usage', 'submitted', 'started', 'finished'].includes(value.kind)) return null;
    if (value.jobId !== undefined && (typeof value.jobId !== 'string' || value.jobId.length > 300)) return null;
    if (value.amountUsd != null && (typeof value.amountUsd !== 'number' || !Number.isFinite(value.amountUsd) || value.amountUsd < 0)) return null;
    for (const key of ['provider', 'model', 'detail'] as const) if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key]!.length > 2000)) return null;
    return value;
  } catch { return null; }
}
export function readCostJournal(dir: string): UsageEvent[] {
  const path = resolve(dir, 'cost-ledger.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').flatMap(line => { const event = parseCostEvent(line); return event ? [event] : []; });
}
export async function syncCostJournal(userId: string, dir: string): Promise<void> {
  const events = readCostJournal(dir);
  for (let i = 0; i < events.length; i += 200) {
    await query(`INSERT INTO application_cost_events (user_id, event_id, run_id, payload)
      SELECT $1, (event->>'id')::uuid, (event->>'runId')::uuid, event
      FROM jsonb_array_elements($2::jsonb) event ON CONFLICT (user_id, event_id) DO NOTHING`, [userId, JSON.stringify(events.slice(i, i + 200))]);
  }
}
/** The caller must check admin status before reading any cost data. userId always
 * comes from the authenticated session, never a query parameter. */
export async function loadApplicationCosts(userId: string, dir: string) {
  const rows = await query<{ payload: UsageEvent }>('SELECT payload FROM application_cost_events WHERE user_id = $1', [userId]);
  // Includes current progress before run-close sync; event IDs deduplicate it.
  return summariseApplicationCosts([...rows.map(r => r.payload), ...readCostJournal(dir)]);
}
