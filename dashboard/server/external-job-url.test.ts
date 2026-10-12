import assert from 'node:assert/strict';
import { validateExternalJobUrl } from './external-job-url.js';

assert.deepEqual(await validateExternalJobUrl(''), { error: 'Paste the external job URL.' });
assert.deepEqual(await validateExternalJobUrl('not a url'), { error: 'Enter a complete HTTPS job URL.' });
assert.deepEqual(await validateExternalJobUrl('http://careers.example.com/job/1'), { error: 'External job URLs must use HTTPS.' });
assert.deepEqual(await validateExternalJobUrl('https://user:pass@careers.example.com/job/1'), { error: 'External job URLs cannot contain a username or password.' });
assert.deepEqual(await validateExternalJobUrl('https://localhost/job/1'), { error: 'The external job URL must be a public website.' });
assert.deepEqual(await validateExternalJobUrl('https://127.0.0.1/job/1'), { error: 'The external job URL must resolve only to public internet addresses.' });
for (const host of ['jobs.nsw.gov.au', 'careers.health.qld.gov.au', 'www.apsjobs.gov.au']) {
  const url = `https://${host}/job/1`;
  assert.equal(await validateExternalJobUrl(url, async (hostname) => hostname === host), url);
  assert.deepEqual(await validateExternalJobUrl(url, async () => false), { error: 'The external job URL must resolve only to public internet addresses.' });
}
assert.deepEqual(await validateExternalJobUrl('https://www.seek.com.au/job/12345678'), { error: 'Use this field for an employer website, not a SEEK or Indeed listing.' });
assert.deepEqual(await validateExternalJobUrl('https://careers.example.com/payment'), { error: 'Use the job page, not a payment page.' });

console.log('external job URL checks passed');
