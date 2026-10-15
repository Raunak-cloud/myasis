import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-model-cache-'));
const names = ['DATA_DIR', 'APPLICATION_AI_MODEL', 'APPLICATION_AI_ADMIN_ENABLED', 'APPLICATION_AI_OWNER_ID',
  'CELERIS_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY'] as const;
const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
process.env.DATA_DIR = directory;
process.env.APPLICATION_AI_MODEL = 'celeris';
process.env.CELERIS_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.OPENROUTER_API_KEY = '';
await import('./config.js');
const { cachedAssessment } = await import('./pipeline.js');
const { ReviewCache, listingFingerprint, reviewContextFingerprint } = await import('./review-cache.js');
const { applicationModelAvailable, assertApplicationModelConfigured, applicationModelIdentity, withApplicationModel } = await import('./application-model.js');
const { FIT_ASSESSMENT_VERSION } = await import('./model-versions.js');
const owner = `model-cache-${randomUUID()}`;
const bot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const selectHaiku = () => {
  process.env.APPLICATION_AI_MODEL = 'haiku';
  process.env.APPLICATION_AI_ADMIN_ENABLED = 'true';
  process.env.APPLICATION_AI_OWNER_ID = owner;
  process.env.DATA_DIR = resolve(bot, 'data', 'users', owner);
  process.env.OPENROUTER_API_KEY = 'fixture-only';
};
const selectCeleris = () => { process.env.APPLICATION_AI_MODEL = 'celeris'; process.env.DATA_DIR = directory; };
const profile = { name: 'Fixture', nationality: '', phone: '', email: 'fixture@example.test',
  expectedSalary: '', noticePeriod: '', willingToRelocate: false, experienceSummary: 'Retail',
  skills: ['Customer service'], excludedDomains: [], securityClearance: '' };
const job = { id: 'fixture', title: 'Retail assistant', company: 'Fixture', location: 'Sydney', url: 'https://fixture.invalid' };
const input = { version: 'model-cache-fixture', prompt: 'Same candidate and job' };
const accept = (value: { ok: boolean }) => value.ok;
let computations = 0;
const compute = async () => ({ ok: true, computation: ++computations });

try {
  // The previous fit contract could cache an incorrect rejection. A new
  // contract must recompute once, then keep normal same-version reuse.
  let versionComputations = 0;
  const computeVersion = async () => ({ ok: true, computation: ++versionComputations });
  const priorFit = { version: 'model-owned-fit-v13', prompt: 'Unchanged candidate and listing' };
  assert.equal((await cachedAssessment(priorFit, computeVersion, accept)).computation, 1);
  const currentFit = { ...priorFit, version: FIT_ASSESSMENT_VERSION };
  assert.equal((await cachedAssessment(currentFit, computeVersion, accept)).computation, 2,
    'The corrected fit contract cannot reuse a pre-fix decision');
  assert.equal((await cachedAssessment(currentFit, computeVersion, accept)).computation, 2,
    'The current fit contract retains normal assessment reuse');

  const celerisFingerprint = reviewContextFingerprint(profile);
  assert.equal((await cachedAssessment(input, compute, accept)).computation, 1);
  assert.equal((await cachedAssessment(input, compute, accept)).computation, 1);
  selectHaiku();
  assert.equal(applicationModelAvailable(), true, 'Haiku availability does not require a Celeris credential');
  assert.doesNotThrow(() => assertApplicationModelConfigured());
  const haikuFingerprint = reviewContextFingerprint(profile);
  assert.notEqual(haikuFingerprint, celerisFingerprint);
  assert.equal((await cachedAssessment(input, compute, accept)).computation, 2, 'Haiku cannot reuse a Celeris assessment');
  assert.equal((await cachedAssessment(input, compute, accept)).computation, 2);

  const cachePath = join(directory, 'fixture-review-cache.jsonl');
  writeFileSync(cachePath, JSON.stringify({ jobId: job.id, title: job.title, company: job.company,
    reviewedAt: new Date().toISOString(), reason: 'Fixture decision', disposition: 'fit-mismatch',
    listingFingerprint: listingFingerprint(job), contextFingerprint: celerisFingerprint,
    expiresAt: new Date(Date.now() + 60_000).toISOString() }) + '\n');
  const review = new ReviewCache({ cachePath });
  assert.equal(review.suppression(job, haikuFingerprint), null, 'Celeris historical suppression cannot mask Haiku review');
  assert.equal(review.suppression(job, celerisFingerprint)?.reason, 'Fixture decision');

  process.env.ANTHROPIC_API_KEY = 'fixture-only';
  assert.notEqual(reviewContextFingerprint(profile), haikuFingerprint, 'Native and routed Haiku have distinct provider identities');
  assert.equal((await cachedAssessment(input, compute, accept)).computation, 3);
  process.env.ANTHROPIC_API_KEY = '';
  selectCeleris();
  assert.equal((await cachedAssessment(input, compute, accept)).computation, 1, 'Returning to Celeris reuses its own assessment');

  const celerisEnvironment = { ...process.env };
  selectHaiku();
  const haikuEnvironment = { ...process.env };
  selectCeleris();
  let releases: Array<() => void> = [], started = 0;
  const pending = () => new Promise<{ ok: boolean; computation: number }>(resolve => {
    const computation = ++started;
    releases.push(() => resolve({ ok: true, computation }));
  });
  const scoped = (environment: typeof process.env) => withApplicationModel(environment, async () => {
    const selected = applicationModelIdentity().selection;
    const value = await cachedAssessment({ version: 'concurrent-models' }, pending, accept);
    assert.equal(applicationModelIdentity().selection, selected, 'An asynchronous account scope retains its model selection');
    return value;
  });
  const first = scoped(celerisEnvironment);
  const second = scoped(haikuEnvironment);
  assert.equal(started, 2, 'Concurrent provider selections cannot share an in-flight assessment');
  releases.forEach(release => release());
  assert.notEqual((await first).computation, (await second).computation);
  assert.equal(process.env.APPLICATION_AI_MODEL, 'celeris', 'Concurrent request scopes never mutate global model selection');

  selectHaiku();
  process.env.OPENROUTER_API_KEY = '';
  assert.equal(applicationModelAvailable(), false);
  assert.throws(() => assertApplicationModelConfigured(), /Claude Haiku 5\.5.*not configured/);
  console.log('PASS: fit-contract cache invalidation, selected-model credential guard, assessment/provider isolation, historical suppression and concurrent in-flight separation; no model calls');
} finally {
  for (const name of names) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'owtomate-model-cache-'));
  rmSync(directory, { recursive: true, force: true });
}
