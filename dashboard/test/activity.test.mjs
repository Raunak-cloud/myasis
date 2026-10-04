import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityEvents, activitySummary } from '../src/activity.ts';

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
  assert.deepEqual(activitySummary(lines), { found: 395, reviewed: 7, suitable: 7, submitted: 5, shortfall: null });
  for (const title of ['Product Engineer', 'Applications Specialist']) {
    const event = activityEvents(lines).find((event) => event.title === `Already applied to ${title}`);
    assert.equal(event.tone, 'neutral');
    assert.match(event.detail, /No new application was sent/);
  }
  assert.equal(completion(lines), '7 suitable · 5 applications submitted · 2 skipped: already applied.');
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
  assert.equal(completion(lines), '6 suitable · 0 applications submitted · 1 skipped: already applied · 3 skipped for other reasons · 1 needs your attention · 1 application failed.');
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
  assert.equal(completion(lines), '2 suitable · 1 application submitted · 1 suitable job not submitted: the application limit was reached.');
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
  assert.equal(completion(lines), '20 suitable · 0 applications submitted · 20 skipped: already applied.');
});

test('search-only runs and unfinished runs do not report submissions or completion', () => {
  const lines = log(['▶ starting search run', '✓ 80 · Role @ Employer (Sydney NSW) [SEEK]', '1 qualifying jobs.']);
  assert.equal(activitySummary(lines).submitted, 0);
  assert.equal(activityEvents(lines).some((event) => event.title === 'Run complete'), false);
});
