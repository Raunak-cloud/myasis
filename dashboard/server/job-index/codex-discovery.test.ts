import assert from 'node:assert/strict';
import {test} from 'node:test';
import {publisherJob,parseLeads} from './codex-discovery.js';
import {australianEligibility} from './geography.js';
const url='https://careers.fixture.org/jobs/123';
const description='Build reliable data pipelines with Python and SQL, collaborate with analysts and deliver accurate reporting products for the finance and operations teams.';
const lead={url,title:'Data engineer',company:'Fixture Employer',descriptionQuote:description,locationQuote:'Sydney, NSW',countryQuote:'',workArrangement:'not-mentioned',postedAt:'2026-11-01',postedQuote:'1 Nov 2026'};
const html=`<header>Unrelated Australian headquarters</header><main><h1>Data engineer</h1><p>Fixture Employer</p><p>Sydney, NSW</p><p>1 Nov 2026</p><p>${description}</p></main><footer>Australia</footer>`;
test('Codex source claims must bind to the original job page and verbatim role evidence',()=>{
 const j=publisherJob(html,url,lead)!;assert.ok(j);assert.equal(j.postedAt,'2026-11-01T00:00:00.000Z');assert.equal(australianEligibility(j).status,'eligible');
 assert.equal(j.evidence.publisherLocation,'Sydney, NSW');
 for(const change of [{title:'Invented role'},{company:'Different Employer'},{descriptionQuote:'Invented duties '.repeat(20)},{locationQuote:'Australia'}])assert.equal(publisherJob(html,url,{...lead,...change}),null);
 assert.equal(publisherJob(html,url+'-different',lead),null);
 assert.equal(publisherJob(html.replace('Sydney, NSW','Sydney, Nova Scotia'),url,{...lead,locationQuote:'Sydney, Nova Scotia'}),null);
 const foreign='<main><h1>Data engineer</h1><script type="application/ld+json">'+JSON.stringify({'@type':'JobPosting',title:lead.title,hiringOrganization:{name:lead.company},description,jobLocation:{address:{addressCountry:'VN'}},url})+'</script></main>';
 assert.notEqual(australianEligibility(publisherJob(foreign,url,lead)!).status,'eligible');
 const expired=foreign.replace('"url":', '"validThrough":"2020-01-01","url":');assert.equal(publisherJob(expired,url,lead),null);
 assert.equal(publisherJob(html.replace('</main>','<p>This job has expired.</p></main>'),url,lead),null);
 const wrapped=`<form><main><h1>Job Search</h1><section id="job-content"><h2>Data engineer</h2><p>Fixture Employer</p><p>Sydney, NSW</p><p>1 Nov 2026</p><p>${description}</p><input value="Do not collect this answer"></section></main></form>`;
 const actual=publisherJob(wrapped,url,lead)!;assert.ok(actual);assert.doesNotMatch(actual.description,/Job Search|Do not collect/);
});
test('capital/subdivision resolution cannot override foreign structured countries or accept a bare city',()=>{
 for(const location of ['Sydney, NSW','Melbourne VIC 3000','Canberra, ACT or Sydney, NSW'])assert.equal(australianEligibility({locations:[location],applicantLocations:[],workArrangement:'onsite'}).status,'eligible');
 for(const location of ['Sydney','Melbourne, Florida','Sydney, NSW, Canada','Australia excluded'])assert.notEqual(australianEligibility({locations:[location],applicantLocations:[],workArrangement:'onsite'}).status,'eligible');
 assert.notEqual(australianEligibility({locations:['Sydney, NSW'],locationCountries:['Canada'],applicantLocations:[],workArrangement:'onsite'}).status,'eligible');
});
test('agent packets reject malformed, duplicate, non-public and oversized results',()=>{
 assert.equal(parseLeads({jobs:[lead,lead]}).length,1);
 for(const jobs of [[{...lead,url:'http://localhost/jobs'}],[{...lead,title:42}],[{...lead,workArrangement:'invented'}],Array(16).fill(lead)])assert.throws(()=>parseLeads({jobs}));
});
