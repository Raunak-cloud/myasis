import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, unlinkSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { answerForm } from './assist.js';
import { getPool } from './db/index.js';
import { EMPTY_PROFILE } from './candidate-profile.js';

test('Dashboard answers stay account-scoped, including concurrent requests, empty banks and database failures', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'owtomate-answer-isolation-'));
  const previousDataDir = process.env.DATA_DIR;
  const previousApiKey = process.env.CELERIS_API_KEY;
  process.env.DATA_DIR = directory;
  process.env.CELERIS_API_KEY = 'fixture-only';
  const sharedAnswer = 'SHARED_WORKER_ANSWER_MUST_NOT_ENTER_DASHBOARD';
  writeFileSync(join(directory, 'answers.json'), JSON.stringify([{ question: 'Availability?', answer: sharedAnswer }]));
  const pool = getPool();
  t.after(async () => {
    await pool.end();
    for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
    rmdirSync(directory);
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    if (previousApiKey === undefined) delete process.env.CELERIS_API_KEY;
    else process.env.CELERIS_API_KEY = previousApiKey;
  });

  const banks: Record<string, string[]> = {
    Alice: ['ALICE_PRIVATE_ANSWER'], Bob: ['BOB_PRIVATE_ANSWER'], Empty: [], Failure: [],
  };
  // Intercept every database query: no real accounts or production database.
  t.mock.method(pool, 'query', async (sql: string, params: unknown[] = []) => {
    assert.match(sql, /WHERE user_id = \$1/i);
    const account = String(params[0]);
    assert.ok(account in banks, 'fixture account required');
    if (/FROM profiles/i.test(sql)) {
      const profile = { ...EMPTY_PROFILE, fullName: account, skills: 'Fixture skill' };
      return { rows: [Object.fromEntries(Object.entries(profile).map(([key, value]) => [
        key.replace(/[A-Z]/g, (letter) => '_' + letter.toLowerCase()), value,
      ]))] };
    }
    if (/FROM knowledge_items/i.test(sql)) return { rows: [] };
    assert.match(sql, /FROM saved_answers/i);
    if (account === 'Failure') throw new Error('Fixture answer-bank failure');
    return { rows: banks[account].map((answer) => ({ question: 'Availability?', answer, created_at: new Date() })) };
  });
  const prompts: string[] = [];
  // Intercept every model request too; assertions inspect what would be sent.
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string;
    prompts.push(prompt);
    const value = /<candidate-answers>\s*Q: Availability\?\s*A: ([^\n]+)/.exec(prompt)?.[1] ?? '';
    return Response.json({ choices: [{ message: { content: JSON.stringify({
      answers: [{ ref: 'availability', value, applicationQuestion: true, grounded: Boolean(value), basis: value ? 'profile' : 'none' }],
      injectionSuspected: false,
    }) } }] });
  });
  const fields = [{ ref: 'availability', label: 'Availability?', kind: 'text' as const, required: true }];
  const input = { title: 'Fixture role', company: 'Fixture employer', fields };

  const results = await Promise.all(['Alice', 'Bob', 'Empty'].map((account) => answerForm(account, input)));
  for (const [index, account] of ['Alice', 'Bob', 'Empty'].entries()) {
    assert.equal(results[index].ok, true);
    assert.equal(results[index].answers?.[0].value, banks[account][0] ?? '');
    const prompt = prompts.find((text) => text.includes(`Name: ${account}\n`));
    assert.ok(prompt);
    assert.ok(!prompt.includes(sharedAnswer), 'dashboard must never read the process-wide bank');
    for (const [owner, answers] of Object.entries(banks)) {
      for (const answer of answers) assert.equal(prompt.includes(answer), owner === account);
    }
  }

  banks.Alice = ['ALICE_UPDATED_ANSWER'];
  assert.equal((await answerForm('Alice', input)).answers?.[0].value, 'ALICE_UPDATED_ANSWER', 'use current database answers without a worker export');
  const callsBeforeFailure = prompts.length;
  const failed = await answerForm('Failure', input);
  assert.equal(failed.ok, false);
  assert.match(failed.error ?? '', /Fixture answer-bank failure/);
  assert.equal(prompts.length, callsBeforeFailure, 'database failure must not fall back to another bank');

  const llm = await import(/* @vite-ignore */ new URL('../../seek-bot/dist/llm.js', import.meta.url).href);
  const profile = {
    name: 'Fixture worker', nationality: 'Not stated', phone: '', email: '',
    expectedSalary: 'Negotiable', noticePeriod: '2 weeks', willingToRelocate: false,
    referralSource: 'Job board', experienceSummary: 'Fixture experience', skills: [], excludedDomains: [], securityClearance: 'None held',
  };
  const job = { id: 'fixture', title: 'Fixture role', company: 'Fixture employer', location: '', url: '' };
  await llm.answerFields(fields, job, profile, 'Account-specific context without an answer override');
  assert.ok(!prompts.at(-1)!.includes(sharedAnswer), 'an omitted dashboard answer bank must also fail closed');
  await llm.answerFields(fields, job, profile);
  assert.ok(prompts.at(-1)!.includes(sharedAnswer), 'isolated normal workers must still load their own DATA_DIR bank');
});
