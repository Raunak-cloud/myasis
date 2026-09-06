import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import type { JobListing } from './types.js';

if (process.env.CONFIRM_EXTERNAL_TEST !== 'true') {
  throw new Error('Set CONFIRM_EXTERNAL_TEST=true after the user approves transmitting application data.');
}
const targetUrl = process.env.EXTERNAL_TEST_URL;
if (!targetUrl || !/^https:\/\//i.test(targetUrl)) throw new Error('EXTERNAL_TEST_URL must be an HTTPS URL.');

// This runner can only rehearse. It deliberately overrides any inherited live
// settings so it cannot click the final employer submission control.
process.env.ALLOW_EXTERNAL_APPLY = 'true';
process.env.DRY_RUN = 'true';
process.env.REHEARSE = 'true';

const server = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><html><body>
    <h1>${process.env.EXTERNAL_TEST_TITLE ?? 'External application rehearsal'}</h1>
    <a data-automation="job-detail-apply" href="${targetUrl.replaceAll('&', '&amp;')}">Apply</a>
  </body></html>`);
});
await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const port = (server.address() as AddressInfo).port;

const { applyToJob } = await import('./apply.js');
const { config, loadProfile } = await import('./config.js');
const profile = loadProfile();
const job: JobListing = {
  id: process.env.EXTERNAL_TEST_JOB_ID ?? 'external-real-rehearsal',
  title: process.env.EXTERNAL_TEST_TITLE ?? 'External application rehearsal',
  company: process.env.EXTERNAL_TEST_COMPANY ?? 'External employer',
  location: process.env.EXTERNAL_TEST_LOCATION ?? 'Australia',
  url: `http://127.0.0.1:${port}/job/test`,
};

const browser = await chromium.launch({
  executablePath: config.chromePath,
  headless: false,
  chromiumSandbox: true,
});

try {
  const context = await browser.newContext({ locale: 'en-AU', timezoneId: 'Australia/Sydney' });
  const page = await context.newPage();
  const outcome = await applyToJob(page, job, profile, { onFriction: () => {} });
  const safeResult = outcome.status === 'rehearsed'
    ? {
        status: outcome.status,
        stoppedAt: outcome.stoppedAt,
        fieldsCompleted: outcome.answers.map((answer) => answer.question),
        coverLetterPrepared: Boolean(outcome.coverLetter),
      }
    : outcome;
  console.log(`REAL_EXTERNAL_REHEARSAL_RESULT=${JSON.stringify(safeResult)}`);
} finally {
  await browser.close();
  await new Promise<void>((resolveClose, rejectClose) =>
    server.close((error) => error ? rejectClose(error) : resolveClose()),
  );
}
