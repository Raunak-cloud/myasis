import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityEvents, activitySummary, formatActivityReason } from '../src/activity.ts';
import { plainReason } from '../src/run-messages.ts';

const log = (texts) => texts.map((text, seq) => ({ seq, stream: 'out', text }));
const completion = (lines) => activityEvents(lines).find((event) => event.title === 'Run complete').detail;

test('seven matches and five submissions explain both previously hidden duplicates', () => {
  const lines = log([
    '▶ starting live run',
    '395 unique listings discovered across 2 platform(s) (adaptive stop).',
    '  ✓ 85 · Product Engineer @ eQ8 (Pyrmont NSW 2009) [Indeed]',
    '  – skipped (already applied): Product Engineer @ eQ8',
    '  ✓ 85 · Applications Specialist @ Ambition (Sydney NSW (Remote)) [SEEK] · Recommended',
    '  – skipped (already applied): Applications Specialist @ Ambition',
    ...['AI Automation Engineer', 'Digital Designer', 'Solution Specialist', 'Business Consulting', 'Technical Business Analyst'].flatMap((title, index) => [
      `  ✓ 85 · ${title} @ Employer ${index} (Sydney NSW) [SEEK]`,
      `→ Applying: ${title} @ Employer ${index}`,
      `  ✅ submitted (${index + 1}/20)`,
    ]),
    '7 qualifying jobs.',
    '=== Run complete: 5 new application(s) ===',
  ]);
  assert.deepEqual(activitySummary(lines), { found: 395, reviewed: 7, suitable: 7, submitted: 5, outcomeSummary: completion(lines), shortfall: null });
  for (const title of ['Product Engineer', 'Applications Specialist']) {
    const event = activityEvents(lines).find((event) => event.title === `Already applied to ${title}`);
    assert.equal(event.tone, 'neutral');
    assert.match(event.detail, /No new application was sent/);
  }
  assert.equal(completion(lines), '7 profile matches · 5 applications submitted · 2 skipped: already applied.');
});

test('duplicates detected on a form, other skips, human input and errors remain distinct', () => {
  const lines = log([
    ...['Duplicate', 'Duplicate listing', 'External limit', 'Needs answer', 'Failed', 'Skipped'].map((title) => `✓ 80 · ${title} @ Employer (Sydney NSW) [SEEK]`),
    '→ Applying: Duplicate @ Employer',
    '↩ already applied — SEEK shows an existing application.',
    '– skipped (same role already attempted this run): Duplicate listing @ Employer',
    '– skipped (daily limit of 5 employer-site applications reached): External limit @ Employer',
    '→ Applying: Needs answer @ Employer',
    '⏸ needs you: A screening answer is missing',
    '→ Applying: Failed @ Employer',
    '✗ error: Connection dropped',
    '→ Applying: Skipped @ Employer',
    '– skipped: Australian government application sites are excluded.',
    '=== Run complete: 0 new application(s) ===',
  ]);
  const events = activityEvents(lines);
  assert.equal(events.filter((event) => event.outcome === 'already-applied').length, 1);
  assert.equal(events.filter((event) => event.outcome === 'skipped').length, 3);
  assert.equal(completion(lines), '6 profile matches · 0 applications submitted · 1 skipped: already applied · 3 skipped for other reasons · 1 needs your attention · 1 application failed.');
  assert.equal(events.some((event) => event.title.startsWith('Applying to')), false);
});

test('a cap explains suitable jobs remaining without implying duplicate applications', () => {
  const lines = log([
    '✓ 80 · One @ Employer (Sydney NSW) [SEEK]',
    '✓ 80 · Two @ Employer (Sydney NSW) [SEEK]',
    '→ Applying: One @ Employer',
    '✅ submitted (1/1)',
    'Run cap of 1 reached.',
    '=== Run complete: 1 new application(s) ===',
  ]);
  assert.equal(completion(lines), '2 profile matches · 1 application submitted · 1 matched job not submitted: the application limit was reached.');
});

test('completion retains skip totals when earlier events leave the visible feed', () => {
  const lines = log([
    ...Array.from({ length: 20 }, (_, index) => [
      `✓ 80 · Role ${index} @ Employer (Sydney NSW) [SEEK]`,
      `– skipped (already applied): Role ${index} @ Employer`,
    ]).flat(),
    '=== Run complete: 0 new application(s) ===',
  ]);
  assert.equal(activityEvents(lines).length, 14);
  assert.equal(activitySummary(lines).outcomeSummary, completion(lines));
  assert.equal(completion(lines), '20 profile matches · 0 applications submitted · 20 skipped: already applied.');
});

test('search-only runs and unfinished runs do not report submissions or completion', () => {
  const lines = log(['▶ starting search run', '✓ 80 · Role @ Employer (Sydney NSW) [SEEK]', '1 qualifying jobs.']);
  assert.equal(activitySummary(lines).submitted, 0);
  assert.equal(activityEvents(lines).some((event) => event.title === 'Run complete'), false);
});

test('users see a plain security-check explanation while admins retain diagnostics', () => {
  const reason = 'jobs.lever.co is not attempted today: CapMonster could not clear the site security verification.';
  const lines = log([
    '→ Applying: Software Engineer @ Deputy.com',
    `– skipped: ${reason}`,
    '=== Run complete: 0 new application(s) ===',
  ]);
  const user = activityEvents(lines).find((event) => event.outcome === 'skipped');
  assert.equal(user.detail, "Deputy.com · The site's security check could not be completed.");
  const admin = activityEvents(lines, 14, true).find((event) => event.outcome === 'skipped');
  assert.equal(admin.detail, `Deputy.com · ${reason}`);
  assert.equal(lines[1].text, `– skipped: ${reason}`);
  assert.equal(plainReason(reason), "The site's security check could not be completed.");
});

test('technical details are translated across skips, errors, board failures and fatal failures', () => {
  const reasons = [
    'CapMonster could not clear the sign-in security verification.',
    'locator.click: Timeout 30000ms exceeded. Call log: waiting for locator(#submit)',
    'CELERIS_API_KEY is missing',
    'TypeError: request failed with HTTP 503 at https://api.example.test',
    'step budget exhausted (24 steps)',
    'model budget exhausted (21 calls · 339614 prompt (28% cached) · $0.05270)',
  ];
  for (const reason of reasons) {
    for (const text of [`– skipped: ${reason}`, `✗ error: ${reason}`, `⚠ SEEK: ${reason}`, `Fatal: ${reason}`]) {
      const lines = log(['→ Applying: Example role @ Employer', text]);
      const detail = activityEvents(lines).at(-1).detail;
      assert.doesNotMatch(detail, /CapMonster|locator|30000|CELERIS|TypeError|503|https:|budget|24 steps|339614|0\.05270/i);
      assert.ok(activityEvents(lines, 14, true).at(-1).detail.includes(reason.split(/[.:]/)[0]));
    }
  }
  assert.equal(formatActivityReason('Required answer: What is your notice period?'), 'Required answer: What is your notice period?.');
});

test('unexpected exits expose exit codes only to admins', () => {
  const lines = log(['run finished (exit 137)']);
  assert.equal(activityEvents(lines)[0].detail, 'The run stopped before finishing. Please try again.');
  assert.match(activityEvents(lines, 14, true)[0].detail, /code 137/);
});
