import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';

/**
 * A failed fill the form later takes another way stops blocking the submit;
 * nothing else does. Fixtures only.
 */
const directory = mkdtempSync(join(tmpdir(), 'owtomate-reconcile-'));
process.env.DATA_DIR = directory;
process.env.DRY_RUN = 'false';
const { RunGuards } = await import('./guards.js');
const { CostMeter } = await import('./celeris.js');
const { observe } = await import('./observe.js');

const guards = () => new RunGuards({ maxSteps: 30, maxStepsPerPage: 16, maxStuckMs: 60_000, maxTotalMs: 600_000, meter: new CostMeter(1) });
const url = 'https://www.seek.com.au/job/1/apply';
const heard = 'How did you hear about this vacancy? *';

// Refused twice, then filled through a lookup list: no longer a blocker.
let g = guards();
g.pendingFields.add(heard);
g.recordFillFailure(heard, 'The form did not accept "SEEK"');
g.recordFillFailure(heard, 'The form did not accept "SEEK"');
assert.equal(g.canSubmit(url).allowed, false, 'blocked while the field is unfilled');
assert.deepEqual(g.reconcileWithForm([{ label: heard, kind: 'text', currentValue: 'Online Recruitment Channel' }]), [heard]);
assert.equal(g.unfillable.size + g.pendingFields.size, 0, 'the refusal record is gone once the form holds an answer');

// Refused once (still pending), then filled: cleared too.
g = guards();
g.pendingFields.add(heard);
g.recordFillFailure(heard, 'not accepted');
assert.deepEqual(g.reconcileWithForm([{ label: 'How did you hear about this vacancy?  *', kind: 'text', currentValue: 'SEEK' }]), [heard], 'labels compare without spacing differences');

// Still empty, or showing a complaint: kept.
g = guards();
g.pendingFields.add(heard);
g.recordFillFailure(heard, 'not accepted');
g.recordFillFailure(heard, 'not accepted');
assert.deepEqual(g.reconcileWithForm([{ label: heard, kind: 'text', currentValue: '' }]), []);
assert.deepEqual(g.reconcileWithForm([{ label: heard, kind: 'text', currentValue: 'x', validationError: 'Choose from the list' }]), []);
assert.deepEqual(g.reconcileWithForm([{ label: 'Something else', kind: 'text', currentValue: 'x' }]), []);
assert.equal(g.canSubmit(url).allowed, false, 'an unfilled control still blocks');

// A question only the candidate can answer is never cleared by what the page holds.
g = guards();
const convictions = 'Do you have any criminal convictions? *';
g.recordUngrounded(convictions);
g.pendingFields.add(convictions);
g.recordFillFailure(convictions, 'not accepted');
assert.deepEqual(g.reconcileWithForm([{ label: convictions, kind: 'select', currentValue: 'No' }]), []);
assert.equal(g.canSubmit(url).allowed, false, 'an unanswerable question still blocks');

// A pending field nobody has failed to fill is not this method's business.
g = guards();
g.pendingFields.add(heard);
assert.deepEqual(g.reconcileWithForm([{ label: heard, kind: 'text', currentValue: 'SEEK' }]), []);

// Checkboxes count as held only when ticked.
g = guards();
const consent = 'I agree to the Privacy Statement *';
g.pendingFields.add(consent);
g.recordFillFailure(consent, 'not ticked');
assert.deepEqual(g.reconcileWithForm([{ label: consent, kind: 'checkbox', currentValue: 'false' }]), []);
assert.deepEqual(g.reconcileWithForm([{ label: consent, kind: 'checkbox', currentValue: 'true' }]), [consent]);

// On a real page: the observed value is what the lookup put there.
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : {}) });
try {
  const page = await browser.newPage();
  await page.setContent('<main><label>How did you hear about this vacancy? *<input id="h" readonly></label><button onclick="document.getElementById(\'h\').value=\'Online Recruitment Channel\'">Find...</button></main>');
  g = guards();
  g.pendingFields.add(heard);
  g.recordFillFailure(heard, 'not accepted');
  g.recordFillFailure(heard, 'not accepted');
  assert.deepEqual(g.reconcileWithForm((await observe(page)).fields), [], 'nothing chosen yet');
  await page.click('button');
  assert.deepEqual(g.reconcileWithForm((await observe(page)).fields), [heard], 'chosen through the lookup');
  console.log('PASS: failed fills the form later took are cleared; empty, invalid and candidate-only questions still block');
} finally {
  await browser.close();
  rmSync(directory, { recursive: true, force: true });
}
