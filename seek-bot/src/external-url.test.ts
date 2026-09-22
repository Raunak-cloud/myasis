import assert from 'node:assert/strict';
import { assertExternalJobUrl } from './external-url.js';

await assert.rejects(() => assertExternalJobUrl('file:///etc/passwd'), /must use HTTPS/);
await assert.rejects(() => assertExternalJobUrl('https://localhost/job/1'), /not a public website/);
await assert.rejects(() => assertExternalJobUrl('https://127.0.0.1/job/1'), /does not resolve only to public/);
await assert.rejects(() => assertExternalJobUrl('https://jobs.nsw.gov.au/job/1'), /government application sites are excluded/);
await assert.rejects(() => assertExternalJobUrl('https://www.seek.com.au/job/12345678'), /cannot target a SEEK or Indeed listing/);
await assert.rejects(() => assertExternalJobUrl('https://careers.example.com/checkout'), /Payment pages cannot/);

console.log('direct external navigation checks passed');
