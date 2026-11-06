import {test} from 'node:test';
import assert from 'node:assert/strict';
import {leverApiUrl,leverPublisherJob} from './lever.js';
import {australianEligibility} from './geography.js';
const id='0ae31271-c49b-4819-bd59-0373287366a6',url=`https://jobs.lever.co/example/${id}`;
const html='<html><head><title>Example Employer - Senior Data Analyst</title></head><body><h2>Senior Data Analyst</h2><div>Sydney</div></body></html>';
const raw={id,hostedUrl:url,text:'Senior Data Analyst',country:'AU',categories:{location:'Sydney'},workplaceType:'hybrid',createdAt:1793664000000,descriptionPlain:'Use Python, SQL and Power BI to deliver reliable reporting and analytics for enterprise stakeholders.',lists:[{text:'Requirements',content:'<p>Experience working with SQL and business intelligence.</p>'}]};
test('Lever public API provides role country and duties missing from JSON-LD, bound to publisher identity',()=>{
  const j=leverPublisherJob(html,url,raw)!;assert.ok(j);assert.equal(j.company,'Example Employer');assert.equal(j.workArrangement,'hybrid');assert.equal(australianEligibility(j).status,'eligible');assert.match(j.description,/Requirements/);assert.equal(j.postedAt,new Date(raw.createdAt).toISOString());
  for(const change of [{id:'different'},{hostedUrl:url+'-other'},{text:'Invented title'}])assert.equal(leverPublisherJob(html,url,{...raw,...change}),null);
  assert.equal(leverPublisherJob(html.replace('Example Employer - ','Unrelated page'),url,raw),null);
  assert.equal(australianEligibility(leverPublisherJob(html,url,{...raw,country:'CA'})!).status,'excluded');
  assert.equal(australianEligibility(leverPublisherJob(html,url,{...raw,country:undefined})!).status,'unknown');
});
test('Lever API destinations cannot be selected by arbitrary URLs or application pages',()=>{
  assert.equal(leverApiUrl(url),`https://api.lever.co/v0/postings/example/${id}?mode=json`);
  assert.equal(leverApiUrl(url.replace('jobs.lever.co','jobs.eu.lever.co')),`https://api.eu.lever.co/v0/postings/example/${id}?mode=json`);
  for(const v of [url+'/apply',url.replace('jobs.lever.co','jobs.lever.co.evil.org'),url.replace(id,'arbitrary')])assert.equal(leverApiUrl(v),null);
});
