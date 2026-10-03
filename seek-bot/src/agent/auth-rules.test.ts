import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';

/**
 * Through the agent's own tool: an account is created with a readable
 * password built to the rules the agent read off the page, the rules are
 * recorded (never the password), and a later sign-in on the same site fills
 * the same password. Fixture pages under an employer host; nothing leaves.
 */
const directory = mkdtempSync(join(tmpdir(), 'owtomate-auth-rules-'));
process.env.DATA_DIR = directory;
process.env.SITE_AUTH_SECRET = 'fixture-secret';
process.env.CELERIS_API_KEY = 'fixture-only';
globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
const { observe } = await import('./observe.js');
const { executeTool } = await import('./tools.js');
const { RunGuards } = await import('./guards.js');
const { CostMeter } = await import('./celeris.js');
const { sitePassword } = await import('../site-auth.js');

const register = `<!doctype html><main><h1>Create an account</h1><form>
  <label>Email address <input type="email" name="email"></label>
  <label>Password <input type="password" name="password"></label>
  <p>Password must be 8 to 18 characters.</p>
  <label>Confirm password <input type="password" name="confirm"></label>
  <button type="button">Create account</button></form></main>`;
const signIn = `<!doctype html><main><h1>Sign in</h1><form>
  <label>Email <input type="email" name="email"></label>
  <label>Password <input type="password" name="password"></label>
  <button type="button">Sign in</button></form></main>`;

const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : {}) });
try {
  const page = await browser.newPage();
  let html = '';
  await page.route('https://careers.capgemini.example/**', (route) => route.fulfill({ contentType: 'text/html', body: html }));
  const profile = { name: 'Raunak Shrestha', phone: '0400000000', email: 'raunak@example.com', nationality: 'Nepali', expectedSalary: '', noticePeriod: '', willingToRelocate: false, experienceSummary: '', skills: [], excludedDomains: [], securityClearance: '' };
  const authenticate = async (body: string, url: string, args: Record<string, unknown>) => {
    html = body;
    await page.goto(url);
    const ctx = {
      page, profile,
      job: { id: '1', title: 'Full Stack Engineer', company: 'Capgemini', location: 'Sydney', url },
      observation: await observe(page), captured: [], actions: [], log: () => {},
      guards: new RunGuards({ maxSteps: 30, maxStepsPerPage: 16, maxStuckMs: 60_000, maxTotalMs: 600_000, meter: new CostMeter(1) }),
    } as unknown as Parameters<typeof executeTool>[0];
    const refs = ctx.observation.fields.map((field) => field.ref);
    await executeTool(ctx, 'complete_authentication', { refs, reason: 'fixture', ...args });
    return page.evaluate(() => [...document.querySelectorAll<HTMLInputElement>('input[type=password]')].map((input) => input.value));
  };

  const created = await authenticate(register, 'https://careers.capgemini.example/register', { purpose: 'create_account', password_rules: { max_length: 18, min_length: 8 } });
  assert.equal(created.length, 2);
  assert.equal(created[0], created[1], 'password and confirmation match');
  assert.ok(created[0].length <= 18, `${created[0]} fits the 18-character limit the agent read`);
  assert.match(created[0], /^(?:[A-Z][a-z]+){2,}\d{3}/, `${created[0]} is readable words and digits`);

  const record = JSON.parse(readFileSync(join(directory, 'site-credentials.json'), 'utf8'));
  const entry = record['careers.capgemini.example|raunak@example.com'];
  assert.deepEqual({ format: entry.format, rules: entry.rules }, { format: 'readable-v1', rules: { max_length: 18, min_length: 8 } });
  assert.ok(!JSON.stringify(record).includes(created[0]), 'the password itself is never written down');

  const signedIn = await authenticate(signIn, 'https://careers.capgemini.example/login', { purpose: 'sign_in' });
  assert.equal(signedIn[0], created[0], 'a later sign-in uses the same password');
  assert.equal(sitePassword('https://careers.capgemini.example', 'raunak@example.com', 'fixture-secret', entry), created[0], 'the dashboard derives the same password from the record');

  console.log('PASS: the agent reads password rules, the password fits them and stays readable, and sign-in reuses it');
} finally {
  await browser.close();
  rmSync(directory, { recursive: true, force: true });
}
