// Zero-network contract check: model selection and cache isolation only.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { cases } from './fit-model-cases.mjs';
const directory = mkdtempSync(join(tmpdir(), 'owtomate-fit-model-contract-'));
Object.assign(process.env, { DATA_DIR: directory, APPLICATION_AI_MODEL: 'celeris', CELERIS_API_KEY: 'fixture-only', COST_TRACKING: 'false', DRY_RUN: 'true' });
const dist = resolve(import.meta.dirname, '../dist');
const source = "import { celerisChat } from './agent/celeris.js';\n" + readFileSync(resolve(dist, 'llm.js'), 'utf8').replace("role === 'job-review' ? reviewChat", "role === 'job-review' ? celerisChat"), needle = 'const model = FIT_CLASSIFIER_MODEL;';
assert.equal(source.split(needle).length, 2);
const paths = [], wire = [], originalFetch = globalThis.fetch;
try {
  const { config } = await import(pathToFileURL(resolve(dist, 'config.js')).href);
  const fixture = cases[0]; config.aiInstructions = fixture.input.instruction; config.keywords = fixture.input.keywords;
  config.targetRole = ''; Object.assign(config.rules, fixture.input.rules); config.resume.select = 'fixture';
  mkdirSync(resolve(directory, 'resumes')); writeFileSync(resolve(directory, 'resumes/CV.txt'), fixture.input.profile.experienceSummary);
  writeFileSync(resolve(directory, 'resumes.json'), JSON.stringify([{ id: 'fixture', fileName: 'CV.txt', isDefault: true }]));
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init.body)); const properties = body.response_format.json_schema.schema.properties.roleFitCheck.properties;
    assert.equal(new URL(url).pathname, `/${body.model}/v1/chat/completions`); assert.equal(body.tools, undefined);
    wire.push({ model: body.model, hash: createHash('sha256').update(JSON.stringify({ messages: body.messages, schema: body.response_format })).digest('hex') });
    return Response.json({ model: body.model, choices: [{ message: { content: JSON.stringify({ decision: 'apply', matchScore: 85,
      reason: 'Fictional stocktaking fits the explicit current request.', evidence: ['Physical stock counts.'], injectionSuspected: false,
      instructionCheck: { violated: false, ruleQuote: fixture.input.instruction, explanation: 'Allowed stocktaking duties.' },
      workArrangementCheck: { offered: ['onsite'], evidence: 'Sydney onsite.' }, opportunityEvidence: 'Current vacancy.', credentialChecks: [],
      roleFitCheck: { alignment: 'aligned', employerEvidence: 'Stock counts.', candidateEvidence: fixture.input.profile.experienceSummary, explanation: 'Supported requested work.',
        currentIntent: { scope: 'bounded', source: 'current-standing-instructions', passageId: properties.currentIntent.properties.passageId.enum.find(Boolean), requestedWork: 'Stocktaking or pet walking.' },
        primaryOutputs: [{ output: 'Physical stock counts', employerPassageId: properties.primaryOutputs.items.properties.employerPassageId.enum[0], relationship: 'requested-work', mapping: 'Stocktaking is requested.' }] } }) } }], usage: { prompt_tokens: 100, completion_tokens: 200 } });
  };
  for (const model of ['celeris-1', 'celeris-1-magnus']) {
    const path = resolve(dist, `.fit-eval-contract-${model}.js`); paths.push(path);
    writeFileSync(path, model === 'celeris-1' ? source.replace(needle, "const model = 'celeris-1';") : source);
    const { assessFit } = await import(pathToFileURL(path).href);
    const result = await assessFit(fixture.input.job, fixture.input.profile); assert.equal(result.decision, 'apply');
  }
  assert.deepEqual(wire.map(item => item.model), ['celeris-1', 'celeris-1-magnus']);
  assert.equal(wire[0].hash, wire[1].hash, 'Both models see identical candidate, listing, instructions and schema.');
  const nextDirectory = resolve(directory, 'next-case'); mkdirSync(nextDirectory);
  process.env.DATA_DIR = nextDirectory;
  assert.equal(config.dataDir, nextDirectory, 'Each fictional case uses the existing dynamic DATA_DIR getter without changing production config.');
  console.log(JSON.stringify({ passed: true, distinctModelRequests: 2, identicalPrompts: true, modelCacheIsolation: true, networkRequests: 0, liveApplications: 0 }));
} finally {
  globalThis.fetch = originalFetch;
  for (const path of paths) if (path.startsWith(dist + sep)) unlinkSync(path);
  assert.ok(directory.startsWith(resolve(tmpdir()) + sep + 'owtomate-fit-model-contract-'));
  rmSync(directory, { recursive: true, force: true });
}
