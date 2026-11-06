import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildSearchPrompt} from './job-index-codex-connector.mjs';
test('manual discovery covers Australian aggregators and employer destinations without a listing quota',()=>{
 const prompt=buildSearchPrompt([{keywords:['Senior Data Analyst'],location:'Sydney',arrangements:['hybrid']}]);
 for(const phrase of ['au.jora.com','adzuna.com.au','Careerjet','Jooble','Talent.com','Jobrapido','no fixed listing-count limit','original employer or ATS','discoveredFrom','Deduplicate','Never submit an application','CAPTCHAs','Australia only'])assert.ok(prompt.includes(phrase),phrase);
 assert.doesNotMatch(prompt,/up to 15|at most 15|maxItems/i);
 assert.ok(prompt.includes('Senior Data Analyst'));assert.ok(prompt.includes('independent source verification'));
 assert.match(prompt,/finish within five minutes/);assert.match(prompt,/Return verified partial findings/);
 assert.match(prompt,/quote fields may be empty/);assert.match(prompt,/without inventing jobs or relaxing criteria/);
});
