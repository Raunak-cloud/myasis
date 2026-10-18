import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityEvents, activitySummary, formatActivityReason } from '../src/activity.ts';
import { plainReason } from '../src/run-messages.ts';

const log = (texts) => texts.map((text, seq) => ({ seq, stream: 'out', text }));

test('interleaved workers keep application outcomes, durations and active indicators separate', () => {
  const lines = timedLog([
    [0, 'Application workers: 2 (isolated sessions)'],
    [1, '[worker:seek]   ✓ 90 · Assistant @ SEEK Employer (Sydney) [SEEK]'],
    [2, '[worker:seek] → Applying: Assistant @ SEEK Employer'],
    [3, '[worker:indeed]   ✓ 91 · Floor staff @ Indeed Employer (Sydney) [Indeed]'],
    [4, '[worker:indeed] → Applying: Floor staff @ Indeed Employer'],
    [5, '[worker:seek]   · cover letter included'],
    [6, '[worker:indeed]   ⏸ needs you: Missing answer'],
    [8, '[worker:seek]   ✅ submitted (1/2)'],
    [9, '=== Run complete: 1 new application(s) ==='],
  ]);
  const inProgress = activityEvents(lines.slice(0, 5), Infinity, true);
  assert.equal(inProgress.filter(event => event.live && event.title.startsWith('Applying')).length, 2);
  const events = activityEvents(lines, Infinity, true);
  const sent = events.find(event => event.title === 'Applied to Assistant');
  assert.match(sent.detail, /SEEK Employer.*cover letter written/);
  assert.equal(sent.durationMs, 6000);
  const needs = events.find(event => event.title === 'Floor staff needs your answer');
  assert.equal(needs.durationMs, 2000);
  assert.equal(activitySummary(lines).suitable, 2);
  assert.equal(activitySummary(lines).submitted, 1);
  assert.match(events.find(event => event.title === 'Run complete').detail, /1 needs your attention/);
  assert.equal(events.filter(event => event.live).length, 0);
});

test('two platform applications with identical employer and role names remain separate events', () => {
  const events = activityEvents(log([
    '[worker:seek] → Applying: Assistant @ Same employer',
    '[worker:indeed] → Applying: Assistant @ Same employer',
    '[worker:indeed]   ⏸ needs you: Answer needed',
    '[worker:seek]   ✅ submitted (1/2)',
  ]), Infinity);
  assert.equal(events.filter(event => /^(Applied to|Assistant needs)/.test(event.title)).length, 2);
  assert.ok(events.some(event => event.title === 'Applied to Assistant' && event.tone === 'done'));
  assert.ok(events.some(event => event.title === 'Assistant needs your answer' && event.tone === 'warn'));
});

test('late duplicates restore review and match counts without becoming submissions', () => {
  const lines = log([
    '  ✓ 90 · Course Coach @ Fixture College (Sydney) [SEEK]',
    '→ Applying: Course Coach @ Fixture College',
    '  Review slot restored: Course Coach @ Fixture College',
    '  ↩ already applied — An application to this role is already recorded.',
    '  ✓ 88 · New Developer @ New Employer (Sydney) [SEEK]',
  ]);
  assert.equal(activitySummary(lines).reviewed, 1);
  assert.equal(activitySummary(lines).suitable, 1);
  assert.equal(activitySummary(lines).submitted, 0);
  const events = activityEvents(lines, Infinity);
  assert.match(events.find(event => event.title === 'Reviewing jobs').detail, /^1 checked · 1 profile match · latest match: New Developer at New Employer$/);
  assert.ok(events.some(event => event.title === 'Already applied to Course Coach'));
});

test('instruction evidence failures show a useful explanation without schema internals', () => {
  const events = activityEvents(log([
    '! fit check failed for Professional Search Group: Instruction exception review violated its evidence schema: checks[0].ruleQuote must quote the rules',
  ]));
  assert.equal(events[0].title, 'Could not review a job at Professional Search Group');
  assert.equal(events[0].detail, 'The job could not be checked reliably against your instructions. Please try again later.');
});
const completion = (lines) => activityEvents(lines).find((event) => event.title === 'Run complete').detail;

test('public employer feeds report connection and partial failures without claiming a sign-in', () => {
  const events = activityEvents(log([
    'SmartRecruiters public job feed ready (admin only).',
    '! SmartRecruiters employer Canva could not be searched: HTTP 429',
  ]));
  assert.equal(events[0].title, 'SmartRecruiters employer feeds connected');
  assert.equal(events[1].tone, 'warn');
  assert.ok(events.every(event => !event.title.startsWith('Signed in')));
});

const timedLog = (entries) => entries.map(([seconds, text], seq) => ({
  seq, stream: 'out', text, ts: new Date(Date.UTC(2026, 9, 7) + seconds * 1000).toISOString(),
}));

test('admins see each application duration without including the wait between jobs', () => {
  const lines = timedLog([
    [0, '→ Applying: First role @ Employer'],
    [30, 'cover letter added'],
    [83, '✅ submitted (1/20)'],
    [120, '→ Applying: External role @ Other employer'],
    [125, '✅ submitted [external] (2/20)'],
    [130, '– skipped (already applied): Duplicate role @ Employer'],
  ]);
  const admin = activityEvents(lines, 14, true);
  assert.equal(admin[0].durationMs, 83000);
  assert.equal(admin[1].durationMs, 5000);
  assert.equal(admin[2].durationMs, undefined);
  assert.ok(activityEvents(lines).every((event) => !('durationMs' in event)));
  assert.equal(activityEvents(lines, 2, true)[0].durationMs, 5000);
});

test('attempt timing stops at its outcome, including failures and duplicates found on a form', () => {
  for (const outcome of [
    '↩ already applied — SEEK shows an existing application.',
    '⏸ needs you: A screening answer is missing',
    '↪ off-platform',
    '– skipped: Application unavailable',
    '✗ error: Connection dropped',
  ]) {
    const lines = timedLog([
      [0, '→ Applying: Role @ Employer'],
      [15, outcome],
      [90, '=== Run complete: 0 new application(s) ==='],
    ]);
    assert.equal(activityEvents(lines, 14, true)[0].durationMs, 15000, outcome);
    assert.equal(activityEvents(lines)[0].durationMs, undefined);
  }
});

test('unfinished applications and unavailable or invalid timestamps have no duration', () => {
  const lines = timedLog([[10, '→ Applying: Role @ Employer'], [20, '✅ submitted (1/20)']]);
  assert.equal(activityEvents(lines.slice(0, 1), 14, true)[0].durationMs, undefined);
  for (const [start, end] of [[undefined, lines[1].ts], [lines[0].ts, undefined], ['invalid', lines[1].ts], [lines[0].ts, 'invalid'], [lines[1].ts, lines[0].ts]]) {
    const incomplete = [{ ...lines[0], ts: start }, { ...lines[1], ts: end }];
    assert.equal(activityEvents(incomplete, 14, true)[0].durationMs, undefined);
  }
  assert.equal(activityEvents([{ ...lines[0], ts: lines[1].ts }, lines[1]], 14, true)[0].durationMs, 0);
});

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

test('identical skip entries still count each matched listing in the completion summary', () => {
  const lines = log([
    '✓ 80 · AV & Automation Programmer @ Kayder (Sydney NSW) [SEEK]',
    '→ Applying: AV & Automation Programmer @ Kayder',
    '✅ submitted (1/20)',
    ...[
      ['Applications Specialist', 'Ambition', 'Sydney NSW'],
      ['Technical Consultant', 'Sensei', 'Brisbane QLD (Hybrid)'],
      ['Technical Consultant', 'Sensei', 'Melbourne VIC (Hybrid)'],
      ['Product Engineer', 'eQ8', 'Sydney NSW'],
      ['Cyber Security and/or Software Development Course Coach', 'Equinim College of Technology', 'Sydney NSW'],
    ].flatMap(([title, company, location]) => [
      `✓ 80 · ${title} @ ${company} (${location}) [SEEK]`,
      `– skipped (already applied): ${title} @ ${company}`,
    ]),
    '=== Run complete: 1 new application(s) ===',
  ]);
  const expected = '6 profile matches · 1 application submitted · 5 skipped: already applied.';
  assert.equal(activityEvents(lines).filter((event) => event.title === 'Already applied to Technical Consultant').length, 1);
  assert.equal(completion(lines), expected);
  assert.equal(activitySummary(lines).outcomeSummary, expected);
  assert.equal(activityEvents(lines, 1).at(-1).detail, expected);
});

test('merged skips and attention entries keep their full outcome totals', () => {
  const lines = log([
    ...Array.from({ length: 4 }, () => '✓ 80 · Role @ Employer (Sydney NSW) [SEEK]'),
    '– skipped (same role already attempted this run): Role @ Employer',
    '– skipped (same role already attempted this run): Role @ Employer',
    '⏸ needs you: A screening answer is missing',
    '⏸ needs you: A screening answer is missing',
    '=== Run complete: 0 new application(s) ===',
  ]);
  assert.equal(activityEvents(lines).filter((event) => event.outcome === 'skipped').length, 1);
  assert.equal(activityEvents(lines).filter((event) => event.outcome === 'needs-human').length, 1);
  assert.equal(completion(lines), '4 profile matches · 0 applications submitted · 2 skipped for other reasons · 2 need your attention.');
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

test('an exhausted review allowance explains that remaining listings were not ruled out', () => {
  const lines = log(['evaluation cap (100) reached', '=== Run complete: 0 new application(s) ===']);
  const event = activityEvents(lines).find(event => event.title === 'Review limit reached');
  assert.ok(event);
  assert.match(event.detail, /100 job reviews/);
  assert.match(event.detail, /unreviewed/);
  assert.equal(activityEvents(lines).at(-1).title, 'Run complete');
});

test('reserved search-card rejections count as reviews without creating profile matches', () => {
  const lines = log([
    '[worker:seek]   ✗ Senior Developer @ Fixture — Your instructions rule this out (from the search result; not opened)',
    '  ✓ 80 · Developer @ Fixture (Sydney) [SEEK]',
    '=== Run complete: 0 new application(s) ===',
  ]);
  assert.equal(activitySummary(lines).reviewed, 2);
  assert.equal(activitySummary(lines).suitable, 1);
  assert.equal(activityEvents(lines).find(event => event.title === 'Reviewed 2 jobs').detail.startsWith('2 checked'), true);
});
