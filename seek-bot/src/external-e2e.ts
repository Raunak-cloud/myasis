import './rehearsal-env.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'patchright';
import type { CandidateProfile, JobListing } from './types.js';

// This is deliberately a local fake employer site. It proves that the bot can
// leave SEEK, advance a multi-page flow, and stop before the irreversible
// submit without transmitting any real candidate data.
process.env.ALLOW_EXTERNAL_APPLY = 'true';

const listing = `<!doctype html><html><body>
  <h1>Fixture Software Engineer</h1>
  <a data-automation="job-detail-apply" href="/external/start">Apply</a>
</body></html>`;

const start = `<!doctype html><html><body>
  <main><h1>Employer application</h1>
    <button onclick="location.href='/external/review'">Continue</button>
  </main>
</body></html>`;

const review = `<!doctype html><html><body>
  <main><h1>Review your application</h1>
    <p>Your application is ready for submission.</p>
    <button onclick="location.href='/external/success'">Submit application</button>
  </main>
</body></html>`;

const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (request.url === '/job/test') response.end(listing);
  else if (request.url === '/external/start') response.end(start);
  else if (request.url === '/external/review') response.end(review);
  else if (request.url === '/external/success') response.end('<h1>Application submitted</h1>');
  else { response.statusCode = 404; response.end('Not found'); }
});

await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const port = (server.address() as AddressInfo).port;
const baseUrl = `http://127.0.0.1:${port}`;

const profile: CandidateProfile = {
  name: 'Test Candidate',
  nationality: 'Not stated',
  phone: '',
  email: '',
  expectedSalary: 'Negotiable',
  noticePeriod: '2 weeks',
  willingToRelocate: false,
  experienceSummary: 'Fixture profile for a local end-to-end test.',
  skills: ['TypeScript'],
  excludedDomains: [],
  securityClearance: 'None held',
};

const job: JobListing = {
  id: 'external-fixture',
  title: 'Fixture Software Engineer',
  company: 'Local Fixture Employer',
  location: 'Sydney NSW',
  url: `${baseUrl}/job/test`,
};

const { applyToJobWithAgent: applyToJob } = await import('./agent/apply-agent.js');
const { config } = await import('./config.js');
const browser = await chromium.launch({
  executablePath: config.chromePath,
  headless: true,
  chromiumSandbox: true,
});

try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const outcome = await applyToJob(page, job, profile, { onFriction: () => {} });
  if (outcome.status !== 'rehearsed') {
    throw new Error(`Expected rehearsed, received ${JSON.stringify(outcome)}`);
  }
  if (!outcome.stoppedAt.endsWith('/external/review')) {
    throw new Error(`Rehearsal stopped on the wrong page: ${outcome.stoppedAt}`);
  }
  if (page.url().endsWith('/external/success')) {
    throw new Error('Safety failure: the fixture application was submitted.');
  }
  console.log('External application E2E: passed (redirected, advanced, submit withheld)');
} finally {
  await browser.close();
  await new Promise<void>((resolveClose, rejectClose) =>
    server.close((error) => error ? rejectClose(error) : resolveClose()),
  );
}
