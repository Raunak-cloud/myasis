import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';
import type { ToolContext } from './tools/context.js';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-letter-layout-'));
Object.assign(process.env, { DATA_DIR: directory, APPLICATION_AI_MODEL: 'haiku', ANTHROPIC_API_KEY: 'fixture-only', COST_TRACKING: 'false', HUMANIZER_MODE: 'off' });
const paragraphs = ['Dear Hiring Team,', 'I have four years of customer service experience, including payments and careful record keeping.', 'I would welcome the chance to bring those skills to Example Shop.', 'Kind regards,\nSynthetic Applicant'];
const dense = paragraphs.join(' ').replace(/\n/g, ' ');
const formatted = paragraphs.join('\n\n');
const realFetch = globalThis.fetch;
globalThis.fetch = (async (_url, init) => {
  const prompt = JSON.stringify(JSON.parse(String(init?.body)).messages);
  const result = prompt.includes('Check factual claims in this letter') ? { supported: true, reason: 'Synthetic evidence supports the letter.' }
    : prompt.includes('FORMAT COVER LETTER ONLY') ? { paragraphs }
      : { letter: dense };
  return Response.json({ content: [{ type: 'text', text: JSON.stringify(result) }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } });
}) as typeof fetch;
const { doAddCoverLetter } = await import('./tools/documents.js');
const { recordWhatWasSent } = await import('./tools/gate.js');
const { observe } = await import('./observe.js');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
try {
  const page = await browser.newPage();
  let flatten = false;
  await page.route('https://letter.fixture.invalid/**', route => route.fulfill({ contentType: 'text/html', body: `<main><label>Cover letter<textarea ${flatten ? 'oninput="this.value=this.value.replace(/\\s+/g,\' \')"' : ''}></textarea></label><button>Submit application</button></main>` }));
  const context = async (id: string): Promise<ToolContext> => {
    await page.goto('https://letter.fixture.invalid/application');
    return { page, job: { id, title: 'Customer Service Assistant', company: 'Example Shop', location: 'Sydney', url: page.url() },
      profile: { name: 'Synthetic Applicant', email: 'synthetic@example.test', phone: '', nationality: '', expectedSalary: '', noticePeriod: '', willingToRelocate: false, experienceSummary: 'Four years in customer service, payments and record keeping.', skills: [], excludedDomains: [], securityClearance: '' },
      observation: await observe(page), captured: [], actions: [], guards: { recordFillSuccess: () => {} }, log: () => {} } as unknown as ToolContext;
  };
  let ctx = await context('layout-kept');
  let result = await doAddCoverLetter(ctx, { ref: ctx.observation.fields[0].ref });
  assert.ok(result.kind === 'ok' && /Cover letter verified/.test(result.message));
  assert.equal(await page.locator('textarea').inputValue(), formatted, 'actual employer field retains greeting, body paragraphs and closing');
  ctx.coverLetter = dense;
  await recordWhatWasSent(ctx);
  assert.equal(ctx.coverLetter, formatted, 'the application history retains the exact paragraphs on the form');
  flatten = true;
  ctx = await context('layout-stripped');
  result = await doAddCoverLetter(ctx, { ref: ctx.observation.fields[0].ref });
  assert.ok(result.kind === 'ok' && /not accepted.*paragraph breaks/.test(result.message), 'a form that strips paragraphs is not reported as a successful formatted write');
  assert.equal(ctx.coverLetter, undefined);
  console.log('PASS: Haiku paragraph-only repair, actual textarea layout, exact sent record and editor-flattening detection; synthetic form only.');
} finally {
  globalThis.fetch = realFetch;
  await browser.close();
  rmSync(directory, { recursive: true, force: true });
}
