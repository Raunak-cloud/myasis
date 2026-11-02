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
let blockedRead: Promise<void> | undefined, emptySearch = false;
let searchOverride: ((signal?: AbortSignal) => Promise<Array<{ id: string }>>) | undefined;
let lastSearchSignal: AbortSignal | undefined, lastReadSignal: AbortSignal | undefined, completedBackendReads = 0;
let beforeThread: (() => void) | undefined;
const queries: string[] = [];
const service = new GmailMcpService({
  search: async (_owner, query, signal) => { queries.push(query); lastSearchSignal = signal; if (searchOverride) return searchOverride(signal); if (blocked) await blocked; signal?.throwIfAborted(); return emptySearch ? [] : [{ id: 'fixture-thread' }]; },
  thread: async (_owner, _thread, signal) => { reads++; lastReadSignal = signal; beforeThread?.(); if (blockedRead) await blockedRead; signal?.throwIfAborted(); completedBackendReads++; return messages; },
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
  assert.ok('reason' in knownFlow && knownFlow.reason === 'not-found' && knownFlow.poll.completedPolls > 0, 'a normal fresh-request flow still rejects that same nine-minute code without reuse evidence');
  messages.push(message('current-request', 15_000, '729184'));
  const requestedAt = Date.now() - 30_000;
  const fresh = await findVerificationInGmail({ hint: 'Fixture', want: 'code', requestedAt, timeoutMs: 2000 });
  assert.ok(!('error' in fresh) && fresh.value === '729184', 'a new authentication request excludes older same-employer codes');
  assert.ok(queries.at(-1)?.includes(`after:${Math.floor((requestedAt - 2 * 60_000) / 1000)}`), 'browser and API providers receive the same request freshness lower bound');
  messages = [{ ...message('spam-code', 1000, '482913'), labelIds: ['SPAM'] }];
  const spam = await findVerificationInGmail({ hint: 'Fixture', purpose: 'sign_in', want: 'code', timeoutMs: 2000 });
  assert.ok(!('error' in spam) && spam.value === '482913', 'a fresh matching code in Spam is usable');
  messages = [{ ...messages[0], id: 'unrelated-spam', subject: 'Another Employer verification' }];
  assert.ok('error' in await findVerificationInGmail({ hint: 'Fixture', purpose: 'sign_in', want: 'code', timeoutMs: 100 }), 'Spam does not relax employer matching');
  for (const labels of [['TRASH'], ['SENT'], ['DRAFT'], ['SPAM', 'TRASH']]) {
    messages = [{ ...message('excluded-folder', 1000, '482913'), labelIds: labels }];
    assert.ok('error' in await findVerificationInGmail({ hint: 'Fixture', purpose: 'sign_in', want: 'code', timeoutMs: 100 }), `excluded mail stays unavailable: ${labels.join(',')}`);
  }
  messages = [{ ...message('expired-spam', 16 * 60_000, '482913'), labelIds: ['SPAM'] }];
  assert.ok('error' in await findVerificationInGmail({ hint: 'Fixture', purpose: 'sign_in', want: 'code', timeoutMs: 100 }), 'Spam does not relax freshness');
  messages = [message('older-code', 5 * 60_000, '111222'), { id: 'link-instead', subject: 'Fixture: confirm your account', date: new Date().toISOString(), htmlBody: '<p>Confirm your Fixture account.</p><a href="https://fixture.invalid/verify?token=fixture">Verify account</a>' }];
  const alternative = await findVerificationInGmail({ hint: 'Fixture', want: 'code', allowAlternative: true, timeoutMs: 2000 });
  assert.ok(!('error' in alternative) && alternative.kind === 'link', 'a newer link-only authentication email wins over an older code and is reported immediately');
  messages = [message('old-link', 60 * 60_000, '111222')];
  const old = await findVerificationInGmail({ hint: 'Fixture', want: 'code', timeoutMs: 100 });
  assert.ok('reason' in old && old.reason === 'not-found' && old.poll.completedPolls > 0);
  messages = [{ id: 'punctuation', subject: 'Fixture sign-in verification', date: new Date().toISOString(), plaintextBody: 'Your security code is:\n482913' }];
  const punctuation = await findVerificationInGmail({ hint: 'Fixture', purpose: 'sign_in', want: 'code', timeoutMs: 2000 });
  assert.ok(!('error' in punctuation) && punctuation.value === '482913');
  messages = [{ id:'identity-provider-code',subject:'Your one-time code',sender:'noreply@login.fixtureidentity.invalid',date:new Date().toISOString(),plaintextBody:'482913 is your one-time code.' }];
  const branded = await findVerificationInGmail({hint:'Example Employer | Fixture Identity',site:'employer.login.fixtureidentity.invalid',purpose:'sign_in',want:'code',requestedAt:Date.now(),timeoutMs:2000});
  assert.ok(!('error' in branded) && branded.kind==='code' && branded.value==='482913','the browser relay can correlate an explicitly named provider with its sender DNS label');
  assert.ok('error' in await findVerificationInGmail({hint:'Example Employer | Fixture Identity',site:'employer.login.other.invalid',purpose:'sign_in',want:'code',timeoutMs:100}),'a different authentication realm cannot consume that provider code');
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
    assert.ok('reason' in expiredInTransit && expiredInTransit.reason === 'incomplete-check' && expiredInTransit.poll.completedPolls === 0, 'a response that returns after its lookup window expires cannot yield an aged code or a missing-email conclusion');
    logicalNow=realNow();const boundaryStart=logicalNow;
    messages=[message('just-before-window',1000,'482913')];
    beforeThread=()=>{logicalNow=boundaryStart+1999;beforeThread=undefined;};
    const justBeforeWindow=await findVerificationInGmail({hint:'Fixture',purpose:'sign_in',want:'code',timeoutMs:2000});
    assert.ok(!('error'in justBeforeWindow)&&justBeforeWindow.value==='482913','a fully verified result one millisecond before the window ends remains usable');
  } finally { Date.now = realNow; beforeThread = undefined; }

  const diagnostics: string[] = [];
  emptySearch = true;
  const empty = await findVerificationInGmail({ hint: 'Fixture', purpose: 'reset_password', want: 'link', timeoutMs: 150, log: message => diagnostics.push(message) });
  assert.ok('reason' in empty && empty.reason === 'not-found', 'completed empty searches may establish no match within the wait');
  assert.ok(diagnostics.some(line => /"operation":"search","phase":"completed"/.test(line) && /"threadCount":0/.test(line)));
  emptySearch = false; diagnostics.length = 0;
  blocked = new Promise<void>(done => { release = done; });
  const slowSearch = await findVerificationInGmail({ hint: 'Fixture', purpose: 'reset_password', want: 'link', timeoutMs: 150, log: message => diagnostics.push(message) });
  assert.ok('reason' in slowSearch && slowSearch.reason === 'incomplete-check', 'a first search interrupted by the poll window cannot establish a missing email or broken mailbox');
  assert.equal(slowSearch.poll.termination, 'poll-window-expired');
  assert.doesNotMatch(slowSearch.error!, /No matching verification email arrived/);
  assert.ok(diagnostics.some(line => /"classification":"incomplete-check"/.test(line) && /"completedSearches":0/.test(line)));
  release?.(); blocked = undefined; diagnostics.length = 0;
  blockedRead = new Promise<void>(done => { release = done; });
  const slowRead = await findVerificationInGmail({ hint: 'Fixture', purpose: 'reset_password', want: 'link', timeoutMs: 150, log: message => diagnostics.push(message) });
  assert.ok('reason' in slowRead && slowRead.reason === 'incomplete-check', 'a completed search without a completed thread read is not a complete healthy check');
  assert.equal(slowRead.poll.completedSearches, 1); assert.equal(slowRead.poll.completedPolls, 0);
  assert.ok(diagnostics.some(line => /"classification":"incomplete-check"/.test(line) && /"completedSearches":1/.test(line) && /"completedReads":0/.test(line)));
  release?.(); blockedRead = undefined; diagnostics.length = 0;

  // One complete empty poll, then an incomplete final HTTP request. This is
  // the live failure shape: the overall window is NOT an independent I/O fault.
  let polls = 0;
  blocked = new Promise<void>(done => { release = done; });
  searchOverride = async signal => { if (++polls === 1) return []; await blocked; signal?.throwIfAborted(); return [{ id: 'late-thread' }]; };
  const healthyThenWindow = await findVerificationInGmail({ hint:'Fixture', site:'auth.fixture.invalid', purpose:'reset_password', want:'link', timeoutMs:2300 });
  assert.ok('reason' in healthyThenWindow && healthyThenWindow.reason === 'not-found');
  assert.equal(healthyThenWindow.poll.completedPolls, 1); assert.equal(healthyThenWindow.poll.completedReads, 0);
  assert.equal(healthyThenWindow.poll.finalCheckIncomplete, true); assert.equal(healthyThenWindow.poll.termination, 'poll-window-expired');
  assert.ok(healthyThenWindow.poll.lastCompletedCheckAt); assert.equal(healthyThenWindow.poll.siteHost, 'auth.fixture.invalid');
  assert.equal(healthyThenWindow.poll.purpose, 'reset_password');
  assert.match(healthyThenWindow.error, /as of/); assert.doesNotMatch(healthyThenWindow.error, /This is a mailbox access failure/);
  const { verificationLookupFailureMessage } = await import('./agent/authentication.js');
  const toolRecord = JSON.parse(verificationLookupFailureMessage(healthyThenWindow));
  assert.deepEqual(toolRecord.poll, healthyThenWindow.poll, 'tool/shared-record text preserves structured completed-check and actual lookup-context evidence');
  assert.doesNotMatch(toolRecord.recovery, /This is a mailbox access failure|not a delayed email/);
  release?.(); blocked = undefined; searchOverride = undefined;
  await new Promise(done=>setTimeout(done,30));
  assert.ok(lastSearchSignal?.aborted, 'only the disconnected HTTP read receives cancellation');

  // A separate, shorter per-request timeout must remain an incomplete request
  // error, even though the overall polling window still has time remaining.
  blockedRead = new Promise<void>(done => { release = done; });
  const beforeLateRead = completedBackendReads;
  const independentReadTimeout = await findVerificationInGmail({ hint:'Fixture', purpose:'sign_in', want:'code', timeoutMs:2000, requestTimeoutMs:100 });
  assert.ok('reason' in independentReadTimeout && independentReadTimeout.reason === 'request-timeout');
  assert.equal(independentReadTimeout.poll.termination,'request-timeout'); assert.equal(independentReadTimeout.poll.completedPolls,0);
  await new Promise(done=>setTimeout(done,30)); assert.ok(lastReadSignal?.aborted);
  release?.(); blockedRead=undefined;
  await new Promise(done=>setTimeout(done,30)); assert.equal(completedBackendReads,beforeLateRead,'a cancelled late backend read cannot publish results after the lookup ended');

  messages = [message('boundary-success', 1000, '482913')];
  const nearBoundary = await findVerificationInGmail({ hint:'Fixture', purpose:'sign_in', want:'code', timeoutMs:300 });
  assert.ok(!('error' in nearBoundary)&&nearBoundary.value==='482913');
  const completedSignal=lastReadSignal, readsAtSuccess=reads;
  await new Promise(done=>setTimeout(done,320));
  assert.equal(completedSignal?.aborted,false,'normal HTTP completion does not cancel a successful read');
  assert.equal(reads,readsAtSuccess,'lookup timers do not start background polling after success');

  polls=0;
  searchOverride=async()=>{if(++polls===1)return [];throw new Error('Synthetic independent connection failure');};
  const healthyThenError=await findVerificationInGmail({hint:'Fixture',want:'code',timeoutMs:2500});
  assert.ok('reason' in healthyThenError&&healthyThenError.reason==='request-error');
  assert.equal(healthyThenError.poll.completedPolls,1,'prior healthy evidence cannot mask a later real network/backend failure');
  searchOverride=undefined;
  messages = [{ id: 'private-thread-marker', subject: 'Fixture verification private-subject-marker', sender: 'private-sender@fixture.invalid', date: new Date().toISOString(), plaintextBody: 'Your security code is 729184. private-body-marker https://fixture.invalid/private-token-marker' }];
  const loggedMatch = await findVerificationInGmail({ hint: 'Fixture', purpose: 'sign_in', want: 'code', timeoutMs: 2000, log: message => diagnostics.push(message) });
  assert.ok(!('error' in loggedMatch));
  assert.doesNotMatch(diagnostics.join('\n'), /private-|729184|https?:|@|Fixture/, 'run-scoped diagnostics must not reveal mail identifiers, content, sender, URL, code or query');
  assert.ok(diagnostics.some(line => /"classification":"matched"/.test(line) && /"completedReads":1/.test(line)));
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
  console.log('PASS: real loopback MCP freshness, Spam, empty polls vs interrupted search/read, private diagnostics, request lower bounds, stale-code rejection, in-flight abort and duplicate verification links; no live mailbox.');
} finally {
  release?.(); grant.revoke(); await service.close(); rmSync(directory, { recursive: true, force: true });
}
