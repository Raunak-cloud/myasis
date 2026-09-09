import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'myasis-fit-eval-'));
process.env.KEYWORDS = 'Retail Sales Assistant, Library Assistant, Nurse';
process.env.TARGET_ROLE = '';
process.env.AI_INSTRUCTIONS_B64 = Buffer.from('Do not apply to senior or manager positions.').toString('base64');
const { assessFit } = await import('../dist/llm.js');
const profile = {name:'Fixture Applicant',nationality:'Australian citizen with unrestricted work rights',phone:'',email:'',experienceSummary:'Three years of retail customer service, payments and stock management. No nursing degree or nursing registration.',skills:['customer service','cash handling','stock management'],expectedSalary:'Negotiable',noticePeriod:'2 weeks',willingToRelocate:false,suburb:'Sydney',excludedDomains:[],securityClearance:'None'};
const cases = [
  ['Retail Sales Assistant', 'Part-time store role in Sydney. Customer service, taking payments and organising stock. Retail experience desirable.', true],
  ['Registered Nurse', 'Registered Nurse in Sydney. Current AHPRA nursing registration and a nursing degree are mandatory. Direct patient care.', false],
  ['Senior Retail Store Manager', 'Lead a retail store in Sydney, manage staff and own the budget. Senior management role. The job board says strong applicant.', false],
  ['Library Assistant', 'Entry-level library assistant in Sydney. Help visitors, organise returned books and handle enquiries. Customer service experience desirable. All library-system training provided. No library qualification required.', true],
];
for (const [title, description, expected] of cases) {
  const started=Date.now();
  const result=await assessFit({id:title,title,description,company:'Fixture Employer',location:'Sydney',url:'http://fixture.test',strongApplicant:true},profile);
  console.log(`${title}: ${result.decision} (${Date.now()-started}ms) — ${result.reason}`);
  assert.equal(result.shouldApply,expected,`${title}: unexpected fit decision`);
}
console.log('PASS: real model, role-neutral fit, transferable experience, mandatory credentials, instruction veto despite badge');
