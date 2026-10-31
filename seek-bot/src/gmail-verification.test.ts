import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GmailMcpService } from './gmail-mcp-service.js';
import type { GmailMessage } from './gmail-mcp-client.js';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-verification-fixture-'));
Object.assign(process.env, { DATA_DIR: directory, CELERIS_API_KEY: 'fixture-only', COST_TRACKING: 'false' });
const { findVerificationInGmail, verificationMessage } = await import('./gmail-mailbox.js');
let messages: GmailMessage[] = [], reads = 0, blocked: Promise<void> | undefined;
let beforeThread: (() => void) | undefined;
const queries: string[] = [];
const service = new GmailMcpService({
  search: async (_owner, query) => { queries.push(query); if (blocked) await blocked; return [{ id: 'fixture-thread' }]; },
  thread: async () => { reads++; beforeThread?.(); return messages; },
  send: async () => { throw new Error('This fixture never sends email'); },
});
const grant = await service.grant('fixture-owner', 'candidate@fixture.invalid');
Object.assign(process.env, { GMAIL_MCP_URL: grant.connection.url, GMAIL_MCP_TOKEN: grant.connection.token, GMAIL_MCP_ACCOUNT: grant.connection.account, GMAIL_ACCESS_MODE: 'mcp' });
const message = (id: string, ageMs: number, code: string): GmailMessage => ({ id, subject: 'Fixture verification', date: new Date(Date.now() - ageMs).toISOString(), plaintextBody: `Your security code is ${code}.` });
let release: (() => void) | undefined;
try {
  messages = [message('hour-old', 60 * 60_000, '111222'), message('recent-cached', 9 * 60_000, '482913')];
  const cached = await findVerificationInGmail({ hint: 'Fixture', want: 'code', timeoutMs: 2000 });
  assert.ok(!('error' in cached) && cached.value === '482913', 'a genuinely recent cached code remains usable without a new-request timestamp');
  const knownFlow = await findVerificationInGmail({ hint: 'Fixture', want: 'code', requestedAt: Date.now(), timeoutMs: 100 });
  assert.ok('error' in knownFlow && /within the wait/.test(knownFlow.error), 'a normal fresh-request flow still rejects that same nine-minute code without reuse evidence');
  messages.push(message('current-request', 15_000, '729184'));
  const requestedAt = Date.now() - 30_000;
  const fresh = await findVerificationInGmail({ hint: 'Fixture', want: 'code', requestedAt, timeoutMs: 2000 });
  assert.ok(!('error' in fresh) && fresh.value === '729184', 'a new authentication request excludes older same-employer codes');
  assert.ok(queries.at(-1)?.includes(`after:${Math.floor((requestedAt - 2 * 60_000) / 1000)}`), 'browser and API providers receive the same request freshness lower bound');
  messages = [message('older-code', 5 * 60_000, '111222'), { id: 'link-instead', subject: 'Fixture: confirm your account', date: new Date().toISOString(), htmlBody: '<p>Confirm your Fixture account.</p><a href="https://fixture.invalid/verify?token=fixture">Verify account</a>' }];
  const alternative = await findVerificationInGmail({ hint: 'Fixture', want: 'code', allowAlternative: true, timeoutMs: 2000 });
  assert.ok(!('error' in alternative) && alternative.kind === 'link', 'a newer link-only authentication email wins over an older code and is reported immediately');
  messages = [message('old-link', 60 * 60_000, '111222')];
  const old = await findVerificationInGmail({ hint: 'Fixture', want: 'code', timeoutMs: 100 });
  assert.ok('error' in old && /within the wait/.test(old.error));
  messages = [{ id: 'punctuation', subject: 'Fixture sign-in verification', date: new Date().toISOString(), plaintextBody: 'Your security code is:\n482913' }];
  const punctuation = await findVerificationInGmail({ hint: 'Fixture', purpose: 'sign_in', want: 'code', timeoutMs: 2000 });
  assert.ok(!('error' in punctuation) && punctuation.value === '482913');
  messages = [{ id: 'unreadable', subject: 'Fixture sign-in verification', date: new Date().toISOString(), plaintextBody: 'Your security code is unavailable. Please contact support.' }];
  const unreadable = await findVerificationInGmail({ hint: 'Fixture', purpose: 'sign_in', want: 'code', timeoutMs: 150 });
  assert.ok('error' in unreadable && 'reason' in unreadable && unreadable.reason === 'unreadable-message');
  assert.match(unreadable.error, /matching verification email was found/);
  assert.doesNotMatch(unreadable.error, /No matching verification email arrived/);
  messages = [{ ...messages[0], id: 'unrelated', subject: 'Beta sign-in verification' }];
  const unrelated = await findVerificationInGmail({ hint: 'Fixture', purpose: 'sign_in', want: 'code', timeoutMs: 150 });
  assert.ok('error' in unrelated && 'reason' in unrelated && unrelated.reason === 'not-found', 'another employer cannot be reported as the expected message arriving');
  const realNow = Date.now;
  try {
    let logicalNow = realNow();
    Date.now = () => logicalNow;
    messages = [message('expired-in-transit', 14 * 60_000, '111222')];
    beforeThread = () => { logicalNow += 2 * 60_000; beforeThread = undefined; };
    const expiredInTransit = await findVerificationInGmail({ hint: 'Fixture', want: 'code', timeoutMs: 2000 });
    assert.ok('error' in expiredInTransit && /within the wait/.test(expiredInTransit.error), 'a message that ages past fifteen minutes while the mailbox responds is rejected against the current clock');
  } finally { Date.now = realNow; beforeThread = undefined; }
  const before = reads;
  const cancelled = await findVerificationInGmail({ hint: 'Fixture', signal: AbortSignal.abort() });
  assert.ok('error' in cancelled && /cancelled/.test(cancelled.error));
  assert.equal(reads, before, 'an already cancelled request reads no mailbox data');
  const controller = new AbortController();
  blocked = new Promise<void>(done => { release = done; });
  const waiting = findVerificationInGmail({ hint: 'Fixture', signal: controller.signal, timeoutMs: 2000 });
  setTimeout(() => controller.abort(), 50);
  const aborted = await waiting;
  assert.ok('error' in aborted && /cancelled/.test(aborted.error), 'abort interrupts an in-flight MCP HTTP request');
  release?.(); blocked = undefined;
  const duplicateLink = verificationMessage({ id: 'link', htmlBody: '<a href="https://fixture.invalid/verify?token=example">Verify account</a><a href="https://fixture.invalid/verify?token=example">Verify account</a>' }, 0);
  assert.equal(duplicateLink.links.length, 1, 'repeated buttons for one verification URL are not ambiguous targets');
  console.log('PASS: real loopback MCP freshness, cached valid codes, request lower bounds, stale-code rejection, timeout, in-flight abort and duplicate verification links; no live mailbox.');
} finally {
  release?.(); grant.revoke(); await service.close(); rmSync(directory, { recursive: true, force: true });
}
