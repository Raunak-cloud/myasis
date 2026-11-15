import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processHrJob, type HrWorkerDependencies } from './worker.js';
import { composeHrEmail } from './agent.js';
import { createHrTransport, type HrTransportDependencies } from './transport.js';
import type { HrJob, HrStatus } from './store.js';
import type { HiringContact } from './discovery.js';

const contact: HiringContact = { email: 'careers@fixture.invalid', kind: 'recruitment', companyDomain: 'fixture.invalid', sourceUrl: 'https://fixture.invalid/careers', sourceText: 'For recruitment enquiries email careers@fixture.invalid', validatedAt: '2026-11-16T00:00:00Z' };

function simulation() {
  const row: HrJob = { id: 'outreach-fixture-91', user_id: 'candidate-7', application_id: 'application-23', company_key: 'fixture', dedupe_key: 'role', job_id: '23', platform: 'seek',
    title: 'Reporting Analyst', company: 'Fixture', url: 'https://fixture.invalid/jobs/23', cover_letter: 'SQL reporting experience.', status: 'researching',
    to_email: null, subject: null, body: null, contact: null, created_at: '2026-11-16T00:00:00Z', lease: 'fixture-lease', attempts: 1, cost_usd: 0 };
  const events: string[] = [];
  const state = { enabled: true, sends: 0, generations: 0, discovers: 0, lostReceipt: false, failSentWrite: false, disableInCompose: false, denySendClaim: false };
  const remote: { id: string; raw: string }[] = [];
  const transport = createHrTransport({ access: async () => ({ connected: true, account: 'candidate@fixture.invalid', provider: 'mcp' } as any),
    owner: async () => ({ email: 'candidate@fixture.invalid' }),
    request: (async (user, path, options) => {
      assert.equal(user, row.user_id, 'every transport access belongs to the queued owner');
      if (path === 'messages/send') {
        state.sends++; remote.push({ id: 'gmail-fixture-receipt', raw: Buffer.from((options?.data as any).raw, 'base64url').toString() });
        if (state.lostReceipt) throw Error('Response lost after Gmail accepted it');
        return { id: remote.at(-1)!.id };
      }
      if (path === 'messages') return { messages: remote.map(message => ({ id: message.id })) };
      if (path === 'messages/gmail-fixture-receipt') return { id: remote[0].id, labelIds: ['SENT'], payload: { headers: remote[0].raw.split('\r\n\r\n')[0].split('\r\n').map(line => {
        const split = line.indexOf(':'); return { name: line.slice(0, split), value: line.slice(split + 1).trim() };
      }) } };
      throw Error('Unexpected simulated Gmail request');
    }) as HrTransportDependencies['request'], sendBrowser: async () => { throw Error('No browser in this OAuth fixture'); }, reconcileBrowser: async () => null,
  });
  const deps = { access: async () => ({ connected: true }), apiKey: () => 'fixture-model-key', profile: async () => ({ fullName: 'Taylor Candidate', headline: 'Analyst', experienceSummary: 'SQL reporting', skills: 'SQL', highestQualification: 'BSc' }),
    store: { allowed: async () => state.enabled, cache: async () => ({ fresh: true, contact }), saveContact: async () => {},
      draft: async (_job: HrJob, found: HiringContact, subject: string, body: string, cost: number) => { row.to_email = found.email; row.subject = subject; row.body = body; row.cost_usd += cost; events.push('persist-draft'); },
      sending: async () => { if (state.denySendClaim) return false; row.status = 'sending'; events.push('claim-send'); return true; },
      finish: async (_job: HrJob, status: HrStatus, _reason: string, _receipt: unknown, extra = 0) => {
        if (status === 'sent' && state.failSentWrite) { state.failSentWrite = false; throw Error('Database receipt write temporarily failed'); }
        row.status = status; row.cost_usd += extra; events.push(status);
      },
    },
    discover: async () => { state.discovers++; return { contact, reason: 'Published on company site', pagesRead: 1, retryable: false }; },
    compose: async (input: Parameters<typeof composeHrEmail>[0], options: Parameters<typeof composeHrEmail>[1]) => {
      state.generations++; if (state.disableInCompose) state.enabled = false;
      return composeHrEmail(input, { ...options, fetcher: async () => Response.json({ usage: { cost: .002 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ subject: 'Reporting Analyst application', body: 'Hello hiring team,\n\nI applied for the Reporting Analyst role. My SQL reporting experience is relevant to the role. Thank you for considering my application.\n\nTaylor Candidate' }) } }] }) });
    },
    send: transport.send, reconcile: transport.reconcile,
  } as unknown as HrWorkerDependencies;
  return { row, state, remote, events, deps };
}

test('full HR simulation persists exact email, survives lost send response, and reconciles without a second send', async () => {
  const fixture = simulation(); fixture.state.lostReceipt = true;
  await processHrJob({ ...fixture.row }, fixture.deps);
  assert.equal(fixture.row.status, 'unconfirmed'); assert.equal(fixture.state.sends, 1); assert.equal(fixture.state.generations, 1);
  assert.ok(fixture.events.indexOf('persist-draft') < fixture.events.indexOf('claim-send'));
  const retainedBody = fixture.row.body;
  fixture.deps.profile = async () => { throw Error('Recovery must not read a newer profile'); };
  fixture.deps.compose = async () => { throw Error('Recovery must not rewrite the message'); };
  await processHrJob({ ...fixture.row }, fixture.deps);
  assert.equal(fixture.row.status, 'sent'); assert.equal(fixture.row.body, retainedBody); assert.equal(fixture.state.sends, 1); assert.equal(fixture.row.cost_usd, .002);
  const delivered = Buffer.from(fixture.remote[0].raw.split('\r\n\r\n')[1], 'base64').toString();
  assert.equal(delivered, fixture.row.body, 'the user sees the exact email delivered to Gmail');
});

test('a lost database receipt update also reconciles the one original email', async () => {
  const fixture = simulation(); fixture.state.failSentWrite = true;
  await processHrJob({ ...fixture.row }, fixture.deps);
  assert.equal(fixture.row.status, 'unconfirmed');
  await processHrJob({ ...fixture.row }, fixture.deps);
  assert.equal(fixture.row.status, 'sent'); assert.equal(fixture.state.sends, 1); assert.equal(fixture.state.generations, 1);
});

test('opt-out during generation and loss of final send claim both stop delivery', async () => {
  const optedOut = simulation(); optedOut.state.disableInCompose = true;
  await processHrJob({ ...optedOut.row }, optedOut.deps);
  assert.equal(optedOut.state.sends, 0); assert.equal(optedOut.row.cost_usd, .002);
  const lostClaim = simulation(); lostClaim.state.denySendClaim = true;
  await processHrJob({ ...lostClaim.row }, lostClaim.deps);
  assert.equal(lostClaim.state.sends, 0); assert.equal(lostClaim.row.cost_usd, .002);
});
