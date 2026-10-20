import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'patchright';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-employer-routing-'));
Object.assign(process.env, { DATA_DIR: directory, CELERIS_API_KEY: 'fixture-only', DRY_RUN: 'false',
  ALLOW_EXTERNAL_APPLY: 'true', BRIGHTDATA_BROWSER_ENABLED: 'false', EMPLOYER_BROWSER_PROVIDER: 'local', FORM_SPEED_PILOT: 'true' });
const { runApplicationAgent } = await import('./loop.js');
const { EmployerBrowserRouter } = await import('../employer-browser-router.js');
const { withApplicationModel } = await import('../application-model.js');
const originalRoute = EmployerBrowserRouter.prototype.route;
const originalFetch = globalThis.fetch;
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
try {
  for (const mode of ['agent-only']) {
    const local = await browser.newContext();
    const privateContext = await browser.newContext();
    await local.addCookies([{ name: 'board-session', value: 'must-stay-local', url: 'https://www.seek.com.au' }]);
    await local.route('**/*', route => route.fulfill({ contentType: 'text/html', body:
      '<main><h1>Job listing</h1><button onclick="location.href=\'https://employer.routing.invalid/apply\'">Open employer form</button></main>' }));
    await privateContext.route('**/*', route => route.fulfill({ contentType: 'text/html', body:
      '<main><h1>PRIVATE EMPLOYER FORM</h1><label>Name<input></label><button>Continue</button></main>' }));
    const page = await local.newPage();
    await page.goto('https://www.seek.com.au/job/12345678');
    const employer = await privateContext.newPage();
    await employer.goto('https://employer.routing.invalid/apply');
    let routed = 0, turns = 0;
    EmployerBrowserRouter.prototype.route = async function(current: Page) {
      if (current !== employer && current.url().includes('employer.routing.invalid')) { routed++; return employer; }
      return current;
    };
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (!body.tools?.length) return Response.json({ choices: [{ message: { role: 'assistant', content: '{}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      const text = JSON.stringify(body.messages.filter((message: { role: string }) => message.role === 'user').at(-1)?.content);
        const calls: Array<{ name: string; args: Record<string, unknown> }> = ++turns === 1 ? [{ name: 'browser_action', args: { action: 'click', selector: 'button' } }]
        : [{ name: 'finish', args: { status: 'skipped', reason: 'Fixture complete', evidence: 'Private employer form observed' } }];
      if (turns === 1) calls.push({ name: 'browser_action', args: { action: 'fill', selector: 'input', value: 'stale plan must not run' } });
      if (turns > 1) assert.match(text, /PRIVATE EMPLOYER FORM/, `${mode} must observe the routed page before acting`);
      return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: calls.map((call, i) => ({ id: `t${turns}-${i}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    };
    await withApplicationModel({ ...process.env, APPLICATION_AI_MODEL: 'celeris', APPLICATION_AGENT_MODE: mode, APPLICATION_AGENT_MODE_AUTHORIZED: 'true' }, () =>
      runApplicationAgent({ page, job: { id: '12345678', title: 'Developer', company: 'Fixture', location: 'Sydney', url: page.url() } as never,
        profile: { name: 'Fixture Candidate', email: 'fixture@example.invalid', skills: [] } as never, log: () => {} }));
    assert.equal(routed, 1, `${mode} follows employer handoffs through the shared router`);
    assert.equal(turns, 2);
    assert.equal(await employer.locator('input').inputValue(), '', 'a stale action batch cannot fill the newly routed form');
    assert.deepEqual(await privateContext.cookies(), [], 'job-board cookies never cross contexts');
    await local.close(); await privateContext.close();
  }
  console.log('PASS: the application agent routes board handoffs before observing employer forms; board cookies stay local.');
} finally {
  EmployerBrowserRouter.prototype.route = originalRoute; globalThis.fetch = originalFetch;
  await browser.close(); rmSync(directory, { recursive: true, force: true });
}
