import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { cases } from './fit-model-cases.mjs';

assert.ok(process.argv.includes('--live') && process.env.FIT_MODEL_EVAL_AUTHORIZED === '20261103', 'Explicit live evaluation authorization required.');
const root = resolve(process.env.FIT_MODEL_EVAL_OUTPUT ?? '');
const shard = Number(process.env.FIT_MODEL_EVAL_SHARD);
assert.ok(root.includes(`${sep}output${sep}fit-model-comparison-`) && [0, 1].includes(shard));
const directory = resolve(root, `shard-${shard}`);
mkdirSync(directory, { recursive: true, mode: 0o700 });
Object.assign(process.env, { DATA_DIR: directory, APPLICATION_AI_MODEL: 'celeris', COST_TRACKING: 'true',
  DRY_RUN: 'true', KEYWORDS: '', TARGET_ROLE: '', AI_INSTRUCTIONS_B64: '', MIN_SALARY: '0', MIN_HOURLY_RATE: '0' });
for (const key of ['OWTOMATE_RUN_START_ID', 'ADMIN_APPLICATION_MODEL', 'APPLICATION_REVIEW_MODE', 'APPLICATION_AGENT_MODE']) delete process.env[key];
const dist = resolve(import.meta.dirname, '../dist');
const original = readFileSync(resolve(dist, 'llm.js'), 'utf8');
const needle = 'const model = FIT_CLASSIFIER_MODEL;';
assert.equal(original.split(needle).length, 2, 'Only the fitter model selection may change in the isolated evaluation copy.');
const models = ['celeris-1', 'celeris-1-magnus'];
const fitters = {};
for (const model of models) {
  const source = model === 'celeris-1' ? original.replace(needle, "const model = 'celeris-1';") : original;
  const path = resolve(dist, `.fit-eval-${shard}-${model}.js`);
  writeFileSync(path, source, { mode: 0o600 });
  fitters[model] = (await import(pathToFileURL(path).href)).assessFit;
}
const { config } = await import(pathToFileURL(resolve(dist, 'config.js')).href);
const { celerisUsage } = await import(pathToFileURL(resolve(dist, 'cost-ledger.js')).href);
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const originalFetch = globalThis.fetch;
const started = performance.now();
let active, spent = 0, calls = 0, unknown = 0, fatal;
const budget = 2.5;
function stopped() { return existsSync(resolve(root, 'STOP')) || Boolean(fatal); }
const safeError = error => String(error?.message ?? error).replaceAll(process.env.CELERIS_API_KEY ?? 'NO_KEY', '[private key]').slice(0, 1200);
globalThis.fetch = async (input, init) => {
  assert.ok(active && !stopped(), 'Evaluation stopped; no further paid requests allowed.');
  const url = new URL(String(input));
  const allowed = new URL(process.env.CELERIS_BASE_URL ?? 'https://inference.celeris.ai');
  const body = JSON.parse(String(init?.body));
  assert.equal(url.origin, allowed.origin, 'Only the configured Celeris service is permitted.');
  assert.equal(url.pathname, `/${active.model}/v1/chat/completions`);
  assert.equal(body.model, active.model);
  assert.equal(body.tools, undefined, 'Fit evaluation must not obtain browser, employer or application tools.');
  const ceiling = (Buffer.byteLength(JSON.stringify(body.messages)) * 0.2 + Number(body.max_tokens) * 0.7) / 1_000_000;
  if (calls >= 300 || spent + ceiling > budget || performance.now() - started > 25 * 60_000) {
    fatal = 'Evaluation request, cost or time ceiling reached before another send.';
    throw Error(fatal);
  }
  const request = { model: body.model, primary: !JSON.stringify(body.messages).includes('RESPONSE FORMAT CORRECTION'),
    promptHash: hash({ messages: body.messages, schema: body.response_format }), maxTokens: body.max_tokens,
    thinking: body.chat_template_kwargs ?? null, startedAt: new Date().toISOString() };
  active.requests.push(request); calls++;
  const clock = performance.now();
  try {
    const response = await originalFetch(input, init);
    const payload = await response.clone().json().catch(() => null);
    const usage = celerisUsage(payload?.usage);
    Object.assign(request, { elapsedMs: performance.now() - clock, status: response.status,
      responseModel: payload?.model ?? null, promptTokens: usage?.prompt ?? null, cachedTokens: usage?.cached ?? null,
      outputTokens: usage?.completion ?? null, estimatedUsd: usage?.amountUsd ?? null });
    if (usage) spent += usage.amountUsd;
    else { unknown++; fatal = `Usage unavailable for HTTP ${response.status}; subsequent paid requests held.`; }
    appendFileSync(resolve(directory, 'wire-usage.jsonl'), JSON.stringify({ caseId: active.caseId, repetition: active.repetition, ...request }) + '\n', { mode: 0o600 });
    return response;
  } catch (error) {
    if (!request.status) { unknown++; fatal = 'Provider response unavailable; subsequent paid requests held to avoid unknown charges.'; }
    throw error;
  }
};
function progress(status) {
  writeFileSync(resolve(directory, 'state.tmp'), JSON.stringify({ at: new Date().toISOString(), status, active: active ? { caseId: active.caseId, repetition: active.repetition, model: active.model } : null,
    calls, estimatedUsd: spent, unknownModelCharges: unknown, fatal, elapsedMs: performance.now() - started }, null, 2));
  renameSync(resolve(directory, 'state.tmp'), resolve(directory, 'state.json'));
}
try {
  for (const [index, fixture] of cases.entries()) {
    if (index % 2 !== shard || stopped()) continue;
    for (const repetition of fixture.repeat ? [1, 2] : [1]) {
      if (stopped()) break;
      const input = fixture.input;
      const caseDirectory = resolve(directory, `${fixture.id}-r${repetition}`);
      mkdirSync(resolve(caseDirectory, 'resumes'), { recursive: true, mode: 0o700 });
      const cv = Object.entries(input.profile).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`).join('\n');
      writeFileSync(resolve(caseDirectory, 'resumes', 'Fictional CV.txt'), cv);
      writeFileSync(resolve(caseDirectory, 'resumes.json'), JSON.stringify([{ id: 'eval-cv', label: 'Fictional CV', fileName: 'Fictional CV.txt', isDefault: true }]));
      writeFileSync(resolve(caseDirectory, 'answers.json'), JSON.stringify(input.savedAnswers));
      writeFileSync(resolve(caseDirectory, 'knowledge.json'), JSON.stringify(input.notes ? [{ id: 'historical-note', label: 'Older candidate document', kind: 'note', text: input.notes, enabled: true }] : []));
      config.dataDir = caseDirectory; config.aiInstructions = input.instruction; config.keywords = input.keywords;
      config.targetRole = input.targetRole; config.resume.select = 'eval-cv'; Object.assign(config.rules, input.rules);
      const order = (index + repetition) % 2 ? models : [...models].reverse();
      for (const model of order) {
        if (stopped()) break;
        active = { caseId: fixture.id, repetition, model, requests: [] }; progress('running');
        const clock = performance.now(); let result, error;
        try { result = await fitters[model]({ ...input.job, id: `${fixture.id}-r${repetition}` }, input.profile); }
        catch (caught) { error = safeError(caught); }
        const row = { caseId: fixture.id, category: fixture.category, repetition, model, expected: fixture.expected,
          decision: result?.decision ?? 'error', score: result?.matchScore ?? null, correct: result?.decision === fixture.expected,
          reason: result?.reason ?? null, instructionCheck: result?.instructionCheck ?? null, roleAlignment: result?.roleFitCheck?.alignment ?? null,
          diagnosticConflict: result?.decision === 'apply' && (result?.instructionCheck?.violated === true || result?.roleFitCheck?.alignment === 'mismatch'
            || result?.credentialChecks?.some(item => item.mandatory && item.status === 'not-held') || result?.matchScore < input.rules.minScore),
          error, elapsedMs: performance.now() - clock, requests: active.requests,
          estimatedUsd: active.requests.reduce((sum, request) => sum + (request.estimatedUsd ?? 0), 0) };
        assert.ok(row.requests.length, 'An evaluation must make a measured provider request, not return a cached decision.');
        appendFileSync(resolve(directory, 'results.jsonl'), JSON.stringify(row) + '\n', { mode: 0o600 });
        active = undefined; progress(stopped() ? 'held' : 'running');
      }
    }
  }
  progress(stopped() ? 'held' : 'complete');
} catch (error) { fatal = safeError(error); progress('failed'); process.exitCode = 1; }
finally { globalThis.fetch = originalFetch; }
