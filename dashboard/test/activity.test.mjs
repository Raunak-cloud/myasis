import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityEvents, activitySummary, formatActivityReason, runResultLabel } from '../src/activity.ts';
import { plainReason } from '../src/run-messages.ts';

const log = (texts) => texts.map((text, seq) => ({ seq, stream: 'out', text }));

test('historical sole-agent judgements without saved questions are skipped, not phantom attention tasks', () => {
  const lines = log([
    '✓ 90 · Insurance Analyst @ Insurance Employer',
    '✓ 90 · Data Technician @ Data Employer',
    '[worker:seek] → Applying: Insurance Analyst @ Insurance Employer',
    '[worker:seek] Agent judgement: needs-human: Fundamental field mismatch. Evidence: Insurance role, software profile.',
    '[worker:indeed] → Applying: Data Technician @ Data Employer',
    '[worker:indeed] Agent judgement: needs-human: Outside saved preferences. Evidence: Trainee operations.',
    '[worker:seek] ⏸ needs you: Fundamental field mismatch.',
    '[worker:indeed] ⏸ needs you: Outside saved preferences.',
    '=== Run complete: 0 new application(s) ===',
  ]);
  const events = activityEvents(lines, Infinity);
  assert.ok(events.some(event => event.title === 'Skipped Insurance Analyst'));
  assert.ok(events.some(event => event.title === 'Skipped Data Technician'));
  assert.doesNotMatch(JSON.stringify(events), /needs your answer|Open Needs attention|need your attention/);
  assert.match(activitySummary(lines).outcomeSummary, /2 skipped for other reasons/);
});

test('new question-backed outcomes still direct candidates to Needs attention after an agent judgement', () => {
  const lines = log([
    '✓ 90 · Developer @ Employer',
    '→ Applying: Developer @ Employer',
    'Agent judgement: needs-human: Current clearance is unknown. Evidence: Required clearance question.',
    '⏸ needs your answer: Which clearance do you currently hold?',
    '=== Run complete: 0 new application(s) ===',
  ]);
  assert.ok(activityEvents(lines).some(event => event.title === 'Developer needs your answer' && /Open Needs attention/.test(event.detail)));
  assert.match(activitySummary(lines).outcomeSummary, /1 needs your attention/);
});

test('activity omits internal worker setup and merges application limit notices in either order', () => {
  for (const isAdmin of [false, true]) for (const notices of [
    ['Run cap of 2 reached.', 'Shared application allowance is reached.'],
    ['Shared application allowance is reached.', 'Run cap of 2 reached.'],
    ['Shared application allowance is reached.'],
  ]) {
    const lines = log(['Application workers: 2 (isolated sessions)', ...notices]);
    const events = activityEvents(lines, Infinity, isAdmin);
    assert.equal(events.length, 1, 'one useful limit notice, without setup noise');
    assert.equal(events[0].title, 'This run reached its limit');
    assert.doesNotMatch(JSON.stringify(events), /worker|session|shared|unconfirmed|reserved/i);
    if (notices.some(text => text.startsWith('Run cap'))) assert.match(events[0].detail, /up to 2 applications/);
    assert.equal(lines[0].text, 'Application workers: 2 (isolated sessions)', 'diagnostic logs remain intact');
  }
});

test('a shared limit notice cannot obscure prepared applications awaiting confirmation', () => {
  const events = activityEvents(log([
    'Ready for confirmation: Developer @ Employer',
    'Run cap of 1 reached.', 'Shared application allowance is reached.',
    '=== Semi auto complete: 1 application(s) ready for confirmation ===',
  ]));
  assert.equal(events.filter(event => event.title === 'Applications saved for review').length, 1);
  assert.ok(events.every(event => event.title !== 'This run reached its limit'));
  assert.match(events.at(-1).detail, /1 application ready for your confirmation. Nothing submitted/);
});

test('Semi auto reports prepared applications without claiming submission', () => {
  const lines = log(['→ Preparing: Developer @ Fixture', 'Ready for confirmation: Developer @ Fixture', '=== Semi auto complete: 1 application(s) ready for confirmation ===']);
  assert.equal(activitySummary(lines).submitted, 0);
  assert.equal(activitySummary(lines).prepared, 1);
  assert.match(activitySummary(lines).outcomeSummary, /1 application ready for your confirmation. Nothing submitted/);
  assert.ok(activityEvents(lines).some(event => event.title === 'Ready for confirmation: Developer'));
});

test('an approved application returned for review is counted as prepared, not blocked by an application limit', () => {
  const lines = log([
    'overrides: APPLICATION_REVIEW_MODE=approved',
    '✓ 100 · Junior Software Engineer @ Tyree Group (Sydney) [SEEK]',
    '→ Applying: Junior Software Engineer @ Tyree Group',
    'Ready for confirmation: Junior Software Engineer @ Tyree Group',
    'Run cap of 1 reached.',
    '=== Run complete: 0 new application(s) ===',
  ]);
  const summary = activitySummary(lines);
  assert.equal(summary.submitted, 0);
  assert.equal(summary.prepared, 1);
  assert.equal(summary.outcomeSummary, '1 profile match · 0 applications submitted · 1 application awaits your confirmation.');
  const events = activityEvents(lines);
  assert.match(events.find(event => event.title.startsWith('Ready for confirmation:')).detail, /application changed after confirmation/);
  assert.ok(events.some(event => event.title === 'Applications saved for review'));
  assert.ok(events.every(event => event.title !== 'This run reached its limit'));
});

test('prepared and submitted outcomes leave only genuinely unattempted matches in the remainder', () => {
  const lines = log([
    ...['Sent', 'Prepared', 'Unattempted'].map(title => `✓ 90 · ${title} @ Employer (Sydney) [SEEK]`),
    '→ Applying: Sent @ Employer', '✅ submitted (1/2)',
    '→ Applying: Prepared @ Employer', 'Ready for confirmation: Prepared @ Employer',
    'Run cap of 2 reached.', '=== Run complete: 1 new application(s) ===',
  ]);
  assert.equal(activitySummary(lines).outcomeSummary, '3 profile matches · 1 application submitted · 1 application awaits your confirmation · 1 matched job not submitted: the application limit was reached.');
});

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
  assert.equal(events[0].title, 'Searching SmartRecruiters jobs');
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
  assert.deepEqual(activitySummary(lines), { found: 395, reviewed: 7, suitable: 7, submitted: 5, prepared: 0, outcomeSummary: completion(lines), shortfall: null });
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
  const reason = 'employer.fixture.invalid is not attempted today: CapMonster could not clear the site security verification.';
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
  assert.equal(formatActivityReason('Required answer: What is your notice period?'), 'Required answer: What is your notice period?');
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
  assert.match(event.detail, /limit of 100 jobs/);
  assert.match(event.detail, /Other listings may still/);
  assert.doesNotMatch(event.detail, /zero submissions/);
  assert.equal(activityEvents(lines).at(-1).title, 'Run complete');
});

test('interleaved historical review-limit notices remain one event without hiding review failures', () => {
  const events = activityEvents(log([
    '[worker:seek] evaluation cap (100) reached',
    '! fit check failed for MedHealth: The job match could not be verified after a second assessment.',
    '[worker:indeed] evaluation cap (100) reached',
    '! fit check failed for NCS Australia: The job match could not be verified after a second assessment.',
    '[worker:seek] evaluation cap (100) reached',
    '=== Run complete: 0 new application(s) ===',
  ]), Infinity);
  assert.equal(events.filter(event => event.title === 'Review limit reached').length, 1);
  assert.equal(events.filter(event => event.title.startsWith('Could not review a job')).length, 2);
});

test('review limits do not contradict successful submissions or promise more matches', () => {
  const lines = log(['overrides: MAX_EVALUATIONS=100', '✓ 90 · Role @ Employer', '→ Applying: Role @ Employer', '✅ submitted (1/10)', 'evaluation cap (100) reached', '=== Run complete: 1 new application(s) ===']);
  assert.doesNotMatch(JSON.stringify(activityEvents(lines)), /zero submissions|nothing submitted/i);
  const partial = activitySummary(lines.filter(line => !line.text.includes('evaluation cap'))).shortfall;
  assert.doesNotMatch(partial, /only.*left to review|will find more/i);
});

test('an uncertain send is distinct from a failed or skipped application and preserves confirmed sends', () => {
  const lines = log([
    '✓ 90 · Sent @ Employer', '✓ 90 · Unknown @ Employer',
    '→ Applying: Sent @ Employer', '✅ submitted (1/10)',
    '→ Applying: Unknown @ Employer', 'Submission not confirmed: TypeError: HTTP 503 at https://private.example',
    '=== Run complete: 1 new application(s) ===',
  ]);
  const events = activityEvents(lines);
  assert.ok(events.some(event => event.outcome === 'unconfirmed' && /Check your application history/.test(event.detail)));
  assert.doesNotMatch(JSON.stringify(events), /TypeError|503|private\.example|nothing submitted/i);
  assert.equal(activitySummary(lines).outcomeSummary, '2 profile matches · 1 application submitted · 1 submission not confirmed.');
});

test('interrupted applications do not remain applying after the run ends', () => {
  for (const ending of ['⏹ stop requested, terminating', 'Run reached its 20-minute time limit; stopping the worker.', 'run finished (exit 137)']) {
    const events = activityEvents(log(['→ Applying: Role @ Employer', ending, 'run finished (exit 137)']));
    assert.ok(events.some(event => event.title === 'Not completed: Role'));
    assert.ok(events.every(event => !event.live && !event.title.startsWith('Applying')));
    assert.doesNotMatch(JSON.stringify(events), /nothing submitted|nothing was submitted/i);
  }
});

test('the activity badge distinguishes unavailable, stopped and partially completed runs', () => {
  const status = { running: false, finishedAt: '2026-10-25T00:00:00Z', exitCode: 0 };
  assert.equal(runResultLabel(null), 'Checking status');
  assert.equal(runResultLabel({ ...status, connectionLost: true }), 'Checking status');
  assert.equal(runResultLabel({ ...status, exitCode: 1 }), 'Stopped early');
  assert.equal(runResultLabel(status, log(['⏹ stop requested, terminating'])), 'Stopped');
  assert.equal(runResultLabel(status, log(['Submission not confirmed: No receipt'])), 'Finished with issues');
  assert.equal(runResultLabel(status), 'Finished');
});

test('technical details after the first line cannot leak through a readable error prefix', () => {
  for (const reason of ['Could not finish.\nTypeError: HTTP 503 at https://private.example', 'Celeris 429: overloaded', 'Failed to fetch', 'Unexpected token < in JSON', 'Details: C:\\private\\session.json']) {
    assert.doesNotMatch(formatActivityReason(reason), /TypeError|503|private|Celeris|429|JSON|session\.json/i);
    assert.ok(formatActivityReason(reason, true).includes(reason.split('\n')[0]));
  }
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
