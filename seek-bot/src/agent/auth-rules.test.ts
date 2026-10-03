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
const { commitAcceptedCredentials, storedCredential } = await import('../site-credentials.js');

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
  type Ctx = Parameters<typeof executeTool>[0] & { pendingCredentials?: Map<string, unknown>; actions: Array<Record<string, unknown>> };
  const newAttempt = async (body: string, url: string) => {
    html = body;
    await page.goto(url);
    return {
      page, profile,
      job: { id: '1', title: 'Full Stack Engineer', company: 'Capgemini', location: 'Sydney', url },
      observation: await observe(page), captured: [], actions: [], log: () => {},
      guards: new RunGuards({ maxSteps: 30, maxStepsPerPage: 16, maxStuckMs: 60_000, maxTotalMs: 600_000, meter: new CostMeter(1) }),
    } as unknown as Ctx;
  };
  const authenticate = async (ctx: Ctx, body: string, url: string, args: Record<string, unknown>) => {
    html = body;
    await page.goto(url);
    ctx.observation = await observe(page);
    const refs = ctx.observation.fields.map((field) => field.ref);
    await executeTool(ctx, 'complete_authentication', { refs, reason: 'fixture', ...args });
    return page.evaluate(() => [...document.querySelectorAll<HTMLInputElement>('input[type=password]')].map((input) => input.value));
  };
  const accepted = (ctx: Ctx, kind: 'account-created' | 'signed-in') => {
    ctx.actions.push({ kind, site: 'careers.capgemini.example', email: profile.email, at: new Date().toISOString(), detail: kind });
    commitAcceptedCredentials(ctx.pendingCredentials as never, ctx.actions as never, profile.email);
  };
  const register_url = 'https://careers.capgemini.example/register';
  const login_url = 'https://careers.capgemini.example/login';

  // A sign-up the site refuses (the account already exists) changes nothing: the account keeps the password it has.
  const legacy = sitePassword(login_url, profile.email, 'fixture-secret');
  let attempt = await newAttempt(register, register_url);
  await authenticate(attempt, register, register_url, { purpose: 'create_account', password_rules: { max_length: 18 } });
  commitAcceptedCredentials(attempt.pendingCredentials as never, attempt.actions as never, profile.email);
  assert.equal(storedCredential(login_url, profile.email), null, 'an unaccepted password is never remembered');
  attempt = await newAttempt(signIn, login_url);
  assert.equal((await authenticate(attempt, signIn, login_url, { purpose: 'sign_in' }))[0], legacy, 'the next sign-in uses the password the account really has');

  // A sign-up the site accepts is remembered, and a sign-in in the same attempt uses it before then.
  attempt = await newAttempt(register, register_url);
  const created = await authenticate(attempt, register, register_url, { purpose: 'create_account', password_rules: { max_length: 18, min_length: 8 } });
  assert.equal((await authenticate(attempt, signIn, login_url, { purpose: 'sign_in' }))[0], created[0], 'signing in right after signing up uses the new password');
  accepted(attempt, 'account-created');
  assert.equal(created.length, 2);
  assert.equal(created[0], created[1], 'password and confirmation match');
  assert.ok(created[0].length <= 18, `${created[0]} fits the 18-character limit the agent read`);
  assert.match(created[0], /^(?:[A-Z][a-z]+){2,}\d{3}/, `${created[0]} is readable words and digits`);

  const record = JSON.parse(readFileSync(join(directory, 'site-credentials.json'), 'utf8'));
  const entry = record['careers.capgemini.example|raunak@example.com'];
  assert.deepEqual({ format: entry.format, rules: entry.rules }, { format: 'readable-v1', rules: { max_length: 18, min_length: 8 } });
  assert.ok(!JSON.stringify(record).includes(created[0]), 'the password itself is never written down');

  const signedIn = await authenticate(await newAttempt(signIn, login_url), signIn, login_url, { purpose: 'sign_in' });
  assert.equal(signedIn[0], created[0], 'a later sign-in uses the same password');
  assert.equal(sitePassword('https://careers.capgemini.example', 'raunak@example.com', 'fixture-secret', entry), created[0], 'the dashboard derives the same password from the record');

  console.log('PASS: passwords fit the rules the agent read, are remembered only once the site accepts them, and sign-in reuses them');
} finally {
  await browser.close();
  rmSync(directory, { recursive: true, force: true });
}
