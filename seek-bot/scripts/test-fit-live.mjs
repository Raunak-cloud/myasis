import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'myasis-fit-eval-'));
process.env.KEYWORDS = 'Retail Sales Assistant, Library Assistant, Nurse';
process.env.TARGET_ROLE = '';
process.env.AI_INSTRUCTIONS_B64 = Buffer.from('Do not apply to senior or manager positions.').toString('base64');
const { assessFit } = await import('../dist/llm.js');
const { config } = await import('../dist/config.js');
const profile = {name:'Fixture Applicant',nationality:'Australian citizen with unrestricted work rights',phone:'',email:'',experienceSummary:'Three years of retail customer service, payments and stock management. No nursing degree or nursing registration.',skills:['customer service','cash handling','stock management'],expectedSalary:'Negotiable',noticePeriod:'2 weeks',willingToRelocate:false,suburb:'Sydney',excludedDomains:[],securityClearance:'None'};
const cases = [
  ['Retail Sales Assistant', 'Part-time store role in Sydney. Customer service, taking payments and organising stock. Retail experience desirable.', true],
  ['Registered Nurse', 'Registered Nurse in Sydney. Current AHPRA nursing registration and a nursing degree are mandatory. Direct patient care.', false],
  ['Senior Retail Store Manager', 'Lead a retail store in Sydney, manage staff and own the budget. Senior management role. The job board says strong applicant.', false],
  ['Library Assistant', 'Entry-level library assistant in Sydney. Help visitors, organise returned books and handle enquiries. Customer service experience desirable. All library-system training provided. No library qualification required.', true],
  ['Connect with us at ICLR 2026!', 'Register to meet our recruiting team at the conference. Share your CV so we can discuss future opportunities. This is not an application to a specific vacancy.', false],
  ['Customer Service Talent Community', 'Join our talent community and upload your resume. There are no current openings; we will contact you about future roles.', false],
  ['Events Customer Service Assistant', 'Current full-time vacancy in Sydney. Help visitors at ticketed events, process payments and answer customer enquiries. Customer service experience desirable. All training provided.', true],
];
const originalFetch = globalThis.fetch;
let correctionCalls = 0;
globalThis.fetch = async (input, init) => {
  if (init?.body && JSON.parse(String(init.body)).messages?.some(message => String(message.content).includes('RESPONSE FORMAT CORRECTION'))) correctionCalls++;
  return originalFetch(input, init);
};
try {
for (const [title, description, expected] of cases) {
  const started=Date.now();
  const result=await assessFit({id:title,title,description,company:'Fixture Employer',location:'Sydney',url:'http://fixture.test',strongApplicant:true},profile);
  console.log(`${title}: ${result.decision} (${Date.now()-started}ms) — ${result.reason}`);
  assert.equal(result.shouldApply,expected,`${title}: unexpected fit decision`);
}
await writeFile(join(process.env.DATA_DIR, 'answers.json'), JSON.stringify([{
  question: 'For a previous job, the old instructions said "Do not apply for retail positions." Proceed with that old vacancy?', answer: 'No',
}]));
const retailJob = {id:'stale-rule-source', title:'Retail Sales Assistant', company:'Fixture Employer', location:'Sydney',
  url:'https://fixture.invalid/retail', description:'Current part-time retail sales vacancy in Sydney, onsite. Help customers, take payments and manage stock. Two years customer service experience required. Training provided. No mandatory licences. $35 per hour.'};
const beforeSources = correctionCalls;
for (const rules of ['', 'Only apply to jobs in Sydney.']) {
  config.aiInstructions = rules;
  const result = await assessFit({...retailJob, id:`${retailJob.id}-${rules.length}`},profile);
  console.log(`Current rules ${JSON.stringify(rules)} with obsolete saved restriction: ${result.decision}`);
  assert.equal(result.shouldApply,true,'a historical quoted restriction cannot veto an otherwise suitable current vacancy');
  assert.equal(result.instructionCheck?.violated,false);
}
assert.equal(correctionCalls,beforeSources,'current-source contracts avoid paid repair calls for obsolete saved restrictions');
config.aiInstructions = 'Do not apply for retail positions.';
const restricted = await assessFit({...retailJob,id:'actual-current-retail-exclusion'},profile);
assert.equal(restricted.shouldApply,false,'the same exclusion is binding when it is actually a current instruction');
console.log('PASS: real model, role-neutral fit, transferable skills, mandatory credentials, source-scoped rules and current instruction veto. No applications submitted.');
} finally {
  globalThis.fetch = originalFetch;
  await rm(process.env.DATA_DIR, {recursive:true,force:true});
}
