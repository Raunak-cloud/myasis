import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoverHiringContact, publishedHiringContacts, createHiringContactSearch, canReuseHiringContact, hiringCompanyBrand, assessHiringContact, type HiringContact } from './discovery.js';
import { PublicCrawler, CrawlBlocked, type PageResponse } from '../job-index/network.js';

const now = new Date('2026-11-16T01:00:00.000Z');
const response = (url: string, text: string, status = 200): PageResponse => ({ url, text, status, type: 'text/html', retryAfter: null });
function fixture(pages: Record<string, string | PageResponse>) {
  const calls: string[] = [];
  return { calls, get: async (url: string) => { calls.push(url); const page = pages[url]; return typeof page === 'string' ? response(url, page) : page ?? response(url, '', 404); } };
}
const previous: HiringContact = { email: 'careers@acme.org', companyDomain: 'acme.org', kind: 'recruitment', sourceUrl: 'https://acme.org/careers', sourceText: 'Acme recruitment careers@acme.org', validatedAt: '2026-10-01T00:00:00Z' };

test('agent-selected public evidence is checked before recrawling global navigation without bypassing employer identity',async()=>{
 const source='https://acme.org/team/recruitment';
 const f=fixture({'https://acme.org/':'<h1>Acme</h1>'+Array.from({length:30},(_,i)=>`<a href="/careers/region-${i}">Careers</a>`).join(''),[source]:'<title>Acme Recruitment</title><h1>Acme</h1><p>Send your CV to talent@acme.org.</p>'});
 const result=await discoverHiringContact({company:'Acme',website:'https://acme.org/',sourceUrls:[source]},{crawler:f,maxPages:2});
 assert.equal(result.contact?.email,'talent@acme.org');assert.equal(f.calls[0],source);
 const other='https://unrelated.org/careers';
 const bad=await discoverHiringContact({company:'Acme',sourceUrls:[other]},{crawler:fixture({[other]:'<h1>Unrelated business</h1><p>Recruitment talent@unrelated.org.</p>'}),maxPages:2});
 assert.equal(bad.contact,null);
 const ordered=fixture({'https://acme.org/':'<h1>Acme</h1>'+Array.from({length:30},(_,i)=>`<a href="/careers/australia-${i}">Careers in Australia</a>`).join(''),[source]:'<h1>Acme</h1><p>Recruitment talent@acme.org</p>'});
 const selected=await discoverHiringContact({company:'Acme',website:'https://acme.org/',sourceUrls:['https://acme.org/',source]},{crawler:ordered,maxPages:4});
 assert.equal(selected.contact?.email,'talent@acme.org');assert.deepEqual(ordered.calls,['https://acme.org/',source]);
});

test('partially redacted addresses are not treated as complete published mailboxes',()=>{
 for(const email of ['j***e@acme.org','***@acme.org'])assert.equal(publishedHiringContacts(`<h1>Acme careers</h1><p>Recruitment contact ${email}</p>`,'https://acme.org/careers','acme.org',true).length,0);
 assert.equal(publishedHiringContacts('<h1>Acme careers</h1><p>Recruitment talent@acme.org</p>','https://acme.org/careers','acme.org',true)[0]?.email,'talent@acme.org');
});

test('an agent can connect an actual published profile email to its separate recruiter bio with exact public evidence',async()=>{
 const source='https://acme.org/people/jane';
 const html='<title>Jane Doe</title><h1>Acme</h1><p>Email: jane@acme.org</p><section><h2>Jane Doe</h2><p>Jane recruits software engineers in Sydney.</p></section>';
 const evidence={email:'jane@acme.org',sourceUrl:source,quotes:['Email: jane@acme.org','Jane recruits software engineers in Sydney.']};
 assert.deepEqual(publishedHiringContacts(html,source,'acme.org',true),[]);
 const result=await discoverHiringContact({company:'Acme',roleTitle:'Software Engineer',sourceUrls:[source],contactEvidence:evidence},{crawler:fixture({[source]:html})});
 assert.equal(result.contact?.email,'jane@acme.org');assert.match(result.contact!.sourceText,/recruits software engineers/);
 assert.deepEqual(result.contact?.evidenceQuotes,evidence.quotes);
 const revalidated=await discoverHiringContact({company:'Acme',roleTitle:'Software Engineer',previous:result.contact!},{crawler:fixture({[source]:html}),search:async()=>{throw Error('Published evidence should revalidate without searching');}});
 assert.equal(revalidated.contact?.email,'jane@acme.org');assert.equal(revalidated.pagesRead,1);assert.match(revalidated.reason,/revalidated/);
 let renders=0;
 const dynamic={...fixture({[source]:'<h1>Acme</h1><script src="profile.js"></script>'}),renderPublicPage:async()=>{renders++;return response(source,html);}};
 const rendered=await discoverHiringContact({company:'Acme',previous:result.contact!},{crawler:dynamic});assert.equal(rendered.contact?.email,'jane@acme.org');assert.equal(renders,1);
 const changed=await discoverHiringContact({company:'Acme',previous:result.contact!},{crawler:fixture({[source]:'<h1>Acme</h1><p>Recruitment another@acme.org</p>'})});assert.equal(changed.contact,null);assert.equal(changed.retryable,true,'changed cited evidence goes back to the agent rather than silently switching recipients');
 for(const bad of [{...evidence,email:'invented@acme.org'},{...evidence,quotes:['A fabricated recruitment biography.']},{...evidence,email:'privacy@acme.org'}]){
  const rejected=await discoverHiringContact({company:'Acme',sourceUrls:[source],contactEvidence:bad},{crawler:fixture({[source]:html+'<p>Recruitment other@acme.org</p>'})});
  assert.equal(rejected.contact,null,'invalid nominations cannot silently switch to another email');
 }
 const unrelated=await discoverHiringContact({company:'Different Employer',sourceUrls:[source],contactEvidence:evidence},{crawler:fixture({[source]:html})});assert.equal(unrelated.contact,null);
 const suffix=await discoverHiringContact({company:'Acme',sourceUrls:[source],contactEvidence:{...evidence,quotes:['Jane recruits software engineers in Sydney.']}},{crawler:fixture({[source]:html.replaceAll('jane@acme.org','jane@acme.org.other.org')})});assert.equal(suffix.contact,null,'a substring of another full address is not publication of the nominated mailbox');
});

test('company careers pages precede search, select a published hiring contact, and retain source evidence', async () => {
  const crawler = fixture({
    'https://acme.org/': '<h1>Acme</h1><a href="/contact">Contact</a><a href="/careers">Careers</a>',
    'https://acme.org/careers': '<h1>Acme careers</h1><p>Contact our recruitment manager Jane Smith: <a href="mailto:jane.smith@acme.org?subject=Application">Jane Smith</a></p>',
  });
  const result = await discoverHiringContact({ company: 'Acme Pty Ltd', website: 'https://acme.org/' }, { crawler, now: () => now, search: async () => { throw Error('Should not search when official careers page works'); } });
  assert.equal(result.contact?.email, 'jane.smith@acme.org');
  assert.equal(result.contact?.kind, 'hiring_manager'); assert.equal(result.contact?.sourceUrl, 'https://acme.org/careers');
  assert.equal(result.contact?.validatedAt, now.toISOString()); assert.match(result.contact!.sourceText, /recruitment manager/);
  assert.deepEqual(crawler.calls, ['https://acme.org/', 'https://acme.org/careers']);
});

test('only visible published contacts are extracted; scripts, hidden traps and inappropriate mailboxes are ignored', () => {
  const html = `<h1>Acme careers</h1><script>recruitment evil@attacker.org</script><p hidden>Recruitment hidden@acme.org</p>
    <p style="display: none">Hiring invisible@acme.org</p><p>Recruitment privacy@acme.org support@acme.org no-reply@acme.org</p>
    <p>General enquiries info@acme.org</p><p>Recruitment: careers [at] acme [dot] org</p>`;
  const contacts = publishedHiringContacts(html, 'https://acme.org/', 'acme.org', true, now);
  assert.deepEqual(contacts.map(c => c.email), ['careers@acme.org']);
});

test('a recruiting header elsewhere does not promote a generic sales or support email', () => {
  const html = '<h1>Acme careers</h1><p>General enquiries info@acme.org</p><p>Support support@acme.org</p><a href="/careers">Careers</a>';
  assert.deepEqual(publishedHiringContacts(html, 'https://acme.org/', 'acme.org', true), []);
});

test('nested footer navigation cannot turn an operations mailbox into a hiring contact',()=>{
 const html='<title>Acme delivery</title><h1>Acme</h1><footer><div><div>Delivery and fleet support. <a href="mailto:admin@acme.org">admin@acme.org</a></div><div>Company <a href="/careers">Careers</a></div></div></footer>';
 assert.deepEqual(publishedHiringContacts(html,'https://acme.org/','acme.org',true),[]);
 const recruiting=html.replace('Delivery and fleet support.','For recruitment, send your CV to');
 assert.equal(publishedHiringContacts(recruiting,'https://acme.org/','acme.org',true)[0]?.email,'admin@acme.org');
 assert.equal(publishedHiringContacts('<h1>Acme</h1><p>Recruitment <a href="/contact">jane@acme.org</a></p>','https://acme.org/','acme.org',true)[0]?.email,'jane@acme.org','visible address text is evidence even if the publisher uses a normal hyperlink');
});

test('mailbox context stays inside its own contact card rather than borrowing a sibling hiring heading',()=>{
 const html='<title>Acme</title><h1>Acme</h1><div><article><h2>Business enquiries</h2><p>Delivery services and partnerships</p><a href="mailto:admin@acme.org">Email us</a></article><article><h2>Careers and applicants</h2><p>Contact our recruitment team.</p>SECOND_CONTACT</article></div>';
 assert.deepEqual(publishedHiringContacts(html.replace('SECOND_CONTACT',''),'https://acme.org/contact','acme.org',true),[]);
 const contacts=publishedHiringContacts(html.replace('SECOND_CONTACT','<a href="mailto:talent@acme.org">Applicant contact</a>'),'https://acme.org/contact','acme.org',true);
 assert.deepEqual(contacts.map(contact=>contact.email),['talent@acme.org']);
});

test('an explicit do-not-email notice disqualifies the published address', () => {
  for (const wording of ['Do not email careers@acme.org for recruitment.', 'Recruitment careers@acme.org, this mailbox is not monitored.', 'We do not accept emailed applications at careers@acme.org.']) {
    assert.deepEqual(publishedHiringContacts(`<p>${wording}</p>`, 'https://acme.org/', 'acme.org', true), [], wording);
  }
});

test('revalidation reads the exact previous source and refreshes timestamp without searching', async () => {
  const crawler = fixture({ 'https://acme.org/careers': '<h1>Acme</h1><p>Recruitment careers@acme.org</p>' });
  const result = await discoverHiringContact({ company: 'Acme', previous }, { crawler, now: () => now, search: async () => { throw Error('Unexpected search'); } });
  assert.equal(result.contact?.email, previous.email); assert.equal(result.contact?.validatedAt, now.toISOString());
  assert.match(result.reason, /revalidated/); assert.deepEqual(crawler.calls, [previous.sourceUrl]);
});

test('a removed cached email is never reused and fresh public evidence can replace it', async () => {
  const crawler = fixture({
    'https://acme.org/careers': '<h1>Acme</h1><p>This contact has moved.</p>',
    'https://acme.org/': '<h1>Acme</h1><a href="/people">Our people</a>',
    'https://acme.org/people': '<h1>Acme</h1><p>Hiring enquiries: talent@acme.org</p>',
  });
  const result = await discoverHiringContact({ company: 'Acme', website: 'https://acme.org/', previous }, { crawler });
  assert.equal(result.contact?.email, 'talent@acme.org'); assert.notEqual(result.contact?.email, previous.email);
});

test('unreachable revalidation with no fresh publication returns no contact, never a stale fallback', async () => {
  const result = await discoverHiringContact({ company: 'Acme', previous }, { crawler: fixture({}) });
  assert.equal(result.contact, null);
});

test('a replacement contact published on the cached source is adopted instead of retaining a removed address', async () => {
  const result = await discoverHiringContact({ company: 'Acme', previous }, { crawler: fixture({ 'https://acme.org/careers': '<h1>Acme</h1><p>Recruitment talent@acme.org</p>' }) });
  assert.equal(result.contact?.email, 'talent@acme.org'); assert.equal(result.pagesRead, 1);
});

test('cached domain must still identify the company when revalidated', async () => {
  const result = await discoverHiringContact({ company: 'Acme', previous }, { crawler: fixture({ 'https://acme.org/careers': '<h1>Unrelated company</h1><p>Recruitment careers@acme.org</p>' }) });
  assert.equal(result.contact, null);
});

test('external cached publications cannot renew a contact after the email company domain changes ownership', async () => {
  const external = { ...previous, sourceUrl: 'https://directory.org/acme' };
  const crawler = fixture({
    'https://directory.org/acme': '<h1>Acme recruitment</h1><p>Recruitment careers@acme.org</p>',
    'https://acme.org/': '<h1>Different company</h1><p>Recruitment careers@acme.org</p>',
  });
  const result = await discoverHiringContact({ company: 'Acme', previous: external }, { crawler });
  assert.equal(result.contact, null); assert.equal(result.retryable, false);
  assert.deepEqual(crawler.calls, ['https://directory.org/acme', 'https://acme.org/']);
});

test('external cached contacts renew only while their official company publisher still confirms identity', async () => {
  const external = { ...previous, sourceUrl: 'https://directory.org/acme' };
  const crawler = fixture({
    'https://directory.org/acme': '<h1>Acme recruitment</h1><p>Recruitment careers@acme.org</p>',
    'https://acme.org/': '<h1>Acme</h1><p>Welcome to our company website.</p>',
  });
  const result = await discoverHiringContact({ company: 'Acme', previous: external }, { crawler, now: () => now });
  assert.equal(result.contact?.email, previous.email); assert.equal(result.contact?.validatedAt, now.toISOString());
  assert.equal(result.retryable, false); assert.equal(result.pagesRead, 2);
});

test('temporary official publisher outages cannot renew a directory contact and remain retryable', async () => {
  const external = { ...previous, sourceUrl: 'https://directory.org/acme' };
  const crawler = fixture({
    'https://directory.org/acme': '<h1>Acme recruitment</h1><p>Recruitment careers@acme.org</p>',
    'https://acme.org/': response('https://acme.org/', '', 503),
  });
  const result = await discoverHiringContact({ company: 'Acme', previous: external }, { crawler });
  assert.equal(result.contact, null); assert.equal(result.retryable, true);
});

test('ATS and job-board emails are never treated as the employer contact; outbound employer links are followed', async () => {
  const crawler = fixture({
    'https://www.seek.com.au/job/123': '<h1>Acme vacancy</h1><p>Recruitment careers@seek.com.au</p><a href="https://acme.org/">Acme company website</a>',
    'https://acme.org/': '<h1>Acme</h1><p>Recruitment careers@acme.org</p>',
  });
  const result = await discoverHiringContact({ company: 'Acme', jobUrl: 'https://www.seek.com.au/job/123' }, { crawler });
  assert.equal(result.contact?.email, 'careers@acme.org'); assert.equal(result.contact?.companyDomain, 'acme.org');
});

test('official website discovery verifies page identity rather than trusting search snippets or guesses', async () => {
  const crawler = fixture({
    'https://unrelated.org/': '<h1>Other company</h1><p>Recruitment careers@unrelated.org</p>',
    'https://acme.org/': '<h1>Acme</h1><p>Recruitment careers@acme.org</p>',
  });
  const queries: string[] = [];
  const result = await discoverHiringContact({ company: 'Acme' }, { crawler, search: async query => { queries.push(query); return [{ url: 'https://unrelated.org/', title: 'Acme careers' }, { url: 'https://acme.org/' }]; } });
  assert.equal(result.contact?.email, 'careers@acme.org'); assert.equal(queries.length, 1);
});

test('a public ATS job contact can be used after the company domain is independently confirmed', async () => {
  const crawler = fixture({
    'https://acme.org/': '<h1>Acme</h1><p>We have great opportunities.</p>',
    'https://careers.pageuppeople.com/123/job/1': '<h1>Acme careers</h1><p>Hiring manager Jane: jane@acme.org</p><p>Platform support careers@pageuppeople.com</p>',
  });
  const result = await discoverHiringContact({ company: 'Acme', website: 'https://acme.org/', jobUrl: 'https://careers.pageuppeople.com/123/job/1' }, { crawler });
  assert.equal(result.contact?.email, 'jane@acme.org'); assert.equal(result.contact?.sourceUrl, 'https://careers.pageuppeople.com/123/job/1');
  assert.deepEqual(crawler.calls, ['https://acme.org/', 'https://careers.pageuppeople.com/123/job/1']);
});

test('external public sources require company identity plus a company-domain email', async () => {
  const crawler = fixture({
    'https://acme.org/': '<h1>Acme</h1><p>We are a local company.</p>',
    'https://directory.org/acme': '<h1>Acme recruitment</h1><p>Contact recruitment: wrong@attacker.org careers@acme.org</p>',
  });
  const result = await discoverHiringContact({ company: 'Acme', website: 'https://acme.org/' }, { crawler, search: async query => query.includes('"@acme.org"') ? [{ url: 'https://directory.org/acme' }] : [] });
  assert.equal(result.contact?.email, 'careers@acme.org'); assert.equal(result.contact?.sourceUrl, 'https://directory.org/acme');
});

test('private URLs and private redirect destinations cannot be returned as verified contacts', async () => {
  const crawler = fixture({ 'https://acme.org/': response('https://127.0.0.1/private', '<h1>Acme</h1><p>Recruitment careers@acme.org</p>') });
  const result = await discoverHiringContact({ company: 'Acme', website: 'https://acme.org/' }, { crawler });
  assert.equal(result.contact, null);
  await discoverHiringContact({ company: 'Acme', website: 'https://169.254.169.254/' }, { crawler });
  assert.equal(crawler.calls.some(url => url.includes('169.254')), false);
});

test('real crawler enforces robots and pins redirected destination policy before discovery reads', async () => {
  const calls: string[] = [];
  const crawler = new PublicCrawler(async url => { calls.push(url); return response(url, url.endsWith('/robots.txt') ? 'User-agent: *\nDisallow: /' : '<h1>Acme</h1><p>Recruitment careers@acme.org</p>'); });
  const result = await discoverHiringContact({ company: 'Acme', website: 'https://acme.org/' }, { crawler });
  assert.equal(result.contact, null); assert.deepEqual(calls, ['https://acme.org/robots.txt']);
});

test('page budget bounds cyclic careers links and errors do not become invented contacts', async () => {
  const crawler = fixture({
    'https://acme.org/': '<h1>Acme</h1><a href="/careers">Careers</a><a href="/people">People</a>',
    'https://acme.org/careers': '<h1>Acme</h1><a href="/">Home</a><a href="/team">Team</a>',
  });
  const result = await discoverHiringContact({ company: 'Acme', website: 'https://acme.org/' }, { crawler, maxPages: 2 });
  assert.equal(result.contact, null); assert.equal(result.pagesRead, 2); assert.equal(crawler.calls.length, 2);
});

test('caller cancellation is preserved rather than reported as no contact', async () => {
  const controller = new AbortController(); controller.abort(Error('Run cancelled'));
  await assert.rejects(discoverHiringContact({ company: 'Acme', website: 'https://acme.org/', signal: controller.signal }, { crawler: fixture({}) }), /Run cancelled/);
});

test('search uses global reservation, provider key only in headers, bounded results and no redirects', async () => {
  let reservations = 0, requests = 0;
  const network: typeof fetch = async (input, init) => {
    requests++; const url = new URL(String(input)); assert.equal(url.hostname, 'api.search.brave.com'); assert.equal(url.searchParams.get('count'), '6');assert.equal(url.searchParams.get('extra_snippets'),'true');
    assert.equal(init?.redirect, 'error'); assert.equal(new Headers(init?.headers).get('X-Subscription-Token'), 'fixture-secret');
    assert.equal(url.href.includes('fixture-secret'), false);
    return Response.json({ web: { results: [{ url: 'https://acme.org/' }] } });
  };
  const search = createHiringContactSearch({ key: 'fixture-secret', reserveSearch: async () => ++reservations === 1, network });
  assert.equal((await search('Acme careers')).length, 1); await assert.rejects(search('Acme contacts'), /deferred/); assert.equal(requests, 1);
});

test('search-service refusal is reported separately from inaccessible employer websites without retaining provider payloads',async()=>{
 for(const [status,code] of [[402,'search_payment_required'],[429,'search_rate_limited'],[503,'search_service_unavailable']] as const){
  const search=createHiringContactSearch({key:'fixture-secret',reserveSearch:async()=>true,network:async()=>Response.json({error:'PRIVATE_PROVIDER_PAYLOAD'},{status})});
  const result=await discoverHiringContact({company:'Acme'},{crawler:fixture({}),search});
  assert.equal(result.outcome,'temporarily_unavailable');assert.ok(result.diagnostics.events.some(event=>event.code===code&&event.action==='search_public'));assert.doesNotMatch(JSON.stringify(result),/PRIVATE_PROVIDER_PAYLOAD|fixture-secret/);
 }
});

test('company mentions on a public directory cannot establish the official company domain', async () => {
  const crawler = fixture({
    'https://directory.org/acme': '<title>Acme careers directory</title><h1>Acme</h1><p>Recruitment careers@directory.org</p>',
    'https://acme.org/': '<h1>Acme</h1><p>Recruitment careers@acme.org</p>',
  });
  const result = await discoverHiringContact({ company: 'Acme' }, { crawler, search: async () => [{ url: 'https://directory.org/acme', title: 'Acme official careers' }, { url: 'https://acme.org/' }] });
  assert.equal(result.contact?.companyDomain, 'acme.org'); assert.equal(result.contact?.email, 'careers@acme.org'); assert.equal(result.retryable, false);
});

test('publisher site identity supports a genuine brand whose website uses a different domain', async () => {
  const crawler = fixture({ 'https://brandportal.org/': '<meta property="og:site_name" content="Acme"><h1>Acme</h1><p>Recruitment careers@brandportal.org</p>' });
  const result = await discoverHiringContact({ company: 'Acme' }, { crawler, search: async () => [{ url: 'https://brandportal.org/' }] });
  assert.equal(result.contact?.companyDomain, 'brandportal.org');
});

test('transport failures, provider outages, HTTP rate limits and exhausted search allowances remain retryable', async () => {
  for (const status of [408, 429, 503]) {
    const result = await discoverHiringContact({ company: 'Acme', website: 'https://acme.org/' }, { crawler: fixture({ 'https://acme.org/': response('https://acme.org/', '', status) }) });
    assert.equal(result.contact, null); assert.equal(result.retryable, true, `HTTP ${status}`);
  }
  const search = createHiringContactSearch({ key: 'fixture', reserveSearch: async () => false });
  const budget = await discoverHiringContact({ company: 'Acme' }, { crawler: fixture({}), search });
  assert.equal(budget.retryable, true);
  const transport = await discoverHiringContact({ company: 'Acme', previous }, { crawler: { get: async () => { throw Error('Temporary DNS outage'); } } });
  assert.equal(transport.contact, null); assert.equal(transport.retryable, true);
});

test('confirmed missing or non-published contacts produce a clean negative result', async () => {
  const result = await discoverHiringContact({ company: 'Acme', website: 'https://acme.org/' }, { crawler: fixture({ 'https://acme.org/': '<h1>Acme</h1><p>Visit our offices.</p>' }) });
  assert.equal(result.contact, null); assert.equal(result.retryable, false);
  const removed = await discoverHiringContact({ company: 'Acme', previous }, { crawler: fixture({}) });
  assert.equal(removed.contact, null); assert.equal(removed.retryable, false, 'HTTP404 confirms the old publication was removed');
});

test('fresh cached contacts can be reused for direct employer sites without new discovery', async () => {
  const crawler = fixture({});
  assert.equal(await canReuseHiringContact('Acme', 'https://careers.acme.org/job/123', previous, { crawler }), true);
  assert.deepEqual(crawler.calls, []);
  assert.equal(await canReuseHiringContact('Acme', 'https://other-acme.org/job/123', previous, { crawler }), false);
});

test('job-board employer names alone cannot authorize a same-name company cache', async () => {
  const url = 'https://www.seek.com.au/job/123';
  const crawler = fixture({ [url]: '<h1>Acme hiring</h1><p>Acme is a great place to work. Recruitment careers@differentacme.org</p>' });
  assert.equal(await canReuseHiringContact('Acme', url, previous, { crawler }), false);
});

test('public job organisation metadata associates a vacancy with the verified cached domain', async () => {
  const url = 'https://www.seek.com.au/job/123';
  const crawler = fixture({ [url]: `<script type="application/ld+json">${JSON.stringify({ '@graph': [{ '@type': 'JobPosting', hiringOrganization: { '@type': 'Organization', name: 'Acme Pty Ltd', sameAs: 'https://www.acme.org/' } }] })}</script>` });
  assert.equal(await canReuseHiringContact('Acme', url, previous, { crawler }), true);
  assert.equal(await canReuseHiringContact('Other Acme', url, previous, { crawler }), false);
});

test('explicit company website links associate an ATS vacancy with the cached domain', async () => {
  const url = 'https://acme.wd3.myworkdayjobs.com/jobs/job/1';
  const crawler = fixture({ [url]: '<h1>Acme careers</h1><a href="https://www.acme.org/">Company website</a>' });
  assert.equal(await canReuseHiringContact('Acme', url, previous, { crawler }), true);
  const unrelatedLink = fixture({ [url]: '<h1>Acme careers</h1><a href="https://www.acme.org/">Privacy policy vendor</a>' });
  assert.equal(await canReuseHiringContact('Acme', url, previous, { crawler: unrelatedLink }), false);
});

test('an explicitly published current-vacancy recruitment contact corroborates the cache identity', async () => {
  const url = 'https://www.seek.com.au/job/123';
  assert.equal(await canReuseHiringContact('Acme', url, previous, { crawler: fixture({ [url]: '<h1>Acme careers</h1><p>Recruitment careers@acme.org</p>' }) }), true);
  assert.equal(await canReuseHiringContact('Acme', url, previous, { crawler: fixture({ [url]: '<h1>Acme careers</h1><p>Recruitment careers@differentacme.org</p>' }) }), false);
});

test('cache identity checks reject private URLs and inaccessible or private redirects', async () => {
  assert.equal(await canReuseHiringContact('Acme', 'https://127.0.0.1/job/1', previous, { crawler: fixture({}) }), false);
  const url = 'https://www.seek.com.au/job/123';
  assert.equal(await canReuseHiringContact('Acme', url, previous, { crawler: fixture({ [url]: response('https://127.0.0.1/', '', 200) }) }), false);
});

test('public employer brands normalize legal, industry and office suffixes without inventing domains', () => {
  for (const [label,brand] of [
    ['Talent Insights Group Pty Ltd','talent insights'],['FinXL IT Professional Services','finxl'],['Preacta Recruitment','preacta'],
    ['Peoplebank Australia NSW','peoplebank'],['Delivery Centric Technologies','delivery centric'],['Other Acme Pty Ltd','other acme'],
    ['The Recruitment Company Limited','recruitment company'],
  ]) assert.equal(hiringCompanyBrand(label),brand,label);
});

for(const [company,brand,host] of [
  ['Talent Insights Group Pty Ltd','talent insights','talentinsights.org'],['FinXL IT Professional Services','finxl','finxl.org'],
  ['Preacta Recruitment','preacta','preacta.org'],['Peoplebank Australia NSW','peoplebank','peoplebank.org'],
  ['Delivery Centric Technologies','delivery centric','deliverycentric.org'],
])test(`regional/legal label ${company} expands to its public brand and reaches contact pages within budget`,async()=>{
  const home=`https://${host}/`,contact=`https://${host}/contact`,job='https://www.seek.com.au/job/123';
  const f=fixture({[home]:`<title>${brand}</title><h1>${brand}</h1><a href="/contact">Recruitment contact</a>`,[contact]:`<h1>${brand}</h1><p>Recruitment careers@${host}</p>`});
  const queries:string[]=[];
  const crawler={get:async(url:string)=>{if(url===job)throw Error('Robots policy excludes this address.');return f.get(url);}};
  const result=await discoverHiringContact({company,jobUrl:job},{crawler,maxPages:8,search:async query=>{
    queries.push(query);
    if(queries.length===1)return Array.from({length:6},(_,i)=>({url:`https://directory${i}.org/employer`,title:`${company} directory`}));
    assert.ok(query.startsWith(brand),'fallback uses observed employer brand, not the exact regional/legal phrase');
    return [{url:'https://au.seek.com/search'},{url:'https://nz.seek.com/jobs'},{url:'https://seek.com.au/search'},{url:home}];
  }});
  assert.equal(result.contact?.email,`careers@${host}`);assert.equal(result.retryable,false);assert.equal(queries.length,2);
  assert.ok(result.pagesRead<=8);assert.ok(f.calls.filter(url=>url.includes('directory')).length<=3,'reserve pages for the verified company');
  assert.equal(f.calls.some(url=>/seek\./.test(url)),false,'SEEK search results do not become employer-site candidates');
});

test('optional job-board robots restrictions do not poison a clean company no-contact result',async()=>{
  const f=fixture({'https://acme.org/':'<h1>Acme</h1><p>No published recruitment contact.</p>'});
  const result=await discoverHiringContact({company:'Acme',jobUrl:'https://au.seek.com/job/123'},{crawler:{get:async url=>{
    if(url.includes('seek.com'))throw Error('Robots policy excludes this address.');return f.get(url);
  }},search:async query=>query.includes('official company')?[{url:'https://acme.org/'}]:[]});
  assert.equal(result.contact,null);assert.equal(result.retryable,false);
});

test('official source pages get priority over remaining directory results after identity is established',async()=>{
  const f=fixture({'https://acme.org/':'<h1>Acme</h1><a href="/contact">Contact the hiring team</a>',
    'https://acme.org/contact':'<h1>Acme</h1><p>Recruitment careers@acme.org</p>'});
  const result=await discoverHiringContact({company:'Acme'},{crawler:f,maxPages:3,search:async()=>[
    {url:'https://other.org/list'},{url:'https://acme.org/'},{url:'https://third.org/list'},
  ]});
  assert.equal(result.contact?.email,'careers@acme.org');assert.deepEqual(f.calls,['https://acme.org/','https://acme.org/contact']);
});

test('structured publisher identity verifies brands on a differently named company domain',async()=>{
  const html='<h1>Acme</h1><script type="application/ld+json">'+JSON.stringify({'@type':'Organization',name:'Acme Pty Ltd',url:'https://brandportal.org/'})+'</script><p>Recruitment careers@brandportal.org</p>';
  const result=await discoverHiringContact({company:'Acme Pty Ltd'},{crawler:fixture({'https://brandportal.org/':html}),search:async()=>[{url:'https://brandportal.org/'}]});
  assert.equal(result.contact?.companyDomain,'brandportal.org');
  const spoof=await discoverHiringContact({company:'Acme'},{crawler:fixture({'https://directory.org/':'<meta property="og:site_name" content="Directory of Acme Recruitment"><h1>Acme recruitment directory</h1><p>Recruitment careers@directory.org</p>'}),search:async()=>[{url:'https://directory.org/'}]});
  assert.equal(spoof.contact,null,'a directory publisher containing brand words is not the brand');
});

test('recruitment agency offices and named recruitment cards are public candidate contacts, unrelated sales/support stay excluded',()=>{
  const office=publishedHiringContacts('<title>Sydney IT and Digital Recruitment Agency</title><h1>Our Sydney office</h1><p><a href="mailto:sydney@agency.org">sydney@agency.org</a></p><p>sales@agency.org support@agency.org</p>','https://agency.org/sydney','agency.org',true,now);
  assert.deepEqual(office.map(v=>v.email),['sydney@agency.org']);
  const consultant=publishedHiringContacts('<h1>About our team</h1><div><h2>Olivia Example</h2><p>Principal Recruitment Consultant - NSW</p><p><a href="mailto:olivia@agency.org">Email Olivia</a></p></div>','https://agency.org/about','agency.org',true,now);
  assert.equal(consultant[0]?.email,'olivia@agency.org');assert.match(consultant[0]!.sourceText,/Principal Recruitment Consultant/);
  const alternateBrand=publishedHiringContacts('<title>Find jobs</title><h1>Acme</h1><footer><a href="mailto:info@acmerecruitment.org">Contact us</a></footer>','https://acme.org/jobs','acme.org',true,now,'Acme Recruitment');
  assert.equal(alternateBrand[0]?.email,'info@acmerecruitment.org','an explicit primary-source recruitment-agency contact may retain a former brand email domain');
  assert.deepEqual(publishedHiringContacts('<title>Acme Software</title><h1>Acme</h1><footer><a href="mailto:info@acme.org">Contact us</a><a href="/careers">Careers</a></footer>','https://acme.org','acme.org',true,now,'Acme'),[]);
  const consultancy=publishedHiringContacts('<title>Sydney</title><h1>Sydney</h1><nav>Current Opportunities Consultant’s Hub T&Cs For Introduction Of A Consultant</nav><a href="mailto:sydney@consultancy.org">sydney@consultancy.org</a>','https://consultancy.org/branches/sydney-office','consultancy.org',true,now,'Acme IT Professional Services');
  assert.equal(consultancy[0]?.email,'sydney@consultancy.org');assert.match(consultancy[0]!.sourceText,/Consultant’s Hub|Introduction Of A Consultant/i);
  assert.deepEqual(publishedHiringContacts('<title>Sydney</title><h1>Acme</h1><footer>Recruitment website by Vendor <a href="mailto:info@acme.org">Contact us</a></footer>','https://acme.org','acme.org',true,now,'Acme'),[],'a vendor website credit is not the employer recruitment business');
});

test('public company-profile excerpts only corroborate an independently verified domain and preserve provenance',async()=>{
  const source='https://nz.linkedin.com/company/acme-technologies-pty-ltd';
  const f=fixture({'https://acme.org/':'<h1>Acme</h1><p>We build software.</p>'});
  const crawler={get:async(url:string)=>{if(url.includes('linkedin.com'))throw Error('Robots policy excludes this address.');return f.get(url);}};
  const search=async(query:string)=>query.includes('"@acme.org"')?[{url:source,title:'Acme Technologies',description:'Australian candidates can send resumes to talent@acme.org.'}]:[];
  const result=await discoverHiringContact({company:'Acme Technologies',website:'https://acme.org/'},{crawler,search});
  assert.equal(result.contact?.email,'talent@acme.org');assert.equal(result.contact?.sourceUrl,source);assert.match(result.contact!.sourceText,/^Public search excerpt:/);
  for(const value of [
    {url:'https://directory.org/acme',title:'Acme Technologies',description:'Recruitment talent@acme.org'},
    {url:'https://nz.linkedin.com/company/other-firm',title:'Acme Technologies',description:'Recruitment talent@acme.org'},
    {url:source,title:'Acme Technologies',description:'Recruitment talent@attacker.org'},
  ]){
    const negative=await discoverHiringContact({company:'Acme Technologies',website:'https://acme.org/'},{crawler:{get:async(url:string)=>url==='https://acme.org/'?f.get(url):Promise.reject(Error('Blocked'))},search:async()=>[value]});
    assert.equal(negative.contact,null);
  }
  const unknown=await discoverHiringContact({company:'Acme Technologies'},{crawler:{get:async()=>{throw Error('Blocked');}},search});
  assert.equal(unknown.contact,null,'an indexed snippet cannot establish company ownership by itself');
});

test('a removed excerpt contact is not renewed when the actual accessible profile no longer publishes it',async()=>{
  const source='https://www.linkedin.com/company/acme-technologies';
  const f=fixture({'https://acme.org/':'<h1>Acme</h1><p>We build software.</p>',[source]:'<h1>Acme Technologies</h1><p>Recruitment has moved to our official application portal.</p>'});
  const result=await discoverHiringContact({company:'Acme Technologies',website:'https://acme.org/'},{crawler:f,search:async()=>[{url:source,title:'Acme Technologies',description:'Old recruitment talent@acme.org'}]});
  assert.equal(result.contact,null);
});

test('regional recruitment contact is reached before deep repeated navigation exhausts the crawl',async()=>{
  const navigation='<a href="/careers">Careers</a><a href="/clients">Clients</a><a href="/sydney">Sydney</a>';
  const f=fixture({'https://acme.org/':`<h1>Acme</h1>${navigation}`,
    'https://acme.org/careers':`<h1>Acme</h1>${navigation}<a href="/careers/jobs">Career opportunities</a>`,
    'https://acme.org/sydney':'<title>Sydney IT Recruitment Agency - Acme</title><h1>Sydney office</h1><a href="mailto:sydney@acme.org">sydney@acme.org</a>'});
  const result=await discoverHiringContact({company:'Acme IT Professional Services',roleTitle:'Software Engineer Sydney NSW',website:'https://acme.org/'},{crawler:f,maxPages:4});
  assert.equal(result.contact?.email,'sydney@acme.org');assert.deepEqual(f.calls,['https://acme.org/','https://acme.org/sydney']);
});

test('an extensive official site without a hiring email leaves room for the public company-profile source',async()=>{
  const profile='https://www.linkedin.com/company/acme-technologies';
  const calls:string[]=[];
  const crawler={get:async(url:string)=>{
    calls.push(url);if(url===profile)throw Error('Robots policy excludes this address.');
    return response(url,'<h1>Acme</h1><p>Sales sales@acme.org</p>'+Array.from({length:12},(_,i)=>`<a href="/contact-${i}">Contact office ${i}</a>`).join(''));
  }};
  const result=await discoverHiringContact({company:'Acme Technologies',website:'https://acme.org/'},{crawler,maxPages:6,
    search:async query=>query.includes('"@acme.org"')?[{url:profile,title:'Acme Technologies',description:'Australian candidates can send resumes to talent@acme.org.'}]:[]});
  assert.equal(result.contact?.email,'talent@acme.org');assert.ok(calls.includes(profile),'the public profile source is actually attempted');
  assert.ok(result.pagesRead<=6);assert.match(result.contact!.sourceText,/^Public search excerpt:/);
});

test('an explicitly NSW-labelled employer uses its Sydney office, not a previously encountered Perth mailbox',async()=>{
  const f=fixture({'https://acme.org/perth':'<title>Acme Recruitment Perth</title><h1>Acme</h1><p>Recruitment perth@acme.org</p><a href="/sydney">Sydney</a>',
    'https://acme.org/sydney':'<title>Acme Sydney Recruitment</title><h1>Acme</h1><p>Sydney recruitment sydney@acme.org</p>'});
  const result=await discoverHiringContact({company:'Acme Australia NSW',website:'https://acme.org/perth'},{crawler:f,maxPages:4});
  assert.equal(result.contact?.email,'sydney@acme.org');assert.deepEqual(f.calls,['https://acme.org/perth','https://acme.org/sydney']);
});

test('alternative public company-profile excerpts provide the published hiring address when the main description is generic',async()=>{
  const profile='https://au.linkedin.com/company/acme-technologies-pty-ltd';
  const result=await discoverHiringContact({company:'Acme Technologies',website:'https://acme.org/'},{maxPages:4,
    crawler:{get:async url=>{if(url===profile)throw Error('Robots policy excludes this address.');return response(url,'<h1>Acme</h1><p>We build software.</p>');}},
    search:async()=>[{url:profile,title:'Acme Technologies Pty Ltd | LinkedIn',description:'We build a great culture.',extra_snippets:['Apply for Australian opportunities. Please share your resumes at <strong>ta@acme.org</strong>.']}],
  });
  assert.equal(result.contact?.email,'ta@acme.org');assert.match(result.contact!.sourceText,/Public search excerpt:/);assert.match(result.contact!.sourceText,/share your resumes/);
});

test('public exact-job excerpts can publish a resume inbox after independent company-domain verification',async()=>{
  const current='https://au.indeed.com/viewjob?jk=exact-current-job';
  const crawler={get:async(url:string)=>{if(url.includes('indeed.com'))throw Error('Robots policy excludes this address.');return response(url,'<h1>Acme</h1><p>We build software.</p>');}};
  const result=await discoverHiringContact({company:'Acme Technologies',jobUrl:current},{crawler,search:async query=>query.includes('official company')
    ?[{url:current,title:'Agentic AI Engineer - Sydney',description:'Please contact us at <strong>resumes@acme.org</strong> for additional details.'}]
    :[{url:'https://acme.org/',title:'Acme'}]});
  assert.equal(result.contact?.email,'resumes@acme.org');assert.equal(result.contact?.sourceUrl,current);assert.match(result.contact!.sourceText,/Public search excerpt:/);
  const negative=await discoverHiringContact({company:'Acme Technologies',jobUrl:current},{crawler,search:async query=>query.includes('official company')
    ?[{url:'https://au.indeed.com/viewjob?jk=another-job',title:'Agentic AI Engineer - Sydney',description:'Please contact us at resumes@acme.org for additional details.'}]
    :[{url:'https://acme.org/',title:'Acme'}]});
  assert.equal(negative.contact,null,'an unrelated job excerpt must also identify the company');
});

test('platform hiring-sales contacts never become an employer contact or reusable cache',async()=>{
  const platform={...previous,email:'hello@freehire.me',companyDomain:'freehire.me',sourceUrl:'https://freehire.me/talent',sourceText:'Hiring? Request access Join the network'};
  for(const company of ['FiftyFive Group Pty Ltd','MKA IT Services Pty LTD']){
    assert.equal(assessHiringContact(platform,company,'Software Developer').reviewRequired,true);
    assert.equal(await canReuseHiringContact(company,'https://freehire.me/talent',platform),false);
    const result=await discoverHiringContact({company,previous:platform},{crawler:fixture({'https://freehire.me/talent':`<meta property="og:site_name" content="${company}"><h1>${company}</h1><p>Hiring? Request access hello@freehire.me Join the network</p>`}),search:async()=>[{url:'https://freehire.me/talent'}]});
    assert.equal(result.contact,null);assert.equal(result.outcome,'company_unverified');assert.ok(result.diagnostics.events.some(event=>event.kind==='cached_contact_rejected'));
  }
});

test('a job publisher cannot establish employer ownership using repeated company names or hiringOrganisation metadata',async()=>{
  const html='<meta property="og:site_name" content="Acme"><h1>Acme careers</h1><script type="application/ld+json">'+JSON.stringify({'@graph':[{'@type':'WebSite',name:'Vacancy Network'},{'@type':'JobPosting',hiringOrganization:{'@type':'Organization',name:'Acme'}}]})+'</script><p>Recruitment careers@network.org</p>';
  const result=await discoverHiringContact({company:'Acme'},{crawler:fixture({'https://network.org/':html}),search:async()=>[{url:'https://network.org/'}]});
  assert.equal(result.contact,null);assert.equal(result.outcome,'company_unverified');assert.ok(result.diagnostics.candidatesRejected>0);
});

test('published hiringOrganization sameAs leads to the real employer before any general web search',async()=>{
  const board='https://www.seek.com.au/job/77';
  const f=fixture({[board]:'<script type="application/ld+json">'+JSON.stringify({'@type':'JobPosting',hiringOrganization:{'@type':'Organization',name:'Australian Target Systems P/L',sameAs:'https://australiantargetsystems.org/'}})+'</script>',
    'https://australiantargetsystems.org/':'<h1>Australian Target Systems</h1><p>Recruitment careers@australiantargetsystems.org</p>'});
  const result=await discoverHiringContact({company:'Australian Target Systems P/L',jobUrl:board},{crawler:f,search:async()=>{throw Error('No search needed');}});
  assert.equal(hiringCompanyBrand('Australian Target Systems P/L'),'australian target systems');
  assert.equal(hiringCompanyBrand('NGSSuper Pty Ltd'),'ngs super');
  assert.equal(result.contact?.companyDomain,'australiantargetsystems.org');assert.equal(result.diagnostics.searches,0);
});

test('tracking links and slash variants cannot consume the crawl repeatedly or create a false incomplete outcome',async()=>{
  const f=fixture({'https://acme.org/':'<h1>Acme</h1><a href="/contact?utm_source=nav">Contact</a><a href="/contact?utm_source=footer">Contact</a><a href="/contact/">Contact</a><a href="/jobs/unused-123">Other vacancy</a>',
    'https://acme.org/contact?utm_source=nav':'<h1>Acme</h1><p>No hiring inbox published.</p>'});
  const result=await discoverHiringContact({company:'Acme',website:'https://acme.org/'},{crawler:f,maxPages:4});
  assert.equal(result.outcome,'no_contact');assert.equal(result.retryable,false);assert.equal(f.calls.length,2);assert.equal(result.diagnostics.unresolvedPriorityPages,0);
});

test('permanent robots denial, temporary failures and a genuine research limit have distinct outcomes',async()=>{
  const blocked=await discoverHiringContact({company:'Acme',website:'https://acme.org/'},{crawler:new PublicCrawler(async url=>response(url,'User-agent: *\nDisallow: /'))});
  assert.equal(blocked.outcome,'access_blocked');assert.equal(blocked.retryable,false);assert.equal(blocked.diagnostics.pagesBlocked,1);
  const outage=await discoverHiringContact({company:'Acme',website:'https://acme.org/'},{crawler:fixture({'https://acme.org/':response('https://acme.org/','',503)})});
  assert.equal(outage.outcome,'temporarily_unavailable');assert.equal(outage.retryable,true);assert.equal(outage.diagnostics.pagesFailed,1);
  const limited=await discoverHiringContact({company:'Acme',website:'https://acme.org/'},{maxPages:2,crawler:fixture({'https://acme.org/':'<h1>Acme</h1><a href="/contact">Contact</a>','https://acme.org/contact':'<h1>Acme</h1><a href="/team">Recruitment team</a>'})});
  assert.equal(limited.outcome,'incomplete');assert.equal(limited.retryable,true);assert.ok(limited.diagnostics.unresolvedPriorityPages>0);
});

test('an inaccessible unrelated search result does not turn a verified clean negative into a website outage',async()=>{
  const f=fixture({'https://acme.org/':'<h1>Acme</h1><p>Public company information.</p>'});
  const result=await discoverHiringContact({company:'Acme'},{crawler:{get:async url=>url.includes('directory.org')?Promise.reject(Error('Temporary network failure')):f.get(url)},search:async query=>query.includes('official company')?[{url:'https://directory.org/contact'},{url:'https://acme.org/'}]:[]});
  assert.equal(result.outcome,'no_contact');assert.equal(result.retryable,false);
});

test('role relevance rejects a named finance-only recruiter for software and finds the technology team',async()=>{
  const finance={...previous,email:'josh@acme.org',sourceText:'Josh is a recruitment consultant for the Treasury & Finance market.'};
  assert.equal(assessHiringContact(finance,'Acme','Software Engineer').reviewRequired,true);
  assert.equal(assessHiringContact({...finance,email:'careers@acme.org',sourceText:'Acme Finance recruitment enquiries careers@acme.org'},'Acme Finance','Software Engineer').reviewRequired,false,'a finance employer can hire software engineers through its general hiring inbox');
  assert.equal(assessHiringContact({...finance,email:'jane@acme.org',sourceText:'Jane, Recruitment Manager at Acme Finance. Contact Jane for applications.'},'Acme Finance','Software Engineer').reviewRequired,false,'the employer industry alone does not establish a named recruiter specialism');
  const f=fixture({'https://acme.org/':'<h1>Acme</h1><p>Josh recruitment consultant, Treasury & Finance market: josh@acme.org</p><a href="/technology/team">Technology recruitment team</a>',
    'https://acme.org/technology/team':'<h1>Acme</h1><p>Technology recruitment consultant Ellis: ellis@acme.org</p>'});
  const result=await discoverHiringContact({company:'Acme',roleTitle:'Software Engineer',website:'https://acme.org/'},{crawler:f});
  assert.equal(result.contact?.email,'ellis@acme.org');assert.ok(result.diagnostics.events.some(event=>event.kind==='contact_rejected'));
});

test('job location selects the relevant regional recruitment office without changing employer identity',async()=>{
  const f=fixture({'https://acme.org/':'<h1>Acme</h1><a href="/perth">Perth office</a><a href="/sydney">Sydney office</a>',
    'https://acme.org/perth':'<h1>Acme Recruitment</h1><p>Recruitment perth@acme.org</p>',
    'https://acme.org/sydney':'<h1>Acme Recruitment</h1><p>Recruitment sydney@acme.org</p>'});
  const result=await discoverHiringContact({company:'Acme',location:'Sydney NSW',roleTitle:'Developer',website:'https://acme.org/'},{crawler:f});
  assert.equal(result.contact?.email,'sydney@acme.org');assert.equal(f.calls.includes('https://acme.org/perth'),false);
});

test('staging sites are not current employer publishers and diagnostics do not retain query strings or exception payloads',async()=>{
  const f=fixture({'https://staging.acme.org/':'<h1>Acme</h1><p>Recruitment careers@acme.org</p>'});
  const result=await discoverHiringContact({company:'Acme',website:'https://staging.acme.org/'},{crawler:{get:async url=>{throw Error('Provider secret PRIVATE_PAYLOAD '+url);}},search:async()=>[{url:'https://staging.acme.org/'}]});
  assert.equal(result.contact,null);assert.equal(result.outcome,'company_unverified');assert.equal(f.calls.length,0);
  const failure=await discoverHiringContact({company:'Acme',website:'https://acme.org/?email=private-address'},{crawler:{get:async()=>{throw Error('PRIVATE_PAYLOAD');}}});
  assert.equal(JSON.stringify(failure.diagnostics).includes('PRIVATE_PAYLOAD'),false);assert.equal(JSON.stringify(failure.diagnostics).includes('private-address'),false);
});

test('crawler policy refusals and local request ceilings are not reported as employer access blocks',async()=>{
  for(const message of ['Page exceeds the 3 MB indexing limit.','Unsupported public page type.','Page redirect limit reached.','Destination resolved outside the public internet.']){
    const result=await discoverHiringContact({company:'Acme',website:'https://acme.org/'},{crawler:{get:async()=>{throw new CrawlBlocked(message);}}});
    assert.equal(result.outcome,'company_unverified');assert.equal(result.diagnostics.pagesBlocked,0);assert.ok(result.diagnostics.events.some(event=>event.kind==='policy_refused'));
  }
  const limit=await discoverHiringContact({company:'Acme',website:'https://acme.org/'},{crawler:new PublicCrawler(async url=>response(url,'User-agent: *\nAllow: /'),1)});
  assert.equal(limit.outcome,'incomplete');assert.equal(limit.diagnostics.pagesBlocked,0);assert.ok(limit.diagnostics.events.some(event=>event.kind==='research_limit'));
});

test('DNS and timeout failures preserve observed fault categories without claiming an employer or provider outage',async()=>{
  for(const error of [Object.assign(Error('resolver unavailable'),{code:'EAI_AGAIN'}),Object.assign(Error('request timed out'),{name:'TimeoutError'})]){
    const result=await discoverHiringContact({company:'Acme',website:'https://acme.org/'},{crawler:{get:async()=>{throw error;}}});
    assert.equal(result.outcome,'temporarily_unavailable');assert.doesNotMatch(result.reason,/employer.*down|provider.*down/i);
    assert.ok(result.diagnostics.events.some(event=>event.kind===(error.name==='TimeoutError'?'request_timeout':'dns_failure')));
  }
});

test('an explicit current-vacancy recruitment contact wins over a general company inbox once employer identity is verified',async()=>{
  const job='https://www.seek.com.au/job/88';
  const f=fixture({'https://acme.org/':'<h1>Acme</h1><p>Recruitment careers@acme.org</p>',[job]:'<h1>Acme Software Engineer</h1><p>For this vacancy contact our technology recruitment consultant Ellis at ellis@acme.org.</p>'});
  const result=await discoverHiringContact({company:'Acme',website:'https://acme.org/',jobUrl:job,roleTitle:'Software Engineer - Sydney NSW'},{crawler:f});
  assert.equal(result.contact?.email,'ellis@acme.org');assert.equal(result.contact?.sourceUrl,job);
});

test('an office named in the actual job title directs recruitment contact selection',async()=>{
  const f=fixture({'https://acme.org/':'<h1>Acme</h1><a href="/perth">Perth office</a><a href="/sydney">Sydney office</a>',
    'https://acme.org/perth':'<h1>Acme</h1><p>Recruitment perth@acme.org</p>','https://acme.org/sydney':'<h1>Acme</h1><p>Recruitment sydney@acme.org</p>'});
  const result=await discoverHiringContact({company:'Acme',roleTitle:'Software Engineer Sydney NSW',website:'https://acme.org/'},{crawler:f});
  assert.equal(result.contact?.email,'sydney@acme.org');
});

test('a WebPage about its own organisation verifies an alias domain without trusting the job publisher',async()=>{
  const html='<title>Careers at Acme | doacme.org</title><h1>Join Acme</h1><script type="application/ld+json">'+JSON.stringify({'@type':'WebPage',name:'Careers at Acme',about:{'@type':'Organization',name:'Acme',url:'https://doacme.org',contactPoint:{'@type':'ContactPoint',contactType:'Human Resources',email:'hr@doacme.org'}}})+'</script><p>Email your resume <a href="mailto:hr@doacme.org">hr@doacme.org</a></p>';
  const result=await discoverHiringContact({company:'Acme Pty Ltd',roleTitle:'Software Engineer'},{crawler:fixture({'https://doacme.org/careers':html}),search:async()=>[{url:'https://doacme.org/careers'}]});
  assert.equal(result.contact?.email,'hr@doacme.org');assert.equal(result.contact?.companyDomain,'doacme.org');assert.equal(result.contact?.sourceKind,'public_page');
  const platform='<script type="application/ld+json">'+JSON.stringify({'@graph':[{'@type':'WebSite',name:'Vacancy Network'},{'@type':'WebPage',about:{'@type':'Organization',name:'Acme',url:'https://network.org/'}}]})+'</script><h1>Acme</h1><p>Hiring? Request access hello@network.org</p>';
  assert.equal((await discoverHiringContact({company:'Acme'},{crawler:fixture({'https://network.org/':platform}),search:async()=>[{url:'https://network.org/'}]})).contact,null);
});

test('careers sources are checked before a large about/contact navigation can consume the lookup',async()=>{
  const f=fixture({'https://acme.org/':'<h1>Acme</h1>'+Array.from({length:10},(_,i)=>`<a href="/about/${i}">About our people</a>`).join('')+'<a href="/contact">Contact</a><a href="/careers">Careers</a>',
    'https://acme.org/careers':'<h1>Acme careers</h1><p>Hiring careers@acme.org</p>'});
  const result=await discoverHiringContact({company:'Acme',website:'https://acme.org/'},{crawler:f,maxPages:2});
  assert.equal(result.contact?.email,'careers@acme.org');assert.deepEqual(f.calls,['https://acme.org/','https://acme.org/careers']);
});

test('a readable current job does not regain a removed address from stale indexed excerpts',async()=>{
  const job='https://au.indeed.com/viewjob?jk=current-readable';
  const f=fixture({[job]:'<h1>Acme Software Engineer</h1><p>Apply through this page. The former email contact has been removed.</p>','https://acme.org/':'<h1>Acme</h1><p>We build software.</p>'});
  const result=await discoverHiringContact({company:'Acme',jobUrl:job,roleTitle:'Software Engineer'},{crawler:f,search:async query=>query.includes('official company')?[{url:'https://acme.org/'}]:[{url:job,title:'Acme Software Engineer',description:'Send resumes to careers@acme.org'}]});
  assert.equal(result.contact,null);assert.equal(result.outcome,'no_contact');
});

test('the pronoun it does not establish a technology recruiter specialism',()=>{
  const contact={...previous,email:'josh@acme.org',sourceText:'Josh specialises in the Treasury and Finance market. He understands it well.'};
  assert.equal(assessHiringContact(contact,'Acme','Software Engineer').reviewRequired,true);
  assert.equal(assessHiringContact({...contact,sourceText:'Josh specialises in IT infrastructure recruitment.'},'Acme','IT Manager').reviewRequired,false);
});

test('a dedicated experienced-careers publisher can publish its regional queries mailbox without an HR local part',async()=>{
  const url='https://careers.acme.org/go/Australia-Experienced/123/';
  const html='<title>Career Opportunities in Australia | Find Your Spark</title><meta name="description" content="Job Opportunities for Experienced Professionals | Acme Careers"><h1>Current Openings in Australia</h1><p>Acme</p><heading>Can’t Find the Job of Your Choice?</heading><p>For queries, email to:<a href="mailto:acme.au@acme.org">acme.au@acme.org</a></p>';
  const f=fixture({[url]:html});
  const result=await discoverHiringContact({company:'Acme',roleTitle:'Senior Technical Specialist',location:'Sydney NSW'},{crawler:f,search:async()=>[{url:'https://acme.org/'},{url,title:'Career Opportunities in Australia'}]});
  assert.equal(result.contact?.email,'acme.au@acme.org');assert.equal(result.contact?.sourceKind,'public_page');assert.deepEqual(f.calls,[url]);
  assert.match(result.contact!.sourceText,/Careers enquiries/);
  assert.deepEqual(publishedHiringContacts('<title>Acme products</title><p>For queries: acme.au@acme.org</p>','https://acme.org/products','acme.org',true),[]);
});

test('a regional named page binds a legal employer to its actual parent-brand publisher without trusting a platform',async()=>{
  const url='https://acmegroup.org/au-en';
  const owner={'@type':'Organization','@id':`${url}#organization`,name:'Acme Insurance',legalName:'Acme Pacific Holdings Pty Ltd',url};
  const structured={'@type':'WebPage',name:'Acme Insurance Brokers Australia - Homepage',url,about:{'@id':owner['@id']},isPartOf:{'@type':'WebSite',name:'Acme Insurance (AU)',url,publisher:owner}};
  const html=`<title>Acme Australia - Local Insurance Brokers</title><script type="application/ld+json">${JSON.stringify(structured)}</script><p>Acme Insurance Brokers Australia</p><p>HR queries hraustralia@acmegroup.org</p>`;
  const result=await discoverHiringContact({company:'Acme Insurance Brokers (Australia)'},{crawler:fixture({[url]:html}),search:async()=>[{url}]});
  assert.equal(result.contact?.email,'hraustralia@acmegroup.org');
  const platform=JSON.stringify({...structured,isPartOf:{'@type':'WebSite',name:'Vacancy Directory',url,publisher:{...owner,name:'Vacancy Directory'}}});
  const bad=await discoverHiringContact({company:'Acme Insurance Brokers Australia'},{crawler:fixture({[url]:`<script type="application/ld+json">${platform}</script><h1>Acme Insurance Brokers Australia</h1><p>Hiring enquiries hello@acmegroup.org</p>`}),search:async()=>[{url}]});
  assert.equal(bad.contact,null);assert.equal(bad.outcome,'company_unverified');
});

test('office products and cookie or audience navigation do not consume a careers lookup or create false pending HR pages',async()=>{
  const f=fixture({'https://acme.org/careers':'<h1>Careers at Acme</h1><p>Join our team.</p>'+['office-meals','office-catering','office-kitchen','office-event-popups-and-workplace-activations','how/esg-office-catering','for-you/office-managers','melbourne-cup-catering','cookie-preferences'].map(path=>`<a href="/${path}">${path.replace(/-/g,' ')}</a>`).join('')});
  const result=await discoverHiringContact({company:'Acme',website:'https://acme.org/careers',location:'Sydney NSW'},{crawler:f,maxPages:4});
  assert.deepEqual(f.calls,['https://acme.org/careers']);assert.equal(result.outcome,'no_contact');assert.equal(result.diagnostics.unresolvedPriorityPages,0);
});

test('escaped quote wrappers are removed before resolving a published careers link',async()=>{
  const f=fixture({'https://acme.org/':'<h1>Acme</h1><a href="\\&quot;/careers\\&quot;">Careers</a>','https://acme.org/careers':'<h1>Acme careers</h1><p>Hiring careers@acme.org</p>'});
  const result=await discoverHiringContact({company:'Acme',website:'https://acme.org/'},{crawler:f});
  assert.equal(result.contact?.email,'careers@acme.org');assert.deepEqual(f.calls,['https://acme.org/','https://acme.org/careers']);assert.doesNotMatch(JSON.stringify(result.diagnostics),/%22/);
});

test('agency identity does not promote an unrelated competition mailbox, but an official jobseeker contact remains valid',()=>{
  const footy='<title>Acme IT Recruitment</title><h1>Footy tipping competition</h1><p>For the competition password contact acmemarketing@acme.org</p><a href="/careers">Careers</a>';
  assert.deepEqual(publishedHiringContacts(footy,'https://acme.org/footy-tipping','acme.org',true),[]);
  const old={...previous,email:'acmemarketing@acme.org',sourceText:'Footy tipping competition password: contact acmemarketing@acme.org'};
  assert.equal(assessHiringContact(old,'Acme','Software Engineer').reviewRequired,true);
  const contact='<title>Contact us | Acme IT Recruitment Agency</title><h1>Connect With Our Team</h1><p>Whether you’re hiring or looking for your next role, our local experts are here to help.</p><div>Get In Touch acmemarketing@acme.org</div>';
  const found=publishedHiringContacts(contact,'https://acme.org/contact-us','acme.org',true);
  assert.equal(found[0]?.email,'acmemarketing@acme.org');assert.doesNotMatch(found[0]!.sourceText,/footy/i);
});

test('stored exact-vacancy contact preserves its observation date and never overrides a readable newer job page',async()=>{
  const job='https://www.seek.com.au/job/991',observed='2026-11-15T12:00:00.000Z';
  const input={company:'Acme',website:'https://acme.org/',jobUrl:job,roleTitle:'Software Engineer',jobDescription:'For this software vacancy contact our technology recruitment consultant Ellis at ellis@acme.org.',jobDescriptionObservedAt:observed};
  const home='<h1>Acme</h1><p>Recruitment careers@acme.org</p>';
  const result=await discoverHiringContact(input,{crawler:fixture({'https://acme.org/':home}),now:()=>now});
  assert.equal(result.contact?.email,'ellis@acme.org');assert.equal(result.contact?.sourceKind,'stored_vacancy');assert.equal(result.contact?.sourceUrl,job);assert.equal(result.contact?.validatedAt,observed);
  const fresh=await discoverHiringContact(input,{crawler:fixture({'https://acme.org/':home,[job]:'<h1>Acme</h1><p>This vacancy no longer publishes a personal email. Apply here.</p>'}),now:()=>now});
  assert.equal(fresh.contact?.email,'careers@acme.org');assert.equal(fresh.contact?.sourceKind,'public_page');
  const undated=await discoverHiringContact({...input,jobDescriptionObservedAt:undefined},{crawler:fixture({'https://acme.org/':home}),now:()=>now});
  assert.equal(undated.contact?.email,'careers@acme.org');
});

test('an observed masked HR domain can corroborate a legal trade brand but can never become an email address',async()=>{
  const job='https://www.seek.com.au/job/992';
  const f=fixture({'https://acmegroup.org/':'<title>Acme Australia</title><h1>Acme</h1><p>Acme Insurance Brokers Australia</p><p>Recruitment hr@acmegroup.org</p>'});
  const result=await discoverHiringContact({company:'Acme Insurance Brokers Australia',jobUrl:job,jobDescription:'Our Human Resources team: ••••@acmegroup.org',jobDescriptionObservedAt:now.toISOString()},{crawler:f,now:()=>now});
  assert.equal(result.contact?.email,'hr@acmegroup.org');assert.equal(result.contact?.sourceKind,'public_page');assert.ok(!result.contact?.email.includes('•'));
  const unrelated=await discoverHiringContact({company:'Acme Insurance Brokers Australia',jobUrl:job,jobDescription:'Our Human Resources team: ••••@platform.org',jobDescriptionObservedAt:now.toISOString()},{crawler:fixture({'https://platform.org/':'<title>Vacancy Directory</title><h1>Acme Insurance Brokers Australia jobs</h1><p>HR hr@platform.org</p>'}),now:()=>now});
  assert.equal(unrelated.contact,null);
  assert.deepEqual(publishedHiringContacts('<h1>Acme Careers</h1><p>Human Resources: ****@acme.org</p><p>Recruitment ••••@acme.org</p>','https://acme.org/careers','acme.org',true),[]);
});

test('regional cache reuse honours the actual job location while national recruitment inboxes remain reusable',async()=>{
  const sydney={...previous,email:'sydney@acme.org',sourceUrl:'https://acme.org/sydney'};
  assert.equal(await canReuseHiringContact('Acme Australia NSW','https://acme.org/careers',sydney,{location:'Perth WA'}),false);
  assert.equal(await canReuseHiringContact('Acme Australia NSW','https://acme.org/careers',previous,{location:'Perth WA'}),true);
  const f=fixture({'https://acme.org/':'<h1>Acme</h1><a href="/sydney">Sydney office</a><a href="/perth">Perth office</a>','https://acme.org/perth':'<h1>Acme</h1><p>Recruitment perth@acme.org</p>'});
  const result=await discoverHiringContact({company:'Acme Australia NSW',location:'Perth WA',website:'https://acme.org/'},{crawler:f});
  assert.equal(result.contact?.email,'perth@acme.org');assert.equal(f.calls.includes('https://acme.org/sydney'),false);
});

test('a known Australian job reaches the regional careers page ahead of global catalogues and locale copies',async()=>{
  const home='https://careers.acme.org/',local='https://careers.acme.org/go/Australia-Experienced/123/';
  const f=fixture({[home]:'<title>Acme Careers</title><h1>Acme</h1><a href="/?locale=de_DE">Deutsch</a><a href="/?locale=en_US">English</a><a href="https://www.careers.acme.org/?locale=fr_FR">Français</a><a href="/jobs/">All jobs</a><a href="https://acme.org/careers">Global careers</a><a href="/go/Australia-Experienced/123/">Australia Experienced</a>',
    [local]:'<title>Career Opportunities in Australia | Acme Careers</title><h1>Current Openings in Australia</h1><p>For queries, email to:<a href="mailto:acme.au@acme.org">acme.au@acme.org</a></p>'});
  const queries:string[]=[];
  const result=await discoverHiringContact({company:'Acme',roleTitle:'Technical Specialist',location:'Sydney NSW'},{crawler:f,maxPages:4,search:async query=>{queries.push(query);return [{url:home,title:'Acme global careers'}];}});
  assert.equal(result.contact?.email,'acme.au@acme.org');assert.deepEqual(f.calls,[home,local]);assert.match(queries[0],/Australia/);
});

test('regional delivery areas and supplier partner pages cannot masquerade as recruitment offices',async()=>{
  const f=fixture({'https://acme.org/careers':'<title>Acme Careers</title><h1>Acme</h1><p>Join our team</p><a href="/locations/countries/australia/cities/sydney">Sydney</a><a href="/partner/foodlab-sydney">Foodlab Sydney</a><a href="/partner/little-caterer-sydney">Sydney office catering</a><a href="/get-a-quote">Contact our team for a quote</a><a href="/discover-at-work">Discover our workplace partners</a>'});
  const result=await discoverHiringContact({company:'Acme',website:'https://acme.org/careers',location:'Sydney NSW'},{crawler:f,maxPages:4});
  assert.deepEqual(f.calls,['https://acme.org/careers']);assert.equal(result.outcome,'no_contact');assert.equal(result.diagnostics.unresolvedPriorityPages,0);
});

test('a confirmed nonexistent mailbox cannot be reused from a fresh cache or renewed from its still-published source',async()=>{
  assert.equal(await canReuseHiringContact('Acme','https://acme.org/careers',previous,{excludedEmails:[' CAREERS@ACME.ORG ']}),false);
  const f=fixture({'https://acme.org/careers':'<h1>Acme careers</h1><p>Recruitment careers@acme.org</p><p>Our recruitment manager accepts CVs at jane@acme.org.</p>'});
  const result=await discoverHiringContact({company:'Acme',previous,excludedEmails:['CAREERS@ACME.ORG']},{crawler:f,now:()=>now});
  assert.equal(result.contact?.email,'jane@acme.org');assert.deepEqual(f.calls,[previous.sourceUrl]);
  assert.ok(result.diagnostics.events.some(event=>event.kind==='contact_suppressed'));
});

test('suppression filters direct public contacts and keeps looking for a different published inbox',async()=>{
  const f=fixture({'https://acme.org/':'<h1>Acme</h1><p>Recruitment careers@acme.org</p><a href="/careers">Careers</a>','https://acme.org/careers':'<h1>Acme careers</h1><p>Recruitment talent@acme.org</p>'});
  const result=await discoverHiringContact({company:'Acme',website:'https://acme.org/',excludedEmails:['careers@acme.org']},{crawler:f});
  assert.equal(result.contact?.email,'talent@acme.org');assert.equal(result.contact?.sourceUrl,'https://acme.org/careers');
});

test('stored exact-vacancy and indexed exact-job contacts cannot restore a known nonexistent mailbox',async()=>{
  const job='https://www.seek.com.au/job/993';
  const common={company:'Acme',website:'https://acme.org/',jobUrl:job,excludedEmails:['careers@acme.org']};
  const home='<h1>Acme</h1><p>We build software.</p>';
  const stored=await discoverHiringContact({...common,jobDescription:'Recruitment careers@acme.org. For this vacancy send CVs to hiring@acme.org.',jobDescriptionObservedAt:now.toISOString()},{crawler:fixture({'https://acme.org/':home}),now:()=>now});
  assert.equal(stored.contact?.email,'hiring@acme.org');assert.equal(stored.contact?.sourceKind,'stored_vacancy');
  const indexed=await discoverHiringContact(common,{crawler:fixture({'https://acme.org/':home}),search:async()=>[{url:job,title:'Acme Software Engineer',description:'Recruitment careers@acme.org. Send CVs to talent@acme.org.'}]});
  assert.equal(indexed.contact?.email,'talent@acme.org');assert.equal(indexed.contact?.sourceKind,'indexed_excerpt');
});

test('external public pages and attributed profile excerpts respect suppression without blocking a different published contact',async()=>{
  const profile='https://www.linkedin.com/company/acme';
  for(const blocked of [false,true]){
    const f=fixture({'https://acme.org/':'<h1>Acme</h1><p>We build software.</p>',[profile]:blocked?response(profile,'',403):'<h1>Acme</h1><p>Recruitment careers@acme.org. Send CVs to talent@acme.org.</p>'});
    const result=await discoverHiringContact({company:'Acme',website:'https://acme.org/',excludedEmails:['careers@acme.org']},{crawler:f,search:async()=>[{url:profile,title:'Acme',description:'Recruitment careers@acme.org. Send CVs to talent@acme.org.'}]});
    assert.equal(result.contact?.email,'talent@acme.org');assert.equal(result.contact?.sourceKind,blocked?'indexed_excerpt':'public_page');
  }
});

test('a still-published suppressed address alone produces no contact and is never an invented domain replacement',async()=>{
  const f=fixture({'https://acme.org/':'<h1>Acme</h1><p>Recruitment careers@acme.org</p>'});
  const result=await discoverHiringContact({company:'Acme',website:'https://acme.org/',excludedEmails:['careers@acme.org']},{crawler:f});
  assert.equal(result.contact,null);assert.equal(result.outcome,'no_contact');assert.ok(result.diagnostics.candidatesRejected>0);
});

test('an invalid primary inbox leads to bounded regional recruiter research with attributed public CV evidence',async()=>{
  const post='https://www.linkedin.com/posts/jane-recruiter_hiring-technology-activity-123456789-test';
  const f=fixture({'https://acme.org/':'<h1>Acme</h1><p>Recruitment careers@acme.org</p>',[post]:response(post,'',403)});
  const queries:string[]=[];
  const result=await discoverHiringContact({company:'Acme',roleTitle:'Software Engineer',location:'Sydney NSW',website:'https://acme.org/',excludedEmails:['careers@acme.org']},{crawler:f,search:async query=>{queries.push(query);return [{url:post,title:'Jane Recruiter | Acme hiring',description:'Acme is hiring technology integration engineers. Candidates anywhere in Australia may apply. Send your CV to jane@acme.org.'}];}});
  assert.equal(result.contact?.email,'jane@acme.org');assert.equal(result.contact?.sourceKind,'indexed_excerpt');assert.equal(result.contact?.sourceUrl,post);
  assert.match(queries[0],/Australia technology recruitment.*CV/);assert.ok(queries.length<=3);assert.doesNotMatch(queries.join(' '),/careers@acme.org/);
});

test('a blocked public post needs attributable employer, explicit CV invitation, matching domain and region',async()=>{
  const post='https://www.linkedin.com/posts/jane-recruiter_hiring-activity-123456789-test';
  for(const description of ['Other Company in Australia. Send CVs to jane@acme.org.','Acme company news: jane@acme.org is speaking at a conference in Australia.','Acme in Australia is hiring. Send CVs to jane@unrelated.org.','Acme in India is hiring. Send CVs to jane@acme.org.']){
    const result=await discoverHiringContact({company:'Acme',roleTitle:'Software Engineer',location:'Sydney NSW',website:'https://acme.org/',excludedEmails:['careers@acme.org']},{crawler:fixture({'https://acme.org/':'<h1>Acme</h1><p>We build software.</p>',[post]:response(post,'',403)}),search:async()=>[{url:post,title:'Recruiter post',description}]});
    assert.equal(result.contact,null,description);
  }
});

test('a dead primary inbox yields its remaining page budget to alternative recruitment evidence',async()=>{
  const post='https://www.linkedin.com/posts/jane-recruiter_hiring-activity-123456789-test';
  const f=fixture({'https://acme.org/':'<h1>Acme</h1><p>Recruitment careers@acme.org</p>'+Array.from({length:20},(_,i)=>`<a href="/careers/country-${i}">Country careers ${i}</a>`).join(''),[post]:response(post,'',403)});
  const result=await discoverHiringContact({company:'Acme',location:'Sydney NSW',website:'https://acme.org/',excludedEmails:['careers@acme.org']},{crawler:f,maxPages:4,search:async()=>[{url:post,title:'Acme recruiter',description:'Acme is hiring engineers in Australia. Send your CV to jane@acme.org.'}]});
  assert.equal(result.contact?.email,'jane@acme.org');assert.deepEqual(f.calls,['https://acme.org/',post]);
});

test('alternative lookup verifies one company page and targets primary regional recruiter posts with or without a source hint',async()=>{
  const source='https://careers.acme.org/go/Australia/1/',post='https://www.linkedin.com/posts/jane-recruiter_hiring-activity-123456789-test';
  for(const hinted of [false,true]){
    const f=fixture({[source]:'<title>Acme Careers</title><h1>Acme</h1><p>Recruitment careers@acme.org</p>'+Array.from({length:20},(_,i)=>`<a href="/careers/country-${i}">Global careers ${i}</a>`).join(''),[post]:response(post,'',403)});
    const queries:string[]=[];
    const result=await discoverHiringContact({company:'Acme',roleTitle:'Technical Specialist',location:'Sydney NSW',website:hinted?source:undefined,excludedEmails:['careers@acme.org']},{crawler:f,maxPages:4,search:async query=>{queries.push(query);return query.includes('official company')?[{url:source,title:'Acme Careers Australia'}]:[{url:'https://irrelevant.org/blog/how-to-apply',title:'CV advice'},{url:post,title:'Acme recruiter',description:'Acme Australia is hiring technology integration engineers. Send your CV to jane@acme.org.'}];}});
    assert.equal(result.contact?.email,'jane@acme.org');assert.deepEqual(f.calls,[source,post]);assert.ok(queries.length<=3);assert.ok(queries.some(query=>/site:linkedin.com\/posts/.test(query)));
  }
});

test('a global suppression for another employer does not change normal company discovery or queries',async()=>{
  const f=fixture({'https://acme.org/':'<h1>Acme</h1><a href="/careers">Careers</a>','https://acme.org/careers':'<h1>Acme</h1><p>Recruitment talent@acme.org</p>'});
  const queries:string[]=[];
  const result=await discoverHiringContact({company:'Acme',excludedEmails:['dead@othercompany.org']},{crawler:f,search:async query=>{queries.push(query);return [{url:'https://acme.org/'}];}});
  assert.equal(result.contact?.email,'talent@acme.org');assert.equal(queries.length,1);assert.match(queries[0],/official company careers contact/);assert.doesNotMatch(queries[0],/site:linkedin/);
});

test('a suppressed previous contact can lead to current company proof and an alternate without repeating the global homepage',async()=>{
  const post='https://www.linkedin.com/posts/jane-recruiter_hiring-activity-123456789-test';
  const f=fixture({[previous.sourceUrl]:'<title>Acme careers</title><h1>Acme</h1><p>Recruitment careers@acme.org</p>',[post]:response(post,'',403)});
  const result=await discoverHiringContact({company:'Acme',previous,website:previous.sourceUrl,excludedEmails:['careers@acme.org'],location:'Sydney NSW'},{crawler:f,search:async()=>[{url:post,title:'Acme recruitment',description:'Acme Australia is hiring. Send your CV to jane@acme.org.'}]});
  assert.equal(result.contact?.email,'jane@acme.org');assert.deepEqual(f.calls,[previous.sourceUrl,post]);
});

test('a primary recruiter profile can corroborate an Australian technical CV invitation while preserving indexed provenance',async()=>{
  const profile='https://au.linkedin.com/in/jane-recruiter';
  const f=fixture({'https://acme.org/':'<h1>Acme</h1><p>Recruitment careers@acme.org</p>',[profile]:response(profile,'',403)});
  const result=await discoverHiringContact({company:'Acme',roleTitle:'Senior Technical Specialist',location:'Sydney NSW',website:'https://acme.org/',excludedEmails:['careers@acme.org']},{crawler:f,search:async()=>[{url:profile,title:'Jane Recruiter - Acme Australia | LinkedIn',description:'Talent Acquisition Specialist at Acme Australia, Human Resources management.',extra_snippets:['Acme is hiring technology integration engineers anywhere in Australia. Send your CV to jane@acme.org.','We are also hiring AI engineers in Sydney.']}]});
  assert.equal(result.contact?.email,'jane@acme.org');assert.equal(result.contact?.sourceUrl,profile);assert.equal(result.contact?.sourceKind,'indexed_excerpt');
});

test('another employer or a sidebar recommendation does not establish recruiter profile ownership',async()=>{
  const profile='https://www.linkedin.com/in/jane-recruiter';
  for(const title of ['Jane Recruiter - Other Company | LinkedIn','Jane Acme - Other Company | LinkedIn']){
    const result=await discoverHiringContact({company:'Acme',roleTitle:'Software Engineer',location:'Sydney NSW',website:'https://acme.org/',excludedEmails:['careers@acme.org']},{crawler:fixture({'https://acme.org/':'<h1>Acme</h1><p>Recruitment careers@acme.org</p>',[profile]:response(profile,'',403)}),search:async()=>[{url:profile,title,description:'Talent Acquisition Specialist @ Acme shown under others you may know.',extra_snippets:['Acme Australia is hiring. Send your CV to jane@acme.org.']}]});
    assert.equal(result.contact,null,title);
  }
});

test('an alternate technical recruiter query preserves a company brand spelling when no legal suffix was removed',async()=>{
  const f=fixture({'https://acmetech.org/':'<h1>AcmeTech</h1><p>Recruitment careers@acmetech.org</p>'}),queries:string[]=[];
  await discoverHiringContact({company:'AcmeTech',website:'https://acmetech.org/',location:'Sydney NSW',excludedEmails:['careers@acmetech.org']},{crawler:f,search:async query=>{queries.push(query);return [];}});
  assert.match(queries[0],/"AcmeTech"/);assert.doesNotMatch(queries[0],/"acme tech"/);
  assert.equal(assessHiringContact({...previous,email:'jane@acme.org',sourceText:'Recruitment consultant Jane specialises in the Treasury & Finance market.'},'Acme','Senior Technical Specialist').reviewRequired,true);
});
