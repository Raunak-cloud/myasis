import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { withApplicationModel } from '../application-model.js';
import { agentOnlyDocuments, agentOnlyEvidence, agentOnlyResumePath, applicationHistory } from './agent-only-evidence.js';

const directories: string[] = [];
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; directories.forEach(dir => rmSync(dir, { recursive: true, force: true })); });
function owner(marker: string) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-only-evidence-')); directories.push(dir);
  mkdirSync(join(dir, 'resumes')); mkdirSync(join(dir, 'knowledge'));
  writeFileSync(join(dir, 'resumes.json'), JSON.stringify([
    { id: 'selected', label: 'Current CV', fileName: 'current.txt' },
    { id: 'other', label: 'Other CV', fileName: 'other.txt' },
  ]));
  writeFileSync(join(dir, 'resumes', 'current.txt'), `${marker} full supported employment and qualifications`);
  writeFileSync(join(dir, 'resumes', 'other.txt'), `${marker} alternate occupation CV`);
  writeFileSync(join(dir, 'knowledge.json'), JSON.stringify([
    { id: 'note', label: 'Saved work rights', kind: 'note', enabled: true, text: `${marker} authoritative work limits` },
    { id: 'file', label: 'Certificate', kind: 'file', enabled: true, fileName: 'certificate.txt' },
    { id: 'disabled', label: 'Disabled note', kind: 'note', enabled: false, text: 'DISABLED_RECORD_MUST_NOT_APPEAR' },
  ]));
  writeFileSync(join(dir, 'knowledge', 'certificate.txt'), `${marker} real certificate evidence`);
  writeFileSync(join(dir, 'answers.json'), JSON.stringify([{ question: 'Confirmed account alias', answer: `${marker}@example.invalid`, createdAt: '2026-10-20T00:00:00Z' }]));
  writeFileSync(join(dir, 'applied.json'), JSON.stringify([{ jobId: marker, title: `${marker} old job`, company: 'Synthetic', appliedAt: '2026-10-19T00:00:00Z',
    platform: 'seek', url: 'https://jobs.example.invalid/' + marker, coverLetter: 'UNNEEDED_PRIVATE_HISTORY_LETTER' }]));
  return { dir, env: { DATA_DIR: dir, CELERIS_API_KEY: `SECRET_${marker}`, ANTHROPIC_API_KEY: `OTHER_SECRET_${marker}`,
    TARGET_ROLE: `${marker} target role`, ONSITE_CITY: `${marker} city`, WORK_ARRANGEMENTS: 'hybrid,onsite',
    AI_INSTRUCTIONS_B64: Buffer.from(`${marker} no overnight work`).toString('base64') } };
}

test('owner evidence includes approved full records and preferences while isolating parallel accounts', async () => {
  const owners = [owner('OWNER_ONE'), owner('OWNER_TWO')];
  globalThis.fetch = async () => { throw new Error('Evidence reads must never request a model or website'); };
  const results = await Promise.all(owners.map((record, index) => withApplicationModel(record.env, async () => {
    const evidence = await agentOnlyEvidence('work qualifications');
    const inventory = agentOnlyDocuments();
    assert.equal(inventory.length, 2);
    assert.equal(agentOnlyResumePath('selected'), join(record.dir, 'resumes', 'current.txt'));
    assert.equal(agentOnlyResumePath('current.txt'), null, 'only inventory IDs resolve');
    assert.equal(agentOnlyResumePath('../answers.json'), null);
    const marker = index ? 'OWNER_TWO' : 'OWNER_ONE';
    assert.ok(evidence.includes(`${marker} full supported employment`));
    assert.ok(evidence.includes(`${marker} alternate occupation CV`));
    assert.ok(evidence.includes(`${marker} real certificate evidence`));
    assert.ok(evidence.includes(`${marker} authoritative work limits`));
    assert.ok(evidence.includes(`${marker}@example.invalid`));
    assert.ok(evidence.includes(`${marker} no overnight work`));
    assert.ok(evidence.includes(`${marker} city`));
    assert.ok(!evidence.includes('DISABLED_RECORD_MUST_NOT_APPEAR'));
    assert.ok(!evidence.includes('SECRET_'));
    assert.ok(!evidence.includes(record.dir));
    assert.match(evidence, /read_candidate_evidence/);
    return evidence;
  })));
  assert.ok(!results[0].includes('OWNER_TWO'));
  assert.ok(!results[1].includes('OWNER_ONE'));
});

test('explicit selected resume limits documents and uploading without relying on process-wide selection', async () => {
  const record = owner('SELECTION');
  for (const selection of ['selected', 'Current CV', 'current.txt']) {
    await withApplicationModel({ ...record.env, RESUME_SELECT: selection }, async () => {
      assert.deepEqual(agentOnlyDocuments().map(item => item.id), ['selected']);
      assert.equal(agentOnlyResumePath('other'), null);
      assert.ok(!(await agentOnlyEvidence()).includes('SELECTION alternate occupation CV'));
    });
  }
  withApplicationModel({ ...record.env, RESUME_SELECT: 'missing' }, () => assert.deepEqual(agentOnlyDocuments(), []));
});

test('manifest traversal and unknown files cannot read sibling account data', async () => {
  const record = owner('SAFE'), foreign = owner('FOREIGN');
  writeFileSync(join(record.dir, 'resumes.json'), JSON.stringify([
    { id: 'relative', label: 'Traversal', fileName: '../answers.json' },
    { id: 'absolute', label: 'Absolute', fileName: join(foreign.dir, 'resumes', 'current.txt') },
    { id: 'windows', label: 'Windows traversal', fileName: '..\\answers.json' },
    { id: 'selected', label: 'Current CV', fileName: 'current.txt' },
    { id: 'broken', label: 'Missing file', fileName: 'missing.txt' },
  ]));
  writeFileSync(join(record.dir, 'knowledge.json'), JSON.stringify([
    { id: 'foreign', kind: 'file', label: 'Foreign', fileName: join(foreign.dir, 'resumes', 'current.txt'), enabled: true },
    { id: 'traverse', kind: 'file', label: 'Traversal', fileName: '../answers.json', enabled: true },
  ]));
  await withApplicationModel(record.env, async () => {
    assert.deepEqual(agentOnlyDocuments().map(item => item.id), ['selected']);
    assert.equal(agentOnlyResumePath('relative'), null);
    assert.equal(agentOnlyResumePath('absolute'), null);
    const evidence = await agentOnlyEvidence('FOREIGN');
    assert.ok(!evidence.includes('FOREIGN'));
    assert.ok(!evidence.includes('Confirmed account alias\":\"'));
    assert.ok(!evidence.includes(foreign.dir));
  });
});

test('symlinked document directories cannot escape the account boundary', async () => {
  const record = owner('SYMLINK_SAFE'), foreign = owner('SYMLINK_FOREIGN');
  rmSync(join(record.dir, 'resumes'), { recursive: true });
  symlinkSync(join(foreign.dir, 'resumes'), join(record.dir, 'resumes'), process.platform === 'win32' ? 'junction' : 'dir');
  await withApplicationModel(record.env, async () => {
    assert.deepEqual(agentOnlyDocuments(), []);
    assert.equal(agentOnlyResumePath('selected'), null);
    assert.ok(!(await agentOnlyEvidence()).includes('SYMLINK_FOREIGN'));
  });
});

test('long documents stay bounded and focused retrieval accesses omitted evidence', async () => {
  const record = owner('LONG');
  const text = Array.from({ length: 220 }, (_, index) => `${index}. ${'Ordinary evidence details. '.repeat(35)}\n`).join('')
    + '\nUNIQUE_NEUROSURGERY_CERTIFICATE: Verified specialist certificate awarded in Nepal.\n';
  writeFileSync(join(record.dir, 'resumes', 'current.txt'), text);
  await withApplicationModel(record.env, async () => {
    const initial = await agentOnlyEvidence();
    assert.ok(initial.length <= 24_000);
    assert.ok(initial.includes('DOCUMENT INVENTORY') && initial.includes('Current CV'));
    assert.ok(!initial.includes('UNIQUE_NEUROSURGERY_CERTIFICATE'));
    const focused = await agentOnlyEvidence('UNIQUE_NEUROSURGERY_CERTIFICATE specialist certificate Nepal');
    assert.ok(focused.includes('UNIQUE_NEUROSURGERY_CERTIFICATE'));
    assert.ok(focused.length <= 24_000);
    assert.match(focused, /Omitted text is not evidence of absence/);
    let offset = 0, pages = 0, sawLast = false;
    do {
      const page = await agentOnlyEvidence('selected', offset);
      assert.ok(page.length <= 24_000);
      assert.equal(Number(/OFFSET: (\d+)/.exec(page)![1]), offset);
      sawLast ||= page.includes('UNIQUE_NEUROSURGERY_CERTIFICATE');
      const next = /NEXT_OFFSET: (null|\d+)/.exec(page)![1];
      pages++;
      if (next === 'null') break;
      assert.ok(Number(next) > offset);
      offset = Number(next);
      assert.ok(pages < 30, 'pagination advances rather than repeating one retrieval');
    } while (true);
    assert.ok(pages > 1 && sawLast, 'complete document remains accessible even when its later passages are not relevant to the initial query');
    assert.equal(readFileSync(join(record.dir, 'resumes', 'current.txt'), 'utf8'), text);
  });
});

test('application history reads confirmed and uncertain owner records without altering reservations', () => {
  const record = owner('HISTORY'), foreign = owner('OTHER_HISTORY');
  const dbPath = join(record.dir, 'application-reservations.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE attempts (job_id TEXT,platform TEXT,state TEXT,updated_at TEXT); INSERT INTO attempts VALUES ('pending-job','seek','uncertain','2026-10-20T01:00:00Z')");
  db.close();
  const before = readFileSync(dbPath);
  const text = withApplicationModel(record.env, applicationHistory);
  assert.ok(text.includes('HISTORY old job') && text.includes('pending-job') && text.includes('uncertain'));
  assert.ok(!text.includes('UNNEEDED_PRIVATE_HISTORY_LETTER'));
  assert.match(text, /not proof of receipt or a new submission prohibition/);
  assert.deepEqual(readFileSync(dbPath), before);
  const isolated = withApplicationModel(foreign.env, applicationHistory);
  assert.ok(!isolated.includes('pending-job'));
  assert.ok(isolated.includes('OTHER_HISTORY old job'));
});

test('malformed owner manifests fail softly without exposing default or other account records', async () => {
  const record = owner('MALFORMED');
  for (const file of ['answers.json', 'knowledge.json', 'resumes.json', 'applied.json']) writeFileSync(join(record.dir, file), '{bad json');
  await withApplicationModel(record.env, async () => {
    assert.deepEqual(agentOnlyDocuments(), []);
    assert.equal(agentOnlyResumePath('selected'), null);
    const evidence = await agentOnlyEvidence();
    assert.ok(evidence.includes('"savedAnswerCount":0'));
    assert.ok(!evidence.includes('full supported employment'));
    assert.ok(applicationHistory().includes('"applied":[]'));
  });
});

test('custom cover letter preferences remain available and old application history is queryable with bounded pagination', async () => {
  const record = owner('PAGINATED_HISTORY');
  const env = { ...record.env, COVER_LETTER_MODE: 'reuse', COVER_LETTER_TEXT_B64: Buffer.from('Dear team,\n\nKeep this exact custom letter.').toString('base64') };
  const history = Array.from({ length: 1000 }, (_, index) => ({ jobId: `historic-${index}`, title: `Prior role ${index}`, company: 'Fixture', appliedAt: new Date(Date.now() - index * 60_000).toISOString() }));
  writeFileSync(join(record.dir, 'applied.json'), JSON.stringify(history));
  await withApplicationModel(env, async () => {
    const evidence = await agentOnlyEvidence();
    assert.match(evidence, /"mode":"reuse"/); assert.match(evidence, /Keep this exact custom letter/);
    assert.ok(applicationHistory().length <= 24_000);
    assert.match(applicationHistory(), /NEXT_OFFSET: \d+/);
    assert.match(applicationHistory('historic-999'), /historic-999/);
    let offset = 0, found = false;
    do {
      const page = applicationHistory('', offset);
      assert.ok(page.length <= 24_000);
      found ||= page.includes('historic-999');
      const next = /NEXT_OFFSET: (null|\d+)/.exec(page)![1];
      if (next === 'null') break;
      assert.ok(Number(next) > offset); offset = Number(next);
    } while (true);
    assert.ok(found);
  });
});
