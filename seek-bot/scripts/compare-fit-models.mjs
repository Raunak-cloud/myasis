import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { cases } from './fit-model-cases.mjs';

const root = resolve(import.meta.dirname, '../..');
const outIndex = process.argv.indexOf('--output');
const output = resolve(outIndex >= 0 ? process.argv[outIndex + 1] : resolve(root, 'output/fit-model-comparison-20261103'));
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const models = ['celeris-1', 'celeris-1-magnus'];
const jsonl = file => existsSync(file) ? readFileSync(file, 'utf8').split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line)) : [];
const writeJson = (file, value) => { writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n'); renameSync(file + '.tmp', file); };
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const median = values => { const x = [...values].sort((a, b) => a - b); return x.length ? (x[Math.floor((x.length - 1) / 2)] + x[Math.ceil((x.length - 1) / 2)]) / 2 : null; };
const expectedPerModel = 120 + cases.filter(fixture => fixture.repeat).length;
function summarize() {
  const rows = [0, 1].flatMap(shard => jsonl(resolve(output, `shard-${shard}/results.jsonl`)));
  const states = [0, 1].map(shard => existsSync(resolve(output, `shard-${shard}/state.json`)) ? JSON.parse(readFileSync(resolve(output, `shard-${shard}/state.json`), 'utf8')) : null);
  const metrics = Object.fromEntries(models.map(model => {
    const all = rows.filter(row => row.model === model), first = all.filter(row => row.repetition === 1), repeats = all.filter(row => row.repetition === 2);
    return [model, { completed: all.length, firstPass: first.length, correct: first.filter(row => row.correct).length,
      wrongApprovals: first.filter(row => row.decision === 'apply' && row.expected !== 'apply').length,
      wrongRejections: first.filter(row => row.decision === 'skip' && row.expected === 'apply').length,
      unresolved: first.filter(row => row.decision === 'uncertain' && row.expected !== 'uncertain').length,
      errors: first.filter(row => row.error).length, diagnosticConflicts: first.filter(row => row.diagnosticConflict).length,
      medianMs: median(first.map(row => row.elapsedMs)), meanMs: mean(first.map(row => row.elapsedMs)),
      totalEstimatedUsd: all.reduce((sum, row) => sum + row.estimatedUsd, 0), providerRequests: all.reduce((sum, row) => sum + row.requests.length, 0),
      formatCorrections: all.reduce((sum, row) => sum + row.requests.filter(request => !request.primary).length, 0),
      repeated: repeats.length, consistent: repeats.filter(row => first.find(original => original.caseId === row.caseId)?.decision === row.decision).length,
      categories: Object.fromEntries([...new Set(cases.map(fixture => fixture.category))].map(category => { const part = first.filter(row => row.category === category); return [category, { correct: part.filter(row => row.correct).length, total: part.length }]; })),
    }];
  }));
  const pairs = rows.filter(row => row.model === models[0]).map(a => { const b = rows.find(row => row.caseId === a.caseId && row.repetition === a.repetition && row.model === models[1]); return b ? { a, b } : null; }).filter(Boolean);
  const promptMismatches = pairs.filter(({ a, b }) => a.requests.find(r => r.primary)?.promptHash !== b.requests.find(r => r.primary)?.promptHash).map(({ a }) => `${a.caseId}-r${a.repetition}`);
  const report = { at: new Date().toISOString(), status: states.every(state => state?.status === 'complete') && rows.length === expectedPerModel * 2 ? 'complete' : 'running-or-held',
    uniqueCases: 120, expectedPerModel, modelRuns: rows.length, pairedRuns: pairs.length, promptMismatches, metrics,
    unknownModelCharges: states.reduce((sum, state) => sum + (state?.unknownModelCharges ?? 0), 0), states,
    disagreements: pairs.filter(({ a, b }) => a.repetition === 1 && a.decision !== b.decision).map(({ a, b }) => ({ caseId: a.caseId, expected: a.expected, base: a.decision, magnus: b.decision })),
    failures: rows.filter(row => row.repetition === 1 && !row.correct).map(row => ({ caseId: row.caseId, category: row.category, model: row.model, expected: row.expected, actual: row.decision, reason: row.reason, error: row.error })),
    limitations: ['Synthetic fictional cases, authored with explicit expected decisions before paid requests; no human panel or production outcome ground truth.', 'No exact numeric fit-score oracle: decision correctness is primary; score/diagnostic contradictions are reported.', 'Magnus uses the production medium-reasoning configuration; base Celeris-1 uses the existing client defaults.', 'Token cost is estimated from actual reported usage and published rates; provider billing reconciliation is separate.', 'No browser operations, job searches, account preference writes, application starts or employer submissions.'] };
  writeJson(resolve(output, 'report.json'), report);
  return report;
}
if (process.argv.includes('--summarize')) { const report = summarize(); console.log(JSON.stringify({ status: report.status, modelRuns: report.modelRuns, metrics: report.metrics, promptMismatches: report.promptMismatches, unknownModelCharges: report.unknownModelCharges })); }
else if (!process.argv.includes('--live')) {
  assert.equal(cases.length, 120); assert.equal(cases.filter(fixture => fixture.repeat).length, 20);
  for (const fixture of cases) { assert.ok(['apply', 'skip', 'uncertain'].includes(fixture.expected)); assert.ok(fixture.rationale); assert.ok(!JSON.stringify(fixture.input).includes('expectedDecision')); }
  console.log(JSON.stringify({ validation: 'passed', uniqueCases: cases.length, repetitions: 20, plannedModelRuns: expectedPerModel * 2, categories: 12, datasetSha256: hash(cases), liveRequests: 0 }));
} else {
  assert.ok(process.env.CELERIS_API_KEY?.trim(), 'Configured Celeris access required.');
  assert.ok(!existsSync(output), 'Existing benchmark output requires reconciliation, not another launch.');
  mkdirSync(output, { recursive: true, mode: 0o700 });
  writeFileSync(resolve(output, 'cases.json'), JSON.stringify(cases, null, 2), { mode: 0o600 });
  writeFileSync(resolve(output, 'RUN_STARTED'), new Date().toISOString(), { flag: 'wx', mode: 0o600 });
  const manifest = { startedAt: new Date().toISOString(), sourceRelease: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    casesSha256: hash(cases), productionLlmSourceSha256: hash(readFileSync(resolve(root, 'seek-bot/src/llm.ts'), 'utf8')),
    compiledLlmSha256: hash(readFileSync(resolve(root, 'seek-bot/dist/llm.js'), 'utf8')), onlyEvaluationChange: "const model = FIT_CLASSIFIER_MODEL -> const model = 'celeris-1' in isolated copied module",
    expectedPerModel, concurrency: 2, totalUsdCeiling: 5, requestsCeiling: 600, liveApplications: 0, savedPreferenceWrites: 0 };
  writeFileSync(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const clock = performance.now();
  const children = [0, 1].map(shard => spawn(process.execPath, [resolve(import.meta.dirname, 'fit-model-eval-worker.mjs'), '--live'], {
    cwd: root, env: { ...process.env, FIT_MODEL_EVAL_OUTPUT: output, FIT_MODEL_EVAL_SHARD: String(shard), FIT_MODEL_EVAL_AUTHORIZED: '20261103' }, stdio: ['ignore', 'pipe', 'pipe'] }));
  writeFileSync(resolve(output, 'pids.json'), JSON.stringify({ controller: process.pid, workers: children.map(child => child.pid) }));
  for (const [index, child] of children.entries()) for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
    appendFileSync(resolve(output, `worker-${index}.log`), data);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => writeFileSync(resolve(output, 'STOP'), `Operator stop ${signal}; drain current requests without starting more.\n`));
  const timer = setInterval(() => { const report = summarize(); console.log(JSON.stringify({ progress: report.modelRuns, planned: expectedPerModel * 2, estimatedUsd: Object.values(report.metrics).reduce((sum, metric) => sum + metric.totalEstimatedUsd, 0), elapsedSeconds: (performance.now() - clock) / 1000 })); }, 20000);
  const exits = await Promise.all(children.map(child => new Promise(done => {
    child.once('error', error => { writeFileSync(resolve(output, 'STOP'), 'Evaluation worker could not start; hold further requests.\n'); done({ code: null, error: error.message }); });
    child.once('exit', (code, signal) => done({ code, signal }));
  })));
  clearInterval(timer); const report = summarize(); writeJson(resolve(output, 'completion.json'), { completedAt: new Date().toISOString(), exits, elapsedMs: performance.now() - clock, status: report.status });
  console.log(JSON.stringify({ status: report.status, modelRuns: report.modelRuns, metrics: report.metrics, promptMismatches: report.promptMismatches }));
  if (report.status !== 'complete' || report.promptMismatches.length || report.unknownModelCharges) process.exitCode = 1;
}
