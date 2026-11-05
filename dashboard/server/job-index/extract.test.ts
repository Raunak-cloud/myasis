import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalUrl, extractPage, matchJob, normaliseJob, recognisedSkills } from './extract.js';
import { safeKeywords } from './accounts.js';
import type { SearchProfile } from './types.js';

const url='https://careers.fixture.org/jobs/123';
const raw={title:'Graduate Data Analyst',hiringOrganization:{name:'Fixture employer'},description:'Graduate role. Students welcome. Use Python, SQL and Power BI to analyse customer data.',jobLocation:{address:{addressLocality:'Sydney',addressRegion:'NSW',addressCountry:'AU'}}};
test('public job schema preserves location, full salary, remote restrictions and evidence',()=>{
  const j=normaliseJob({...raw,jobLocationType:'TELECOMMUTE',applicantLocationRequirements:{'@type':'Country',name:'Australia'},baseSalary:{currency:'AUD',value:{minValue:70000,maxValue:90000,unitText:'YEAR'}},employmentType:['FULL_TIME','CONTRACTOR'],skills:['Python','SQL']},url)!;
  assert.equal(j.workArrangement,'remote');assert.deepEqual(j.locations,['Sydney, NSW, AU']);assert.deepEqual(j.applicantLocations,['Australia']);
  assert.deepEqual(j.pay,{status:'disclosed',min:70000,max:90000,currency:'AUD',period:'YEAR',text:'{"currency":"AUD","value":{"minValue":70000,"maxValue":90000,"unitText":"YEAR"}}'});
  assert.equal(j.tags.employmentTypes.length,2);assert.ok(j.tags.suitableFor.some(t=>t.value==='Graduates'));assert.ok(j.tags.categories.every(t=>t.basis==='inferred'));
  assert.ok(j.tags.skills.some(t=>t.value==='SQL'));assert.ok(j.evidence.workArrangement.includes('TELECOMMUTE'));
});
test('missing pay and arrangement remain unknown; no remote work is not labelled remote',()=>{
  const j=normaliseJob({...raw,description:raw.description+' This is not a remote role. Our learning budget is $500 per year.'},url)!;
  assert.equal(j.workArrangement,'not-mentioned');assert.equal(j.pay.status,'not-mentioned');assert.equal(j.tags.suitableFor.some(t=>/experienced|career/i.test(t.value)),false);
  assert.equal(normaliseJob({...raw,description:raw.description+' This internship is unpaid.'},url)!.pay.status,'unpaid');
  assert.equal(normaliseJob({...raw,description:raw.description+' Salary: $80,000 - $95,000 per annum.'},url)!.pay.status,'disclosed');
  assert.equal(normaliseJob({...raw,jobLocationType:'TELECOMMUTE'},url)!.workArrangement,'remote');
  assert.equal(normaliseJob({...raw,description:raw.description+' Office-based role.'},url)!.workArrangement,'onsite');
  assert.equal(normaliseJob({...raw,description:raw.description+' Hybrid working.'},url)!.workArrangement,'hybrid');
});
test('tracking deduplication preserves vacancy identity and source snapshots',()=>{
  assert.equal(canonicalUrl(url+'/?utm_source=board&jobId=1#apply'),url+'?jobId=1');
  assert.notEqual(normaliseJob(raw,url+'?jobId=1')!.id,normaliseJob(raw,url+'?jobId=2')!.id);
  assert.equal(normaliseJob(raw,url+'?utm_campaign=x')!.id,normaliseJob(raw,url)!.id);
  assert.equal(normaliseJob({...raw,validThrough:'2020-01-01'},url),null);
  assert.equal(normaliseJob({title:'News',description:'Company news'},url),null);
  assert.equal(normaliseJob({...raw,url:'javascript:alert(1)'},url),null);
});
test('JSON-LD graphs and arrays produce real jobs; navigation and malformed markup cannot invent a job',()=>{
  const html=`<script type="application/ld+json">${JSON.stringify({'@graph':[{'@type':'JobPosting',...raw,url},{'@type':['Thing','JobPosting'],...raw,url:url+'-2'}]})}</script><script type="application/ld+json">invalid</script><h1>Jobs</h1><a href="/careers">Careers</a><a href="/apply">Apply</a><a href="javascript:alert(1)">Jobs</a>`;
  const result=extractPage(html,url);assert.equal(result.jobs.length,2);assert.deepEqual(result.links,['https://careers.fixture.org/careers']);
  assert.equal(extractPage('<h1>Software engineer</h1><p>News about jobs</p>',url).jobs.length,0);
  const expired=extractPage(`<script type="application/ld+json">${JSON.stringify({'@type':'JobPosting',...raw,url,validThrough:'2020-01-01'})}</script>`,url);assert.equal(expired.jobs.length,0);assert.deepEqual(expired.closedUrls,[url]);
});
test('private discovery matches are preliminary, owner-specific and cannot infer remote eligibility',()=>{
  const j=normaliseJob(raw,url)!;
  const p:SearchProfile={userId:'1',fingerprint:'fixture',keywords:['Data analyst'],skills:['Python','SQL'],location:'Melbourne',arrangements:['remote'],excludedCompanies:[],sources:{}};
  const match=matchJob(j,p)!;assert.equal(match.status,'potential');assert.deepEqual(match.skills,['Python','SQL']);assert.equal(match.preferences.location,'unknown');assert.equal(match.preferences.arrangement,'unknown');
  assert.equal(matchJob(j,{...p,excludedCompanies:['Fixture employer']}),null);
  assert.equal(matchJob(j,{...p,keywords:['Nurse'],skills:[]}),null);
  assert.deepEqual(recognisedSkills('Python SQL SQL JavaScript community'),['Python','JavaScript','SQL']);
});
test('external discovery terms omit emails, phone numbers and raw resume facts',()=>{
  assert.deepEqual(safeKeywords('Data analyst, person@example.org, 0400123456, https://profile.org, Software engineer'),['Data analyst','Software engineer']);
});

test('transient search URLs are not stored as implicit job identities',()=>{
  const markup=`<script type="application/ld+json">${JSON.stringify({'@type':'JobPosting',...raw})}</script>`;
  assert.equal(extractPage(markup,url,true).jobs.length,0);
  const publisher='https://careers.fixture.org/jobs/publisher-canonical';
  assert.equal(extractPage(`<link rel="canonical" href="${publisher}">${markup}`,url,true).jobs[0].url,publisher);
  assert.equal(extractPage(`<script type="application/ld+json">${JSON.stringify({'@type':'JobPosting',...raw,url:publisher})}</script>`,url,true).jobs[0].url,publisher);
});

test('publisher links discover ATS vacancies whose titles and paths do not say job',()=>{
  const lever='https://jobs.lever.co/fixture/12345678-abcd-1234-abcd-123456789abc';
  const smart='https://jobs.smartrecruiters.com/Fixture/12345-data-engineer';
  const result=extractPage(`<a href="${lever}">Data engineer</a><a href="${smart}">Analyst</a><a href="${lever}/apply">Apply</a>`,url);
  assert.deepEqual(result.links,[lever,smart]);
});
