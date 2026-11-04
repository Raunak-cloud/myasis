import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'patchright';
import type { PreparedApplication } from '../application-review-types.js';
import { createReadinessFixtureReply } from './readiness-fixture.js';
import { specialistFixtureReply } from './specialist-fixture.js';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-document-provenance-'));
Object.assign(process.env, { DATA_DIR: directory, CELERIS_API_KEY: 'fixture-only', COST_TRACKING: 'false',
  FORM_CORPUS_DIR: join(directory, 'corpus'), APPLICATION_REVIEW_MODE: 'prepare', APPLICATION_AI_MODEL: 'celeris',
  ALLOW_EXTERNAL_APPLY: 'true' });
const { config } = await import('../config.js');
const { AgentFiles } = await import('./agent-files.js');
const { runAgentOnlyApplication } = await import('./agent-only.js');
const { applicationRevision, withCoverLetter } = await import('../application-review-content.js');
const { preserveDocument, verifiedDocumentPath, reviseAttachedCoverLetter } = await import('../application-documents.js');
config.dryRun = false;
mkdirSync(join(directory, 'resumes')); mkdirSync(join(directory, 'knowledge'));
writeFileSync(join(directory, 'resumes', 'CV.txt'), 'Exact original candidate resume.');
writeFileSync(join(directory, 'resumes.json'), JSON.stringify([{ id: 'cv', label: 'CV', fileName: 'CV.txt' }]));
const letter = 'Dear hiring team,\n\nExact supplied cover letter.\n\nKind regards,\nFixture Candidate';
writeFileSync(join(directory, 'knowledge', 'Neutral-name.txt'), letter);
writeFileSync(join(directory, 'knowledge', 'Extra.txt'), 'Other supporting document.');
writeFileSync(join(directory, 'knowledge.json'), JSON.stringify([
  { id: '10', label: 'Owner document', kind: 'file', fileName: 'Neutral-name.txt', enabled: true },
  { id: '11', label: 'Other document', kind: 'file', fileName: 'Extra.txt', enabled: true },
]));
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }) });
const originalFetch = globalThis.fetch;
type Call = { name: string; args: Record<string, unknown> };
type Decision = (body: any, page: Page) => Call[] | Promise<Call[]>;
const prepare = (extra: Record<string, unknown> = {}): Call => ({ name: 'prepare_application', args: { resume_id: 'cv', answers: [], submit_selector: '#send', ...extra } });
async function scenario(name: string, decisions: Decision[], html = '<label>Name<input value="Fixture Candidate"></label>'): Promise<PreparedApplication> {
  const context = await browser.newContext();
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<main><form onsubmit="event.preventDefault();window.sent++">${html}<button id=send>Submit application</button></form></main>` }));
  const page = await context.newPage(); await page.goto(`https://documents.fixture.invalid/${name}`);
  await page.evaluate('window.sent=0', undefined, undefined, false);
  const readiness = createReadinessFixtureReply(); let sequence = 0;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)), checkpoint = readiness(body);
    if (checkpoint) return checkpoint;
    const specialist = specialistFixtureReply(body); if (specialist) return specialist;
    const decision = decisions.shift(); assert.ok(decision, `Unexpected extra model call in ${name}`);
    const calls = await decision(body, page);
    return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: calls.map(call => ({
      id: `${name}-${++sequence}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) },
    })) } }] });
  }) as typeof fetch;
  try {
    const result = await runAgentOnlyApplication({ page, job: { id: name, title: 'Fictional analyst', company: 'Fixture Employer',
      location: 'Sydney', platform: 'workday', url: page.url() }, profile: { name: 'Fixture Candidate', email: 'fixture@example.invalid', skills: [] } as never, log: () => {} });
    assert.equal(result.outcome.status, 'prepared', JSON.stringify(result.outcome));
    assert.equal(await page.evaluate('window.sent', undefined, undefined, false), 0, 'preparation never submits');
    assert.equal(decisions.length, 0);
    return (result.outcome as { status: 'prepared'; draft: PreparedApplication }).draft;
  } finally { await context.close(); }
}
try {
  const preserved = await scenario('saved-letter', [
    () => [{ name: 'save_progress', args: { note: 'Verified saved letter.', cover_letter: letter } }],
    () => [prepare()],
  ]);
  assert.equal(preserved.coverLetter, letter, 'prepare omission retains exact save_progress letter');
  const legacy = await scenario('no-letter', [() => [prepare()]]);
  assert.equal(legacy.coverLetter, undefined); assert.equal(legacy.documents, undefined);

  const attached = await scenario('owner-letter', [
    () => [{ name: 'browser_batch', args: { actions: [
      { action: 'set_input_files', selector: '#cv', file_ids: ['cv'] },
      { action: 'set_input_files', selector: '#letter', file_ids: ['supporting:10'] },
    ] } }],
    () => [prepare()],
    body => {
      assert.match(JSON.stringify(body.messages.at(-1)), /Declare every attached non-resume file/);
      return [prepare({ cover_letter_file_id: 'supporting:10' })];
    },
  ], '<label>Resume<input type=file id=cv></label><label>Additional file<input type=file id=letter></label>');
  assert.equal(attached.coverLetter, letter, 'readable cover text comes from exact owner file, not model retyping or filename');
  assert.equal(attached.documents?.[0].fileId, 'supporting:10');
  assert.equal(readFileSync(verifiedDocumentPath(attached.documents![0]), 'utf8'), letter);
  assert.notEqual(applicationRevision({ ...attached, documents: undefined }), attached.revision, 'attachment bytes and provenance bind consent');
  assert.equal(applicationRevision({ ...attached, documents: attached.documents!.map(document => Object.fromEntries(Object.entries(document).reverse()) as unknown as typeof document) }), attached.revision,
    'JSONB object-key reordering cannot change immutable document content revision');
  assert.throws(() => withCoverLetter(attached, 'Changed candidate letter'), /attached-letter revision operation/);
  assert.deepEqual(withCoverLetter(attached, letter).documents, attached.documents);
  const editedLetter = letter.replace('Exact supplied', 'Candidate revised');
  const edited = await reviseAttachedCoverLetter(attached, editedLetter, directory);
  assert.equal(edited.coverLetter, editedLetter);
  assert.equal(readFileSync(verifiedDocumentPath(edited.documents![0]), 'utf8'), editedLetter);
  assert.equal(readFileSync(verifiedDocumentPath(attached.documents![0]), 'utf8'), letter, 'candidate edit retains original attachment bytes');
  assert.notEqual(edited.revision, attached.revision);
  assert.equal(edited.documents![0].provenance, 'text');
  const editedFiles = new AgentFiles('edited-approval', edited);
  assert.deepEqual(await editedFiles.reviewDocuments('cv', undefined, undefined),edited.documents,'approved revised letters do not require native-upload proof');
  assert.equal(await editedFiles.reviewDocuments('cv',edited.documents![0].fileId,undefined),undefined,'declaring an approved letter without an upload does not fabricate a delivered artifact');
  assert.deepEqual(editedFiles.checkpointUploads(),[]);
  const supportingApproval={...edited,documents:edited.documents!.map(document=>({...document,role:'supporting' as const}))};
  await assert.rejects(new AgentFiles('supporting-approval',supportingApproval).reviewDocuments('cv',undefined,undefined),/candidate-revised attachment has not been uploaded/,'supporting documents retain their existing upload requirement');
  editedFiles.recordUpload('employer-letter-input', editedFiles.uploadSelection([edited.documents![0].fileId]));
  assert.equal((await editedFiles.reviewDocuments('cv', undefined, undefined))?.[0].sha256, edited.documents![0].sha256,
    'an actual upload still records the exact candidate-revised bytes');
  assert.equal(new AgentFiles('edited-approval', edited).resolve(edited.documents![0].fileId).text, editedLetter);
  const anotherOwner = mkdtempSync(join(tmpdir(), 'owtomate-other-document-owner-'));
  try { await assert.rejects(reviseAttachedCoverLetter(attached, editedLetter, anotherOwner), /artifact is unavailable/); }
  finally { rmSync(anotherOwner, { recursive: true, force: true }); }
  const uppercaseSource = join(directory, 'UPPERCASE.TXT'); writeFileSync(uppercaseSource, letter);
  const uppercase = preserveDocument(uppercaseSource, directory, 'UPPERCASE.TXT');
  const upperDraft = { ...attached, documents: [{ ...attached.documents![0], name: uppercase.name, sha256: uppercase.sha256, bytes: uppercase.bytes }] };
  const upperEdit = await reviseAttachedCoverLetter(upperDraft, editedLetter, directory);
  assert.equal(upperEdit.documents![0].name, 'UPPERCASE.TXT');
  assert.equal(readFileSync(verifiedDocumentPath(upperEdit.documents![0]), 'utf8'), editedLetter);

  let generatedId = '';
  const generated = await scenario('generated-letter', [
    () => [{ name: 'create_file', args: { name: 'Plain document.txt', text: letter, format: 'txt' } }],
    body => { generatedId = JSON.parse(body.messages.filter((message: any) => message.role === 'tool').at(-1).content).file_id; return [{ name: 'browser_action', args: { action: 'set_input_files', selector: '#letter', file_ids: [generatedId] } }]; },
    () => [prepare({ cover_letter_file_id: generatedId })],
  ], '<label>Additional file<input type=file id=letter></label>');
  assert.equal(generated.coverLetter, letter); assert.equal(generated.documents?.[0].fileId, generatedId);
  assert.equal(applicationRevision({ ...generated, documents: undefined }), generated.revision, 'exact source-text approval permits derived rendering without hash-only consent loops');
  const wizard = await scenario('same-layout-wizard', [
    () => [{ name: 'browser_action', args: { action: 'set_input_files', selector: '#attachment', file_ids: ['supporting:10'] } }],
    () => [{ name: 'browser_action', args: { action: 'click', selector: '#next', sends_application: false } }],
    () => [{ name: 'browser_action', args: { action: 'set_input_files', selector: '#attachment', file_ids: ['supporting:11'] } }],
    () => [prepare({ cover_letter_file_id: 'supporting:10', supporting_file_ids: ['supporting:11'] })],
  ], '<label>Document<input type=file id=attachment></label><button id=next type=button onclick="document.querySelector(\'#attachment\').replaceWith(document.querySelector(\'#attachment\').cloneNode());this.remove()">Next</button>');
  assert.equal(wizard.documents?.length, 2, 'same-layout new wizard input must not erase a previous stored upload');
  const remounted = await scenario('explicit-remount-replacement', [
    () => [{ name: 'browser_action', args: { action: 'set_input_files', selector: '#document', file_ids: ['supporting:10'] } }],
    () => [{ name: 'browser_action', args: { action: 'set_input_files', selector: '#document', file_ids: ['supporting:11'], replaces_file_ids: ['supporting:10'] } }],
    () => [prepare({ cover_letter_file_id: 'supporting:11' })],
  ], '<label>Document<input type=file id=document onchange="this.replaceWith(this.cloneNode())"></label>');
  assert.deepEqual(remounted.documents?.map(document => document.fileId), ['supporting:11']);
  const shifted = await scenario('same-node-sibling-shift', [
    () => [{ name: 'browser_action', args: { action: 'set_input_files', selector: '#attachment', file_ids: ['supporting:10'] } }],
    () => [{ name: 'browser_action', args: { action: 'set_input_files', selector: '#attachment', file_ids: ['supporting:11'] } }],
    () => [prepare({ cover_letter_file_id: 'supporting:11' })],
  ], '<label>Document<input type=file id=attachment onchange="this.closest(\'form\').prepend(document.createElement(\'hr\'))"></label>');
  assert.deepEqual(shifted.documents?.map(document => document.fileId), ['supporting:11'], 'sibling insertion must not turn replacement of the same native input into two attachments');
  const rejected = await scenario('unknown-retirement-before-event', [
    () => [{ name: 'browser_action', args: { action: 'set_input_files', selector: '#attachment', file_ids: ['supporting:10'] } }],
    () => [{ name: 'browser_action', args: { action: 'set_input_files', selector: '#attachment', file_ids: ['supporting:11'], replaces_file_ids: ['supporting:foreign'] } }],
    async (body, page) => {
      assert.equal(await page.evaluate('window.fileEvents', undefined, undefined, false), 1, 'foreign retirement fails before any native change event');
      assert.match(JSON.stringify(body.messages), /Only exact files previously uploaded/);
      return [{ name: 'browser_action', args: { action: 'set_input_files', selector: '#attachment', file_ids: ['supporting:11'], replaces_file_ids: ['supporting:10'] } }];
    },
    () => [prepare({ cover_letter_file_id: 'supporting:11' })],
  ], '<label>Document<input type=file id=attachment onchange="window.fileEvents=(window.fileEvents||0)+1"></label>');
  assert.deepEqual(rejected.documents?.map(document => document.fileId), ['supporting:11']);
  const replacement = new AgentFiles('replacement-events');
  const firstSelected = replacement.uploadSelection(['supporting:10']); replacement.recordUpload('old-node', firstSelected);
  const beforeInvalid = replacement.checkpointUploads();
  assert.throws(() => replacement.validateReplacements(['supporting:foreign']), /Only exact files previously uploaded/);
  assert.throws(() => replacement.validateReplacements(['supporting:10', 'supporting:10']), /unique array/);
  assert.deepEqual(replacement.checkpointUploads(), beforeInvalid, 'unknown/foreign retirement fails before transport changes');
  const failedPage = await browser.newPage(); await failedPage.setContent('<div id=not-file></div>');
  replacement.validateReplacements(['supporting:10']);
  await assert.rejects(failedPage.locator('#not-file').setInputFiles(replacement.uploadSelection(['supporting:11']).map(file => file.path)), /not an HTMLInputElement|not.*input/i);
  assert.deepEqual(replacement.checkpointUploads(), beforeInvalid, 'failed native upload cannot retire previously completed work');
  await failedPage.close();
  replacement.recordUpload('new-node', replacement.uploadSelection(['supporting:11']), ['supporting:10']);
  const history = replacement.checkpointUploads();
  assert.equal(history.find(upload => upload.target === 'old-node')?.events?.[0].selected[0].id, 'supporting:10', 'retirement never deletes original selected bytes/history');
  assert.deepEqual(history.find(upload => upload.target === 'new-node')?.events?.[0].retiredFileIds, ['supporting:10']);
  const legacyTextApproval = { ...legacy, coverLetter: letter };
  legacyTextApproval.revision = applicationRevision(legacyTextApproval);
  const legacyTextFiles = new AgentFiles('legacy-text-render', legacyTextApproval);
  const legacyRendered = await legacyTextFiles.createApprovedLetter('Authorized letter', 'txt');
  legacyTextFiles.recordUpload('letter-input', legacyTextFiles.uploadSelection([legacyRendered.file_id]));
  const legacyTextDocuments = await legacyTextFiles.reviewDocuments('cv', undefined, undefined);
  assert.equal(legacyTextDocuments?.[0].text, letter);
  assert.equal(applicationRevision({ ...legacyTextApproval, documents: legacyTextDocuments }), legacyTextApproval.revision,
    'rendering the exact legacy approved letter does not create a new approval loop');

  process.env.APPLICATION_REVIEW_MODE = 'approved';
  const legacyInline = { ...legacy, job: { ...legacy.job, id: 'legacy-inline', url: 'https://documents.fixture.invalid/legacy-inline' },
    formUrl: 'https://documents.fixture.invalid/legacy-inline', coverLetter: undefined,
    answers: [{ question: 'Write a cover letter', answer: letter }] };
  legacyInline.revision = applicationRevision(legacyInline);
  writeFileSync(join(directory, 'approved-applications.json'), JSON.stringify([legacyInline]));
  const inlinePage = await browser.newPage(); await inlinePage.goto('about:blank');
  await inlinePage.setContent('<label>Write a cover letter<textarea id=letter></textarea></label><button>Submit</button>');
  await inlinePage.locator('textarea').fill(letter);
  const { applicationApprovalGate } = await import('../application-review.js');
  const inlineContext = { page: inlinePage, job: legacyInline.job, profile: {} as never, observation: { url: inlinePage.url(), title: '', actions: [], fields: [], text: '' },
    captured: legacyInline.answers, resumeUsed: 'cv', resumeName: 'CV.txt', actions: [], log: () => {} };
  // Use the same canonical form as the stored legacy fixture; only the current
  // typed control proves that this revision-bound answer is the letter body.
  legacyInline.formUrl = inlinePage.url(); legacyInline.revision = applicationRevision(legacyInline);
  writeFileSync(join(directory, 'approved-applications.json'), JSON.stringify([legacyInline]));
  assert.equal(await applicationApprovalGate(inlineContext), null, 'legacy approved full-text answer is witnessed by textarea without rewriting history or forcing new approval');
  const { observedApprovedCoverLetter } = await import('../application-letter.js');
  assert.equal(observedApprovedCoverLetter(legacyInline, [{ ref: 'file', label: 'Write a cover letter', kind: 'text', inputType: 'file', currentValue: letter, required: false }]), undefined);
  assert.equal(observedApprovedCoverLetter(legacyInline, [{ ref: 'text', label: 'Write a cover letter', kind: 'textarea', currentValue: 'Different letter', required: false }]), undefined);
  const witnessedFiles = new AgentFiles('legacy-witness-recovery', legacyInline);
  witnessedFiles.witnessApprovedLetter([{ ref: 'text', label: 'Write a cover letter', kind: 'textarea', currentValue: letter, required: false }]);
  const witnessedArtifact = await witnessedFiles.createApprovedLetter('Observed letter', 'txt');
  const restoredWitness = new AgentFiles('legacy-witness-recovery', legacyInline);
  restoredWitness.witnessApprovedLetter(witnessedFiles.checkpointLetterWitness() ?? []);
  restoredWitness.restore(witnessedFiles.checkpoint());
  assert.equal(readFileSync(restoredWitness.resolve(witnessedArtifact.file_id).path, 'utf8'), letter, 'owner-scoped typed source evidence survives tool recovery without mutating the legacy approval');
  const { PDFDocument } = await import('pdf-lib');
  const { documentHash } = await import('../application-documents.js');
  const renderPdf = async (path: string) => { const pdf = await PDFDocument.create(); pdf.addPage().drawText(readFileSync(path, 'utf8')); const output = path + '.pdf'; writeFileSync(output, await pdf.save()); return output; };
  const deliveryApproval = { ...edited, formUrl: inlinePage.url(), answers: [], resumeHash: documentHash(readFileSync(join(directory, 'resumes', 'CV.txt'))) };
  deliveryApproval.revision = applicationRevision(deliveryApproval);
  const bundleFiles = new AgentFiles('edited-letter-bundle', deliveryApproval, renderPdf as never);
  const combined = await bundleFiles.combineApprovedDocuments();
  bundleFiles.recordUpload('combined-input', bundleFiles.uploadSelection([combined.file_id]));
  assert.equal((await bundleFiles.reviewDocuments('cv', undefined, undefined))?.[0].text, editedLetter,
    'an exact approved text-derived bundle fulfils edited-letter delivery without a format-only approval loop');
  writeFileSync(join(directory, 'approved-applications.json'), JSON.stringify([deliveryApproval]));
  await inlinePage.setContent('<button>Submit</button>');
  const deliveryContext = { ...inlineContext, job: deliveryApproval.job, captured: [], coverLetter: editedLetter, documents: deliveryApproval.documents };
  const missingDelivery = await applicationApprovalGate(deliveryContext);
  assert.equal(missingDelivery,null,'approved revised letters do not require a final-send upload-proof gate');
  writeFileSync(join(directory,'approved-applications.json'),JSON.stringify([{...deliveryApproval,documents:supportingApproval.documents}]));
  const missingSupporting=await applicationApprovalGate({...deliveryContext,documents:supportingApproval.documents});
  assert.ok(missingSupporting?.kind==='ok'&&missingSupporting.disposition==='failed','the final-send exemption applies only to approved cover letters');
  writeFileSync(join(directory,'approved-applications.json'),JSON.stringify([deliveryApproval]));
  const delivered = bundleFiles.checkpointUploads().flatMap(upload => upload.files.map(file => ({ fileId: file.id, sha256: file.sha256, coverLetterDigest: file.coverLetterDigest })));
  assert.equal(await applicationApprovalGate({ ...deliveryContext, uploadedDocuments: delivered }), null);
  const wrongDelivery = await applicationApprovalGate({ ...deliveryContext, uploadedDocuments: delivered.map(file => ({ ...file, coverLetterDigest: 'wrong' })) });
  assert.equal(wrongDelivery,null,'a delivery digest is no longer a submission condition for approved letters');
  writeFileSync(join(directory, 'approved-applications.json'), JSON.stringify([legacyInline]));
  assert.equal(JSON.parse(readFileSync(join(directory, 'approved-applications.json'), 'utf8'))[0].coverLetter, undefined, 'legacy source history remains unchanged');
  await inlinePage.close(); process.env.APPLICATION_REVIEW_MODE = 'prepare';

  const originalLetter = 'Dear team,\n\nOriginal uploaded letter \u2014 preserve its exact bytes.\n\nFixture';
  const opaqueSource = join(directory, 'Opaque.txt'); writeFileSync(opaqueSource, originalLetter);
  const opaque = preserveDocument(opaqueSource);
  const opaquePage = await browser.newPage(); await opaquePage.setContent('<button>Submit</button>');
  const opaqueContext = { ...inlineContext, page: opaquePage, captured: [], coverLetter: originalLetter,
    documents: [{ role: 'cover-letter' as const, provenance: 'file' as const, fileId: 'supporting:opaque', name: opaque.name,
      sha256: opaque.sha256, bytes: opaque.bytes, text: originalLetter }] };
  const opaqueResult = await applicationApprovalGate(opaqueContext);
  assert.ok(opaqueResult?.kind === 'terminal' && opaqueResult.outcome.status === 'prepared');
  assert.equal(opaqueResult.outcome.draft.coverLetter, originalLetter, 'original opaque source punctuation is not rewritten or permanently vetoed');
  const writtenResult = await applicationApprovalGate({ ...opaqueContext, documents: undefined });
  assert.ok(writtenResult?.kind === 'ok' && writtenResult.disposition === 'failed', 'generated/text writing still follows punctuation validation');
  await opaquePage.close();

  // A local recovery/restart retains successful byte selections, including
  // browser widgets that consume and immediately clear native FileList values.
  const transport = new AgentFiles('restart');
  const upload = transport.uploadSelection(['supporting:10']); transport.recordUpload('actual-input', upload);
  const retained = transport.checkpointUploads();
  writeFileSync(join(directory, 'knowledge', 'Neutral-name.txt'), 'Different bytes at the same filename.');
  const recovered = new AgentFiles('restart'); recovered.restoreUploads(retained);
  const recoveredDocuments = await recovered.reviewDocuments('cv', 'supporting:10', undefined);
  assert.equal(recoveredDocuments?.[0].text, letter, 'same filename changed source cannot replace previously uploaded bytes');
  assert.equal(recoveredDocuments?.[0].sha256, attached.documents?.[0].sha256);
  const confirmed = new AgentFiles('restart', { ...attached, documents: recoveredDocuments });
  assert.equal(readFileSync(confirmed.resolve('supporting:10').path, 'utf8'), letter, 'confirmed retry uses immutable byte snapshot');
  assert.throws(() => confirmed.resolve('supporting:11'), /candidate-approved/);
  assert.throws(() => confirmed.resolve('supporting:../foreign-owner'), /file ID/);
  const rematerialized = await confirmed.createApprovedLetter('Requested filename', 'txt');
  assert.equal(readFileSync(confirmed.resolve(rematerialized.file_id).path, 'utf8'), letter);
  rmSync(join(directory, 'knowledge', 'Neutral-name.txt'));
  assert.equal(readFileSync(new AgentFiles('restart', attached).resolve('supporting:10').path, 'utf8'), letter, 'removed original remains recoverable by exact approved immutable snapshot');
  const removing = new AgentFiles('removal', attached);
  removing.recordUpload('actual-input', removing.uploadSelection(['supporting:10']));
  removing.recordUpload('actual-input', []);
  assert.deepEqual(await removing.reviewDocuments('cv', undefined, undefined),attached.documents,'approved letter absence does not block preparation after clearing a file input');
  const restoredRemoval = new AgentFiles('removal', attached); restoredRemoval.restoreUploads(removing.checkpointUploads());
  assert.deepEqual(await restoredRemoval.reviewDocuments('cv', undefined, undefined),attached.documents,'the exemption persists across recovery without inventing another upload');
  const removedBeforePrepare = new AgentFiles('new-removal');
  removedBeforePrepare.restoreUploads(retained); removedBeforePrepare.recordUpload('actual-input', []);
  assert.equal(await removedBeforePrepare.reviewDocuments('cv', undefined, undefined), undefined);
  await assert.rejects(removedBeforePrepare.reviewDocuments('cv', 'supporting:10', undefined), /no unambiguous successful native upload/);
  const extra = new AgentFiles('extra-attachment'); extra.recordUpload('second-input', extra.uploadSelection(['supporting:11']));
  await assert.rejects(extra.reviewDocuments('cv', undefined, undefined), /Declare every attached/);
  assert.equal((await extra.reviewDocuments('cv', undefined, ['supporting:11']))?.[0].role, 'supporting');
  const originalBytes = readFileSync(verifiedDocumentPath(attached.documents![0]));
  chmodSync(verifiedDocumentPath(attached.documents![0]), 0o600);
  writeFileSync(verifiedDocumentPath(attached.documents![0]), 'Tampered artifact');
  assert.throws(() => new AgentFiles('tamper', attached).resolve('supporting:10'), /bytes have changed/);
  writeFileSync(join(directory, 'application-document-artifacts', attached.documents![0].sha256, attached.documents![0].name), originalBytes);
  console.log('PASS: browser letter omission, explicit owner/generated file binding, non-resume declaration, immutable revision, restart, changed same-name bytes, removed source, clear history, extra/foreign files and artifact tampering. No live applications or AI requests.');
} finally {
  globalThis.fetch = originalFetch; await browser.close(); rmSync(directory, { recursive: true, force: true });
}
