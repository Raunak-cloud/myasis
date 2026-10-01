import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';
import type { CandidateProfile, JobListing } from './types.js';
import type { ToolContext } from './agent/tools.js';

/**
 * The speed-ups that must not change what the agent does:
 *  - a letter written ahead is reused after the apply step marks the listing;
 *  - wait_for_page returns early only on a page that has finished, never on
 *    one still loading, and never sooner than a person would.
 * Fixtures only: no real account, model or employer.
 */
const directory = mkdtempSync(join(tmpdir(), 'owtomate-agent-speed-'));
process.env.DATA_DIR = directory;
process.env.CELERIS_API_KEY = 'fixture-only';
process.env.COVER_LETTER_MODE = 'tailored';

let modelCalls = 0;
// Every model request hangs: only how many are made matters here.
globalThis.fetch = (async () => { modelCalls++; return new Promise<Response>(() => {}); }) as typeof fetch;

const { coverLetterForJob } = await import('./llm.js');
const { observe } = await import('./agent/observe.js');
const { executeTool } = await import('./agent/tools.js');
const { RunGuards } = await import('./agent/guards.js');
const { CostMeter } = await import('./agent/celeris.js');

const profile: CandidateProfile = { name: 'Fixture Person', phone: '0412345678', email: 'fixture@example.com', nationality: 'Australian', expectedSalary: '', noticePeriod: '', willingToRelocate: false, experienceSummary: 'Builds web apps.', skills: ['React'], excludedDomains: [], securityClearance: '' };

// ---- letter written ahead is reused ---------------------------------------
const job: JobListing = { id: 'fixture-1', title: 'Developer', company: 'Fixture Co', location: 'Sydney', url: 'https://example.com/job/1', description: 'Build React apps.' };
void coverLetterForJob(job, profile).catch(() => {});
await new Promise((resolve) => setTimeout(resolve, 300));
const afterFirst = modelCalls;
assert.ok(afterFirst >= 1, 'the first request drafts the letter');
// What the apply step does to the listing as it opens it.
job.applicationMode = 'hosted';
void coverLetterForJob(job, profile).catch(() => {});
await new Promise((resolve) => setTimeout(resolve, 300));
assert.equal(modelCalls, afterFirst, 'the letter written ahead is reused after the listing is marked hosted');
// A different listing is a different letter.
void coverLetterForJob({ ...job, id: 'fixture-2', description: 'Build Vue apps.' }, profile).catch(() => {});
await new Promise((resolve) => setTimeout(resolve, 300));
assert.ok(modelCalls > afterFirst, 'another listing gets its own letter');

// ---- wait_for_page --------------------------------------------------------
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : {}) });
try {
  const page = await browser.newPage();
  const context = async (): Promise<ToolContext> => ({
    page, profile, job, observation: await observe(page), captured: [], actions: [], log: () => {},
    guards: new RunGuards({ maxSteps: 30, maxStepsPerPage: 16, maxStuckMs: 60_000, maxTotalMs: 600_000, meter: new CostMeter(1) }),
  });
  const timed = async () => {
    const started = Date.now();
    const result = await executeTool(await context(), 'wait_for_page', {});
    return { ms: Date.now() - started, message: JSON.stringify(result) };
  };

  // A finished page: back after the human minimum, not the full ten seconds.
  await page.setContent('<main><h1>Your details</h1><label>Phone<input></label><button>Continue</button></main>');
  let r = await timed();
  assert.match(r.message, /finished loading/, r.message);
  assert.ok(r.ms >= 1_900 && r.ms < 5_000, `settled page took ${r.ms} ms`);

  // A page that changes by itself: reported as changed.
  await page.setContent('<main><p id="s">Loading…</p></main><script>setTimeout(() => { document.getElementById("s").textContent = "Step 2"; const i = document.createElement("input"); document.querySelector("main").append(i); }, 1500)</script>');
  r = await timed();
  assert.match(r.message, /changed/, r.message);

  // A page still busy (a spinner rewriting itself) is never called settled early.
  await page.setContent('<main><p id="s">Loading</p></main><script>let n = 0; setInterval(() => { document.getElementById("s").dataset.n = String(n++); }, 300)</script>');
  r = await timed();
  assert.doesNotMatch(r.message, /finished loading/, r.message);
  assert.ok(r.ms >= 9_500, `busy page returned after ${r.ms} ms`);

  console.log('PASS: letters written ahead are reused; waits end early only on settled pages, never before 2 s');
} finally {
  await browser.close();
  rmSync(directory, { recursive: true, force: true });
}
process.exit(0);
