import {test} from 'node:test';import assert from 'node:assert/strict';
import {savedSearchRoles,professionalRoleTerms,equivalentRole} from './search-terms.js';
import {discoveryQueries} from './discovery.js';
import {matchJob,normaliseJob} from './extract.js';
test('only explicit allowed-role directives expand discovery; exclusions and personal answers do not leak',()=>{
 const roles=savedSearchRoles(['Senior Data Analyst'],'Apply for Senior Data Analyst, Senior BI Analyst, Reporting Analyst, Data Quality Analyst\n\nCitizenship: private personal answer\nExclude: Data Scientist');
 assert.deepEqual(roles,['Senior Data Analyst','Senior BI Analyst','Reporting Analyst','Data Quality Analyst']);
 assert.deepEqual(savedSearchRoles(['Stocktaker'],'Only apply dog walker and stocktaker'),['Stocktaker','dog walker','stocktaker']);
 assert.deepEqual(savedSearchRoles(['Data analyst'],'Exclude: Data Scientist\nContact person@example.test'),['Data analyst']);
 assert.deepEqual(savedSearchRoles([],'Apply for Reporting and Insights Lead, Business and Data Analyst'),['Reporting and Insights Lead','Business and Data Analyst']);
 assert.deepEqual(professionalRoleTerms('Data analyst, person@example.test, https://private.test, 0412345678'),['Data analyst']);
});
test('remote coverage follows the saved allowlist; office queries stay in the selected city',()=>{
 const p={userId:'1',fingerprint:'test',keywords:['Data analyst'],searchRoles:['Data analyst','Reporting Analyst'],skills:['SQL'],location:'Sydney',arrangements:['hybrid','remote'],excludedCompanies:[],sources:{}};
 const queries=discoveryQueries([p]);assert.ok(queries.some(q=>q.includes('"Reporting Analyst"')));assert.ok(queries.some(q=>q.includes('remote')&&q.includes('Australia')&&!q.includes('Sydney')));
 assert.ok(discoveryQueries([{...p,arrangements:['onsite']}]).every(q=>q.includes('Sydney')&&!q.includes('remote')));
});
test('equivalent requested roles reach review with one shared skill; unrelated roles and hard conflicts still fail',()=>{
 assert.ok(equivalentRole('AI developer','Senior AI Engineer'));assert.ok(equivalentRole('Full Stack Developer','Fullstack Engineer'));assert.ok(equivalentRole('pet walking','Dog Walker'));assert.equal(equivalentRole('AI developer','Data Scientist'),false);
 const p={userId:'1',fingerprint:'test',keywords:['AI developer'],skills:['Python'],location:'Sydney',arrangements:['onsite'],excludedCompanies:[],sources:{}};
 const job=normaliseJob({title:'AI Engineer',hiringOrganization:'Fixture',description:'Develop useful AI applications using Python for our customers and internal teams.',jobLocation:{address:{addressCountry:'AU'}}},'https://careers.fixture.org/job/1')!;
 assert.equal(matchJob(job,p)?.status,'potential');assert.equal(matchJob({...job,title:'Finance Analyst'},p),null);
 assert.equal(matchJob({...job,workArrangement:'remote'},p),null);assert.equal(matchJob(job,{...p,excludedCompanies:['Fixture']}),null);
});
