import { writeFileSync } from 'node:fs';
import { chromium } from 'patchright';
import { corpusPages, expectationOf, type FormExpectation } from './form-corpus.js';
import { observe } from './agent/observe.js';
import { hasCaptchaSurface } from './captcha/detect.js';

/**
 * Replays the recorded real employer form pages against the current code and
 * reports what it now reads differently.
 *
 *   node dist/form-replay.js <corpus dir>... [--accept]
 *
 * A regression fails the replay (exit 1): a field no longer found, a field
 * that had a real label now named by nothing useful, a security check read
 * differently, a place for a cover letter no longer seen. Other differences
 * (a label worded differently, a field newly found) are listed for a person
 * to judge; --accept records the current reading as the new expectation once
 * they have. Every page is served at its own address with every other request
 * refused, so nothing reaches an employer.
 */
const args = process.argv.slice(2);
const accept = args.includes('--accept');
const dirs = args.filter((arg) => !arg.startsWith('--'));
if (!dirs.length) {
  console.error('usage: node dist/form-replay.js <corpus dir>... [--accept]');
  process.exit(2);
}

const meaningless = (label: string) =>
  !label.trim() || label === 'unlabelled field' || /^[\s\-–—.*]*(?:none|n\/a|select|choose|please (?:select|choose)|select an option|select one|--)[\s\-–—.*]*$/i.test(label);

interface Finding { page: string; kind: 'regression' | 'change'; detail: string }

function compare(name: string, before: FormExpectation, now: FormExpectation): Finding[] {
  const findings: Finding[] = [];
  const regression = (detail: string) => findings.push({ page: name, kind: 'regression', detail });
  const change = (detail: string) => findings.push({ page: name, kind: 'change', detail });
  if (now.fields.length < before.fields.length) regression(`fields found: ${before.fields.length} → ${now.fields.length}`);
  else if (now.fields.length > before.fields.length) change(`fields found: ${before.fields.length} → ${now.fields.length}`);
  for (const [index, was] of before.fields.entries()) {
    const is = now.fields[index];
    if (!is) continue;
    if (!meaningless(was.label) && meaningless(is.label)) regression(`field ${index + 1} lost its label: "${was.label}" → "${is.label}"`);
    else if (was.label !== is.label) change(`field ${index + 1} label: "${was.label}" → "${is.label}"`);
    if (was.kind !== is.kind) regression(`field ${index + 1} ("${is.label}") kind: ${was.kind} → ${is.kind}`);
  }
  if (before.captcha !== now.captcha) regression(`security check ${before.captcha ? 'no longer seen' : 'now seen'}`);
  if (before.coverLetterOffered && !now.coverLetterOffered) regression('place for a cover letter no longer seen');
  else if (!before.coverLetterOffered && now.coverLetterOffered) change('place for a cover letter now seen');
  return findings;
}

const pages = corpusPages(dirs);
console.log(`Replaying ${pages.length} recorded employer form page(s)…`);
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
const findings: Finding[] = [];
let read = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  for (const recorded of pages) {
    const name = `${recorded.expectation.platform} · ${recorded.expectation.host}${new URL(recorded.expectation.url).pathname.slice(0, 60)}`;
    try {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await page.route('**/*', (route) => (route.request().url() === recorded.expectation.url
        ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: recorded.html })
        : route.abort()));
      await page.goto(recorded.expectation.url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      const observation = await observe(page);
      const now = expectationOf(observation, await hasCaptchaSurface(page).catch(() => false), recorded.expectation.url, recorded.expectation.capturedAt);
      findings.push(...compare(name, recorded.expectation, now));
      if (accept) writeFileSync(recorded.json, JSON.stringify(now, null, 2));
      read++;
    } catch (error) {
      findings.push({ page: name, kind: 'regression', detail: `could not be read: ${(error as Error).message.split('\n')[0].slice(0, 160)}` });
    }
  }
} finally {
  await browser.close();
}

const regressions = findings.filter((finding) => finding.kind === 'regression');
const changes = findings.filter((finding) => finding.kind === 'change');
for (const finding of [...regressions, ...changes]) console.log(`  ${finding.kind === 'regression' ? '✗' : '·'} ${finding.page}: ${finding.detail}`);
console.log(`Replayed ${read}/${pages.length}: ${regressions.length} regression(s), ${changes.length} change(s)${accept ? ' — current readings accepted as expected' : ''}.`);
process.exit(regressions.length && !accept ? 1 : 0);
