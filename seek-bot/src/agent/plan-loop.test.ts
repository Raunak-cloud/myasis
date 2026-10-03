import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';

/**
 * The agent loop end to end on a fixture employer form, with a scripted model:
 *
 * - a plan of several actions runs in order without a model call between them;
 * - the first surprise (here a dialog opening outside the form) stops the rest,
 *   and the steps not run are reported as not run;
 * - each action's result carries what it really did to the page, including a
 *   dialog outside the form and a state change shown only as a class, which
 *   the old check reported as "Nothing visible changed";
 * - a routine turn reasons briefly, a stuck one at length.
 */
const directory = mkdtempSync(join(tmpdir(), 'owtomate-plan-loop-'));
process.env.DATA_DIR = directory;
process.env.CELERIS_API_KEY = 'fixture-only';
process.env.ALLOW_EXTERNAL_APPLY = 'true';
process.env.DRY_RUN = 'true';

type Body = { messages: Array<{ role: string; content: unknown; tool_call_id?: string }>; tools?: unknown[]; chat_template_kwargs?: { reasoning_effort?: string }; response_format?: unknown };
const agentTurns: Body[] = [];
let auditProblems: Array<{ field: string; value: string; problem: string }> = [];
let lessonReply = { cause: 'fixture', within_agent_control: false, lesson: '' };
let script: Array<(body: Body) => Array<{ name: string; args: Record<string, unknown> }>> = [];
const lastObservation = (body: Body) => {
  const user = [...body.messages].reverse().find((message) => message.role === 'user');
  const content = user?.content;
  return typeof content === 'string' ? content : Array.isArray(content) ? String((content[0] as { text?: string }).text ?? '') : '';
};
const refFor = (body: Body, text: string) => lastObservation(body).match(new RegExp(`(a\\d+)\\s+\\[[^\\]]+\\][^\\n]*${text}`))?.[1] ?? 'missing';
const reply = (message: Record<string, unknown>) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { 'content-type': 'application/json' } });
globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
  const body = JSON.parse(String(init?.body ?? '{}')) as Body;
  if (body.tools?.length) {
    agentTurns.push(body);
    const next = script.shift();
    const calls = next ? next(body) : [{ name: 'finish', args: { status: 'cannot_complete', reason: 'fixture done' } }];
    return reply({ role: 'assistant', content: null, tool_calls: calls.map((call, i) => ({ id: `c${agentTurns.length}-${i}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) });
  }
  // Every other model check: nothing wrong, not a submit, no lesson.
  return reply({ role: 'assistant', content: JSON.stringify({ problems: auditProblems, sends_application: false, unsafe: false, reason: 'fixture', confirmed: false, quote: '', ...lessonReply }) });
}) as typeof fetch;

const { runApplicationAgent } = await import('./loop.js');
const { reviewFailure, settleReviews, lessonsFor, platformOf } = await import('./lessons.js');

const form = `<!doctype html><html><body>
  <main><h1>Apply: Junior Developer</h1><form onsubmit="return false">
    <p>Availability</p>
    <div class="choice" role="button" tabindex="0" onclick="this.classList.add('p-highlight')">Available soon</div>
    <div role="button" tabindex="0" onclick="document.body.insertAdjacentHTML('beforeend', '<div role=dialog style=\\'position:fixed;top:10px;left:10px;width:300px;height:120px;background:#fff\\'>Write your cover letter here</div>')">Write or Add</div>
    <button type="button" onclick="document.querySelector('h1').textContent = 'Step 2'">Next</button>
  </form></main></body></html>`;

const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : {}) });
try {
  const page = await browser.newPage();
  await page.route('https://careers.fixture-employer.example/**', (route) => route.fulfill({ contentType: 'text/html', body: form }));
  await page.goto('https://careers.fixture-employer.example/apply');
  const lines: string[] = [];

  script = [
    // A plan: select availability, open the letter box, then Next. The dialog is a surprise, so Next must not run.
    (body) => [
      { name: 'click', args: { ref: refFor(body, 'Available soon'), reason: 'availability' } },
      { name: 'click', args: { ref: refFor(body, 'Write or Add'), reason: 'open the letter box' } },
      { name: 'click', args: { ref: refFor(body, 'Next'), reason: 'move on' } },
    ],
  ];
  const run = await runApplicationAgent({
    page,
    job: { id: 'fixture-1', title: 'Junior Developer', company: 'Fixture Employer', location: 'Sydney', url: 'https://careers.fixture-employer.example/apply', applicationMode: 'external' } as never,
    profile: { name: 'Raunak Shrestha', phone: '0400000000', email: 'raunak@example.com', nationality: 'Nepali', expectedSalary: '', noticePeriod: '', willingToRelocate: false, experienceSummary: '', skills: [], excludedDomains: [], securityClearance: '' } as never,
    log: (line) => lines.push(line),
  });

  assert.ok(agentTurns.length >= 2, `the plan ran in one model turn, then the model looked again (${agentTurns.length} turns)`);
  const results = agentTurns[1].messages.filter((message) => message.role === 'tool').map((message) => String(message.content));
  assert.equal(results.length, 3, 'every planned call gets an answer');
  assert.match(results[0], /controls changed: .*Available soon.*\+p-highlight/s, `the class-only selection is reported: ${results[0]}`);
  assert.match(results[1], /appeared: .*\[dialog\] Write your cover letter here/s, `the dialog outside the form is reported: ${results[1]}`);
  assert.match(results[2], /^Not run/, `the step after the surprise did not run: ${results[2]}`);
  assert.equal(await page.textContent('h1'), 'Apply: Junior Developer', 'Next was never pressed');
  assert.ok(lines.some((line) => /plan: click → click → click/.test(line)), lines.join(' | '));
  assert.equal(agentTurns[0].chat_template_kwargs?.reasoning_effort, 'low', 'a routine turn reasons briefly');
  assert.equal(run.outcome.status, 'skipped');
  // A page where nothing responds: after the stalls the model is asked to think at length.
  await page.route('https://careers.stuck-employer.example/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><main><h1>Apply</h1><form><button type="button">Continue</button></form></main>' }));
  await page.goto('https://careers.stuck-employer.example/apply');
  agentTurns.length = 0;
  script = Array.from({ length: 4 }, () => (body: Body) => [{ name: 'click', args: { ref: refFor(body, 'Continue'), reason: 'move on' } }]);
  await runApplicationAgent({
    page,
    job: { id: 'fixture-2', title: 'Junior Developer', company: 'Stuck Employer', location: 'Sydney', url: 'https://careers.stuck-employer.example/apply', applicationMode: 'external' } as never,
    profile: { name: 'Raunak Shrestha', phone: '0400000000', email: 'raunak@example.com', nationality: 'Nepali', expectedSalary: '', noticePeriod: '', willingToRelocate: false, experienceSummary: '', skills: [], excludedDomains: [], securityClearance: '' } as never,
    log: (line) => lines.push(line),
  });
  assert.ok(agentTurns.some((turn) => turn.chat_template_kwargs?.reasoning_effort === 'xhigh'), 'a stuck turn thinks at length');
  assert.ok(agentTurns.some((turn) => /STUCK: the last/.test(lastObservation(turn))), 'and is asked to step back and form a theory');
  assert.ok(agentTurns.slice(1).some((turn) => turn.messages.some((message) => message.role === 'tool' && /no change of any kind was recorded/.test(String(message.content)))), 'a dead click is reported as doing nothing at all');

  // An answer a general tool sets is checked against the record the moment it lands.
  const scripted = '<!doctype html><main><h1>Apply</h1><form><label>Degree <select name="degree"><option></option><option>PhD</option><option>Bachelor</option></select></label><button type="button">Next</button></form></main>';
  await page.route('https://careers.script-employer.example/**', (route) => route.fulfill({ contentType: 'text/html', body: scripted }));
  await page.goto('https://careers.script-employer.example/apply');
  agentTurns.length = 0;
  auditProblems = [{ field: 'Degree', value: 'PhD', problem: 'The candidate holds a bachelor degree, not a PhD.' }];
  script = [() => [{ name: 'evaluate_script', args: { function: "() => { const s = document.querySelector('select'); s.value = 'PhD'; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; }" } }]];
  await runApplicationAgent({
    page,
    job: { id: 'fixture-3', title: 'Junior Developer', company: 'Script Employer', location: 'Sydney', url: 'https://careers.script-employer.example/apply', applicationMode: 'external' } as never,
    profile: { name: 'Raunak Shrestha', phone: '0400000000', email: 'raunak@example.com', nationality: 'Nepali', expectedSalary: '', noticePeriod: '', willingToRelocate: false, experienceSummary: '', skills: [], excludedDomains: [], securityClearance: '' } as never,
    log: (line) => lines.push(line),
  });
  auditProblems = [];
  const scriptResult = agentTurns[1]?.messages.filter((message) => message.role === 'tool').map((message) => String(message.content)).join(' | ') ?? '';
  assert.match(scriptResult, /NOT SUPPORTED by the candidate's record.*"Degree" = "PhD"/s, `a scripted answer the record does not support is flagged at once: ${scriptResult.slice(0, 600)}`);

  // A failure is reviewed, and its lesson is kept for every employer on the same platform.
  lessonReply = { cause: 'The Reset Password button is a Workday click filter, not the button.', within_agent_control: true, lesson: 'On Workday, press buttons through their data-automation-id="click_filter" overlay; clicking the label does nothing.' };
  reviewFailure({ host: 'nib.wd105.myworkdayjobs.com', company: 'nib', title: 'Analyst', reason: 'The page did not change in response to anything the agent tried.', steps: Array.from({ length: 5 }, (_, i) => ({ tool: 'click', args: { ref: `a${i}` }, result: 'Clicked "Reset Password".' })) });
  reviewFailure({ host: 'careers.gov.example', company: 'Gov', title: 'Analyst', reason: 'Australian government application sites are excluded.', steps: Array.from({ length: 5 }, () => ({ tool: 'click' })) });
  await settleReviews();
  assert.equal(platformOf('dtn.wd1.myworkdayjobs.com'), 'Workday');
  assert.match(lessonsFor('dtn.wd1.myworkdayjobs.com')[0] ?? '', /click_filter/, 'a lesson learnt at nib reaches DTN, both Workday');
  assert.equal(lessonsFor('careers.gov.example').length, 0, 'a policy skip teaches nothing');

  console.log('PASS: a plan runs in one model turn, stops at the first surprise, every action reports what it really did, a stuck turn thinks at length, a scripted answer is checked as it lands, and failures leave lessons per platform');
} finally {
  await browser.close();
  rmSync(directory, { recursive: true, force: true });
}
