import assert from 'node:assert/strict';
import { assertExternalJobUrl } from './external-url.js';

await assert.rejects(() => assertExternalJobUrl('file:///etc/passwd'), /must use HTTPS/);
await assert.rejects(() => assertExternalJobUrl('https://localhost/job/1'), /not a public website/);
await assert.rejects(() => assertExternalJobUrl('https://127.0.0.1/job/1'), /does not resolve only to public/);
for (const host of ['jobs.nsw.gov.au', 'careers.health.qld.gov.au', 'www.apsjobs.gov.au']) {
  const url = `https://${host}/job/1`;
  assert.equal(await assertExternalJobUrl(url, async (hostname) => hostname === host), url);
  await assert.rejects(() => assertExternalJobUrl(url, async () => false), /does not resolve only to public/);
}
await assert.rejects(() => assertExternalJobUrl('https://www.seek.com.au/job/12345678'), /cannot target a SEEK or Indeed listing/);
await assert.rejects(() => assertExternalJobUrl('https://careers.example.com/checkout'), /Payment pages cannot/);

console.log('direct external navigation checks passed');
