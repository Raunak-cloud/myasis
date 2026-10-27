import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-native-handoff-'));
Object.assign(process.env, { DATA_DIR: directory, CELERIS_API_KEY: 'fixture-only', DRY_RUN: 'false',
  ALLOW_EXTERNAL_APPLY: 'true', CAPTCHA_SOLVER: 'off' });
const { runApplicationAgent } = await import('./loop.js');
const originalFetch = globalThis.fetch;
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
try {
  for (const board of ['https://www.seek.com.au', 'https://au.indeed.com']) {
    for (const popup of [false, true]) {
      const context = await browser.newContext();
      await context.addCookies([{ name: 'account-session', value: 'native-fixture', url: board }]);
      const requests: string[] = [];
      const navigations: string[] = [];
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        requests.push(url.hostname);
        if (url.origin === board) return route.fulfill({ contentType: 'text/html', body:
          `<main><h1>Board listing</h1><a href="https://employer.routing.invalid/details" ${popup ? 'target="_blank"' : ''}>Apply on company site</a></main>` });
        if (url.hostname !== 'employer.routing.invalid') return route.abort();
        const body = url.pathname === '/details'
          ? '<main><h1>Employer job details</h1><a href="/apply">Apply Now</a></main>'
          : '<main><h1>Native employer form</h1><form onsubmit="event.preventDefault();document.querySelector(\'main\').innerHTML=\'<h1>Application received</h1><p>Receipt NATIVE123</p>\'"><label>Name<input id=name required></label><button>Submit application</button></form></main>';
        return route.fulfill({ contentType: 'text/html', body });
      });
      context.on('page', page => page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); }));
      const page = await context.newPage();
      await page.goto(`${board}/job/12345678`);
      let turns = 0;
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        assert.ok(body.tools?.length, 'only the mocked application model is called');
        const text = JSON.stringify(body.messages.filter((message: { role: string }) => message.role === 'user').at(-1)?.content);
        turns++;
        let calls: Array<{ name: string; args: Record<string, unknown> }>;
        if (turns === 1) calls = [{ name: 'browser_action', args: { action: 'click', selector: 'a' } }];
        else if (turns === 2) {
          assert.match(text, /Employer job details/);
          calls = [{ name: 'browser_action', args: { action: 'click', selector: 'a' } }];
        } else if (turns === 3) {
          assert.match(text, /Native employer form/);
          calls = [{ name: 'browser_action', args: { action: 'fill', selector: '#name', value: 'Fixture Candidate' } },
            { name: 'browser_action', args: { action: 'click', selector: 'button', sends_application: true } }];
        } else {
          assert.equal(turns, 4);
          assert.match(text, /Receipt NATIVE123/);
          calls = [{ name: 'finish', args: { status: 'applied', reason: 'Native fixture submitted', evidence: 'Application received, Receipt NATIVE123', receipt: { quote: 'Application received' } } }];
        }
        return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: calls.map((call, i) => ({ id: `t${turns}-${i}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      };
      const result = await runApplicationAgent({ page, job: { id: `native-${new URL(board).hostname}-${popup}`, title: 'Assistant', company: 'Fixture', location: 'Sydney', url: page.url() } as never,
        profile: { name: 'Fixture Candidate', email: 'fixture@example.invalid', skills: [] } as never, log: () => {} });
      assert.equal(result.outcome.status, 'applied');
      assert.equal(result.submitPressed, true);
      assert.equal(turns, 4);
      assert.equal(browser.contexts().length, 1, 'no other browser or context is created');
      assert.ok(context.pages().every(tab => tab.context() === context));
      assert.equal((await context.cookies(board))[0]?.value, 'native-fixture', 'native account state is preserved');
      assert.ok(navigations.some(url => url === 'https://employer.routing.invalid/apply'));
      assert.ok(requests.every(host => [new URL(board).hostname, 'employer.routing.invalid'].includes(host)), 'all browser traffic stays on the synthetic board and employer');
      await context.close();
    }
  }
  console.log('PASS: SEEK and Indeed same-tab/popup handoffs, employer Apply Now, form filling and receipt confirmation stay in the same native browser; fixtures only.');
} finally {
  globalThis.fetch = originalFetch;
  await browser.close(); rmSync(directory, { recursive: true, force: true });
}
