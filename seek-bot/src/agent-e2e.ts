import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'patchright';

/**
 * End-to-end harness for the Celeris browser agent.
 *
 * The fixture below is a deliberately awkward employer site: its controls are
 * labelled "Proceed to the next stage" and "Send it off", which the old
 * label-matching state machine would not recognise at all. That is the point —
 * it demonstrates the thing the agent is for, without touching a real employer.
 *
 * Stages:
 *   guards   — the deterministic rails, pure and offline
 *   celeris  — a real tool-calling round trip against the live API
 *   drive    — the agent completes a multi-step application, submit withheld
 */

process.env.ALLOW_EXTERNAL_APPLY = 'true';
process.env.DRY_RUN = 'true';
process.env.REHEARSE = 'true';

const { config } = await import('./config.js');
const { isSubmitAction, isExternal, isForbiddenDestination, RunGuards } = await import('./agent/guards.js');
const { CostMeter, celerisChat } = await import('./agent/celeris.js');

let failures = 0;
const check = (name: string, condition: boolean, detail = '') => {
  console.log(`  ${condition ? '✓' : '✗'} ${name}${detail && !condition ? ` — ${detail}` : ''}`);
  if (!condition) failures += 1;
};

// ---- stage: guards -------------------------------------------------------
console.log('\nguards');
check('recognises SEEK terminal submit labels', isSubmitAction('Submit application'));
check('recognises "Review and submit" as terminal', isSubmitAction('Review and submit'));
check('survives invisible padding characters', isSubmitAction('Submit​ application'));
check('does not treat Continue as a submit', !isSubmitAction('Continue'));
check('seek.com.au is not external', !isExternal('https://www.seek.com.au/apply/123'));
check('an ATS host is external', isExternal('https://jobs.smartrecruiters.com/x/y'));
check('SEEK external apply path is external', isExternal('https://www.seek.com.au/apply/external/123'));
check('refuses login destinations', isForbiddenDestination('https://example.com/login'));
check('refuses payment destinations', isForbiddenDestination('https://example.com/checkout'));
check('allows an ordinary apply path', !isForbiddenDestination('https://example.com/apply/step-2'));

{
  const guards = new RunGuards({ maxSteps: 2, maxStuckMs: 60_000, maxTotalMs: 600_000, meter: new CostMeter(1) });
  check('first step is within budget', guards.nextStep().ok);
  check('second step is within budget', guards.nextStep().ok);
  check('third step exhausts the step budget', !guards.nextStep().ok);
}
{
  const guards = new RunGuards({ maxSteps: 50, maxStuckMs: 60_000, maxTotalMs: 600_000, meter: new CostMeter(1) });
  // DRY_RUN is on for this harness, so a clean ledger must still withhold.
  const clean = guards.canSubmit('https://www.seek.com.au/apply/review');
  check('dry run withholds an otherwise-allowed submit', !clean.allowed && clean.kind === 'dry-run');
  guards.recordUngrounded('Do you hold a security clearance?');
  const dirty = guards.canSubmit('https://www.seek.com.au/apply/review');
  check('an ungrounded answer blocks submission', !dirty.allowed && dirty.kind === 'ungrounded');
}
{
  /**
   * Regression: the guard must not depend on config's import-time snapshot.
   *
   * A live rehearsal submitted a real application because e2e.ts set
   * process.env.DRY_RUN after `import { config }` had already evaluated — ES
   * imports are hoisted — so config.dryRun was false and the withhold never
   * fired. The guard now reads the environment as well.
   */
  const guards = new RunGuards({ maxSteps: 50, maxStuckMs: 60_000, maxTotalMs: 600_000, meter: new CostMeter(1) });
  const savedEnv = process.env.DRY_RUN;
  const savedConfig = config.dryRun;
  try {
    (config as { dryRun: boolean }).dryRun = false; // simulate a stale snapshot
    process.env.DRY_RUN = 'true';
    const verdict = guards.canSubmit('https://www.seek.com.au/apply/review');
    check(
      'live DRY_RUN blocks a submit even when config snapshotted false',
      !verdict.allowed && verdict.kind === 'dry-run',
      JSON.stringify(verdict),
    );
    process.env.DRY_RUN = 'false';
    (config as { dryRun: boolean }).dryRun = true;
    const verdict2 = guards.canSubmit('https://www.seek.com.au/apply/review');
    check('config DRY_RUN still blocks when the env says otherwise', !verdict2.allowed, JSON.stringify(verdict2));
  } finally {
    process.env.DRY_RUN = savedEnv;
    (config as { dryRun: boolean }).dryRun = savedConfig;
  }
}
{
  const meter = new CostMeter(0.000001);
  meter.record({ prompt_tokens: 10_000, completion_tokens: 1_000, prompt_tokens_details: { cached_tokens: 8_000 } });
  check('cost meter bills cached tokens at the lower rate', meter.totals.costUsd > 0 && meter.totals.costUsd < 0.002);
  check('cost meter trips its budget', meter.exhausted);
}

// ---- stage: celeris ------------------------------------------------------
console.log('\nceleris');
if (!config.celeris.apiKey) {
  console.log('  – skipped: CELERIS_API_KEY is not set');
} else {
  try {
    const reply = await celerisChat({
      model: 'celeris-1',
      messages: [
        { role: 'system', content: 'You call tools. Call exactly one.' },
        { role: 'user', content: 'The page shows one button: ref "a1", labelled "Continue". Advance the form.' },
      ],
      tools: [
        {
          name: 'click',
          description: 'Click a control by ref.',
          parameters: {
            type: 'object',
            properties: { ref: { type: 'string' }, reason: { type: 'string' } },
            required: ['ref', 'reason'],
          },
        },
      ],
      requireTool: true,
      meter: new CostMeter(1),
    });
    check('returns a tool call', reply.toolCalls.length > 0);
    check('calls the tool we defined', reply.toolCalls[0]?.name === 'click', reply.toolCalls[0]?.name ?? 'none');
    check('arguments parse into an object', typeof reply.toolCalls[0]?.args.ref === 'string');
    check('picks the offered ref', reply.toolCalls[0]?.args.ref === 'a1', String(reply.toolCalls[0]?.args.ref));
  } catch (error) {
    check('live API round trip', false, (error as Error).message);
  }
}

// ---- stage: drive --------------------------------------------------------
const page = (html: string) => `<!doctype html><html><body><main>${html}</main></body></html>`;

const routes: Record<string, string> = {
  '/job/test': page(`<h1>Fixture Full Stack Developer</h1>
    <a data-automation="job-detail-apply" href="/apply/one">Quick apply</a>`),

  // Non-standard label: the old state machine matched on a fixed list that
  // contained none of these words.
  '/apply/one': page(`<h1>About you</h1>
    <label for="notice">What notice period do you require?</label>
    <input id="notice" name="notice" required />
    <label for="rights">Do you have the right to work in Australia?</label>
    <select id="rights" name="rights" required>
      <option value="">Please choose</option><option>Yes</option><option>No</option>
    </select>
    <button onclick="location.href='/apply/two'">Proceed to the next stage</button>`),

  '/apply/two': page(`<h1>Your covering letter</h1>
    <label for="letter">Tell us why you are a good fit</label>
    <textarea id="letter" name="letter" required></textarea>
    <button onclick="location.href='/apply/review'">Almost done</button>`),

  '/apply/review': page(`<h1>Check your details</h1>
    <p>Nothing has been sent yet.</p>
    <button onclick="location.href='/apply/done'">Submit application</button>`),

  '/apply/done': page('<h1>Your application was sent</h1>'),
};

const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  const body = routes[(request.url ?? '').split('?')[0]];
  if (body) response.end(body);
  else {
    response.statusCode = 404;
    response.end('Not found');
  }
});
await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

console.log('\ndrive');
if (!config.celeris.apiKey || !config.celeris.apiKey) {
  console.log('  – skipped: needs both CELERIS_API_KEY and GEMINI_API_KEY');
} else {
  const { applyToJobWithAgent } = await import('./agent/apply-agent.js');
  const { loadProfile } = await import('./config.js');

  /**
   * Use the same real Chrome the bot runs, rather than Patchright's bundled
   * chromium — it is what CHROME_PATH already points at, and it avoids making
   * this harness depend on a browser install command. A fresh context, not the
   * signed-in profile: this fixture must not touch real session state.
   */
  const browser = await chromium
    .launch({ headless: true, executablePath: config.chromePath })
    .catch(() => chromium.launch({ headless: true }))
    .catch((error: Error) => {
      check('launched a browser', false, error.message);
      return null;
    });

  if (!browser) {
    console.log('  – drive stage could not start: no usable Chrome');
  } else {
  const context = await browser.newContext();
  // Same shim launchBrowser installs — this harness builds its own context, and
  // without it every page.evaluate fails under tsx. See browser.ts for why.
  await context.addInitScript(() => {
    const scope = globalThis as unknown as Record<string, unknown>;
    if (typeof scope.__name !== 'function') scope.__name = (fn: unknown) => fn;
  });
  const tab = await context.newPage();
  try {
    const outcome = await applyToJobWithAgent(
      tab,
      {
        id: 'fixture-1',
        title: 'Fixture Full Stack Developer',
        company: 'Fixture Pty Ltd',
        location: 'Sydney NSW',
        url: `${origin}/job/test`,
      },
      loadProfile(),
      { onFriction: () => {} },
    );

    console.log(`  outcome: ${outcome.status}`);
    check(
      'drove the flow to the final submit and withheld it',
      outcome.status === 'rehearsed',
      `got "${outcome.status}"${'reason' in outcome ? `: ${outcome.reason}` : ''}`,
    );
    if (outcome.status === 'rehearsed') {
      check('stopped on the review step', /\/apply\/review/.test(outcome.stoppedAt), outcome.stoppedAt);
      check('answered the screening questions', outcome.answers.length >= 2, `${outcome.answers.length} answered`);
      check('wrote a cover letter', Boolean(outcome.coverLetter));
      for (const answer of outcome.answers) console.log(`    · ${answer.question} → ${answer.answer.slice(0, 60)}`);
    }
    check('never reached the success page', !tab.url().includes('/apply/done'), tab.url());
  } catch (error) {
    check('agent run completed', false, (error as Error).message);
  } finally {
    await browser.close();
  }
  }
}

server.close();
console.log(failures ? `\n${failures} check(s) failed.\n` : '\nAll checks passed.\n');
process.exit(failures ? 1 : 0);
