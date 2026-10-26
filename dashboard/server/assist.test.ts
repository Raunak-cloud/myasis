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
  const names = ['DATA_DIR', 'CELERIS_API_KEY', 'ADMIN_EMAILS'] as const;
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.DATA_DIR = directory;
  process.env.CELERIS_API_KEY = 'fixture-only';
  process.env.ADMIN_EMAILS = 'admin-fixture@example.test';
  const { applicationModelEnvironment } = await import(new URL('../../seek-bot/dist/application-model.js', import.meta.url).href) as typeof import('../../seek-bot/src/application-model.js');
  const sharedAnswer = 'SHARED_WORKER_ANSWER_MUST_NOT_ENTER_DASHBOARD';
  writeFileSync(join(directory, 'answers.json'), JSON.stringify([{ question: 'Availability?', answer: sharedAnswer }]));
  const pool = getPool();
  t.after(async () => {
    await pool.end();
    for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
    rmdirSync(directory);
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });

  const banks: Record<string, string[]> = {
    Alice: ['ALICE_PRIVATE_ANSWER'], Bob: ['BOB_PRIVATE_ANSWER'], Empty: [], Failure: [],
  };
  // Intercept every database query: no real accounts or production database.
  t.mock.method(pool, 'query', async (sql: string, params: unknown[] = []) => {
    const account = String(params[0]);
    assert.ok(account in banks, 'fixture account required');
    if (/FROM users/i.test(sql)) return { rows: [{ id: account }] };
    assert.match(sql, /WHERE user_id = \$1/i);
    if (/FROM profiles/i.test(sql)) {
      const profile = { ...EMPTY_PROFILE, fullName: account, skills: 'Fixture skill', workRights: 'Citizen' };
      return { rows: [Object.fromEntries(Object.entries(profile).map(([key, value]) => [
        key.replace(/[A-Z]/g, (letter) => '_' + letter.toLowerCase()), value,
      ]))] };
    }
    if (/FROM knowledge_items/i.test(sql)) return { rows: [] };
    if (/FROM settings/i.test(sql)) return { rows: [
      { key: 'WORK_ARRANGEMENTS', value: account === 'Alice' ? 'remote' : 'hybrid,onsite' },
      { key: 'ONSITE_CITY', value: account === 'Alice' ? 'Melbourne' : 'Sydney' },
      { key: 'COVER_LETTER_INSTRUCTIONS', value: `${account} cover letter style` },
    ] };
    assert.match(sql, /FROM saved_answers/i);
    if (account === 'Failure') throw new Error('Fixture answer-bank failure');
    return { rows: banks[account].map((answer) => ({ question: 'Availability?', answer, created_at: new Date() })) };
  });
  const prompts: string[] = [];
  const routedModels = new Map<string, string>();
  // Intercept every model request too; assertions inspect what would be sent.
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const content = body.messages[0].content;
    const prompt = typeof content === 'string' ? content : content.filter((block: { type: string }) => block.type === 'text').map((block: { text: string }) => block.text).join('\n');
    prompts.push(prompt);
    const account = /Name: ([^\n]+)\n/.exec(prompt)?.[1] ?? '';
    assert.equal(applicationModelEnvironment().COVER_LETTER_INSTRUCTIONS, account in banks ? `${account} cover letter style` : undefined, 'extension cover-letter helpers receive only this account’s saved preferences');
    routedModels.set(account, body.model);
    const value = /<candidate-answers>\s*Q: Availability\?\s*A: ([^\n]+)/.exec(prompt)?.[1] ?? '';
    const answer = JSON.stringify({
      answers: [{ ref: 'availability', value, applicationQuestion: true, grounded: Boolean(value), basis: value ? 'profile' : 'none' }],
      injectionSuspected: false,
    });
    assert.ok(!String(url).endsWith('/messages'), 'only the established model protocol is used');
    return Response.json({ choices: [{ message: { content: answer } }] });
  });
  const fields = [{ ref: 'availability', label: 'Availability?', kind: 'text' as const, required: true }];
  const input = { title: 'Fixture role', company: 'Fixture employer', fields };

  const results = await Promise.all(['Alice', 'Bob', 'Empty'].map((account) => answerForm(account, input)));
  for (const [index, account] of ['Alice', 'Bob', 'Empty'].entries()) {
    assert.equal(results[index].ok, true, results[index].error);
    assert.equal(results[index].answers?.[0].value, banks[account][0] ?? '');
    const prompt = prompts.find((text) => text.includes(`Name: ${account}\n`));
    assert.ok(prompt);
    assert.match(prompt, /Work rights \(Australia\): Citizen/);
    assert.match(prompt, /Nationality: Not stated/);
    assert.match(prompt, account === 'Alice' ? /"arrangements":\["remote"\],"onsiteCity":"Melbourne"/ : /"arrangements":\["hybrid","onsite"\],"onsiteCity":"Sydney"/);
    assert.ok(!prompt.includes(sharedAnswer), 'dashboard must never read the process-wide bank');
    for (const [owner, answers] of Object.entries(banks)) {
      for (const answer of answers) assert.equal(prompt.includes(answer), owner === account);
    }
  }
  assert.match(routedModels.get('Bob') ?? '', /^celeris-1/);
  assert.match(routedModels.get('Alice') ?? '', /^celeris-1/);
  assert.match(routedModels.get('Empty') ?? '', /^celeris-1/);
  assert.equal(process.env.DATA_DIR, directory, 'concurrent dashboard accounts never mutate the global data directory');

  banks.Alice = ['ALICE_UPDATED_ANSWER'];
  assert.equal((await answerForm('Alice', input)).answers?.[0].value, 'ALICE_UPDATED_ANSWER', 'use current database answers without a worker export');
  const callsBeforeFailure = prompts.length;
  const failed = await answerForm('Failure', input);
  assert.equal(failed.ok, false);
  assert.match(failed.error ?? '', /Fixture answer-bank failure/);
  assert.equal(prompts.length, callsBeforeFailure, 'database failure must not fall back to another bank');

  assert.ok([...routedModels.values()].every(value => value === 'celeris-1-magnus'), 'extension suggestions use Magnus directly without the retired form engine');
});
