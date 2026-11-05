import assert from 'node:assert/strict';
import {test} from 'node:test';
import {australianEligibility,declaredCountries} from './geography.js';
import {normaliseJob,matchJob} from './extract.js';
import {fromFeed} from './engine.js';
import {minimaxReviewer} from './review.js';
import type {JobIndexStore} from './store.js';

const raw={title:'Data engineer',hiringOrganization:{name:'Fixture'},description:'Build reliable Python and SQL data systems for our international customers in Australia.'};
const url='https://careers.fixture.org/jobs/1';
const profile={userId:'1',fingerprint:'test',keywords:['Data engineer'],skills:['Python','SQL'],location:'Sydney',arrangements:[],excludedCompanies:[],sources:{}};
test('Australia is a country requirement, not a keyword, domain, salary or AI inference',()=>{
  for(const changes of [{},{jobLocation:'Remote'},{jobLocation:'APAC'},{jobLocation:'Sydney'},{jobLocation:{name:'Melbourne',address:{addressCountry:'US'}}},{jobLocation:'Vietnam',jobLocationType:'TELECOMMUTE',applicantLocationRequirements:{'@type':'Country',name:'Vietnam'}},{jobLocation:'Australia',jobLocationType:'TELECOMMUTE',applicantLocationRequirements:{'@type':'Country',name:'VN'}},{jobLocation:'Australia',applicantLocationRequirements:'United States only'},{jobLocation:'Not Australia'}]){
    const j=normaliseJob({...raw,...changes},url)!;
    assert.notEqual(australianEligibility(j).status,'eligible',JSON.stringify(changes));assert.equal(matchJob(j,profile),null);
  }
});
test('structured ISO country codes/names, hierarchy, multiple locations and remote residence are preserved',()=>{
  for(const c of ['AU','au','AUS','Australia',{'@type':'Country',name:'Australia'}]){
    const j=normaliseJob({...raw,jobLocation:{address:{addressCountry:c}}},url)!;
    assert.equal(australianEligibility(j).status,'eligible');assert.ok(matchJob(j,profile));
  }
  assert.deepEqual(declaredCountries({'@type':'State',name:'New South Wales',containedInPlace:{'@type':'Country',name:'Australia'}}),['Australia']);
  const remote=normaliseJob({...raw,jobLocation:{address:{addressCountry:'US'}},jobLocationType:'TELECOMMUTE',applicantLocationRequirements:[{'@type':'Country',name:'US'},{'@type':'Country',name:'AU'}]},url)!;
  assert.equal(australianEligibility(remote).status,'eligible');
  assert.equal(australianEligibility({...remote,workArrangement:'onsite'}).status,'excluded');
  const multi=normaliseJob({...raw,jobLocation:[{address:{addressCountry:'US'}},{address:{addressCountry:'AU'}}]},url)!;
  assert.equal(australianEligibility(multi).status,'eligible');
  const legacy={locations:['Sydney, Australia'],applicantLocations:[],workArrangement:'not-mentioned' as const};assert.equal(australianEligibility(legacy).status,'eligible');
  assert.notEqual(australianEligibility({...legacy,applicantLocations:['Vietnam']}).status,'eligible');
});
test('feed adapter retains publisher country and unknown geography never spends AI budget',async()=>{
  const j=fromFeed({id:'1',title:raw.title,company:'Fixture',description:raw.description,location:'Sydney',locationCountry:'Australia',url})!;
  assert.deepEqual(j.locationCountries,['Australia']);assert.equal(australianEligibility(j).status,'eligible');
  const store={reserveReview:async()=>{throw Error('Ineligible listings must not incur model cost');}} as unknown as JobIndexStore;
  const foreign=normaliseJob({...raw,jobLocationType:'TELECOMMUTE',applicantLocationRequirements:{'@type':'Country',name:'Vietnam'}},url)!;
  assert.equal((await minimaxReviewer(store,'fictional')(foreign,profile,{resume:'Data engineer',instructions:''})).decision,'no_match');
  const unknown=normaliseJob(raw,url)!;
  assert.equal((await minimaxReviewer(store,'fictional')(unknown,profile,{resume:'Data engineer',instructions:''})).decision,'uncertain');
});
