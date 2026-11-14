import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { chromium } from 'patchright';
import { withApplicationModel } from '../application-model.js';
import type { CandidateProfile } from '../types.js';
import { ordinaryFieldGuidance } from './ordinary-field-guidance.js';
import { doCompleteAuthentication } from './authentication.js';
import type { ToolContext } from './context.js';
import { observe } from './observe.js';

test('ordinary controls receive only advice for their observed type, without candidate answers', () => {
  const city = ordinaryFieldGuidance({ label: 'City', kind: 'text', inputType: 'text' });
  assert.match(city, /browser_fill and value/);
  assert.doesNotMatch(city, /upload|file_ids|set_input_files|authentication/);
  assert.match(ordinaryFieldGuidance({ label: 'Country', kind: 'select' }), /action="select" and value/);
  assert.match(ordinaryFieldGuidance({ label: 'Country', kind: 'text', inputType: 'select-one' }), /action="select" and value/);
  assert.match(ordinaryFieldGuidance({ label: 'City', kind: 'text', autocomplete: true }), /browser_fill.*click the matching suggested option/);
  assert.match(ordinaryFieldGuidance({ label: 'Resume', kind: 'text', inputType: 'file' }), /browser_upload and file_ids, an array/);
  assert.doesNotMatch(ordinaryFieldGuidance({ label: 'Resume', kind: 'text', inputType: 'file' }), /\bfile_id\b/);
  assert.match(ordinaryFieldGuidance({ label: 'Consent', kind: 'checkbox' }), /action="check"/);
  assert.match(ordinaryFieldGuidance({ label: 'Consent', kind: 'text', inputType: 'checkbox' }), /action="check"/);
  assert.match(ordinaryFieldGuidance({ label: 'Save experience', kind: 'text', inputType: 'button' }), /browser_click/);
});

test('the actual private-fill misuse on City, Country and Resume changes no form values and gives specific feedback', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'owtomate-field-guidance-'));
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
  const page = await browser.newPage();
  await page.route('**/*', route => new URL(route.request().url()).hostname.endsWith('.invalid')
    ? route.fulfill({ contentType: 'text/html', body: '<main><h1>Job application</h1><label>City<input id=city></label><label>Country<select id=country><option value="">Choose</option><option>Australia</option></select></label><label>Resume<input id=cv type=file></label><button onclick="window.clicked=true">Continue</button></main>' })
    : route.abort());
  try {
    await withApplicationModel({ DATA_DIR: directory }, async () => {
      await page.goto('https://application.fixture.invalid/apply');
      const profile = { name: 'Alex Fixture', email: 'alex@fixture.invalid', phone: '0400000000' } as CandidateProfile;
      for (const [selector, expected, unrelated] of [['#city', /browser_fill and value/, /upload|file_ids/], ['#country', /action="select" and value/, /upload|file_ids/], ['#cv', /browser_upload and file_ids/, /\bfile_id\b/]] as const) {
        const ctx = { page, profile, job: { id: 'guidance', title: 'Analyst', company: 'Fictional Employer' }, observation: await observe(page), actions: [], captured: [], log: () => {} } as unknown as ToolContext;
        const result = await doCompleteAuthentication(ctx, { purpose: 'sign_in', reason: 'Replay the observed wrong-tool call', targets: [{ selector }] });
        assert.equal(result.kind, 'ok');
        if (result.kind !== 'ok') throw Error('Expected feedback');
        assert.equal(result.disposition, 'failed');
        assert.match(result.message, expected);
        assert.doesNotMatch(result.message, unrelated);
        assert.doesNotMatch(result.message, /alex@fixture.invalid|0400000000|private-native/);
        assert.equal(ctx.actions.length, 0);
      }
      assert.equal(await page.locator('#city').inputValue(), '');
      assert.equal(await page.locator('#country').inputValue(), '');
      assert.equal(await page.locator('#cv').evaluate(node => (node as HTMLInputElement).files?.length), 0);
      assert.equal(await page.evaluate(() => (window as unknown as { clicked?: boolean }).clicked === true), false);
    });
  } finally {
    await browser.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'owtomate-field-guidance-'));
    rmSync(directory, { recursive: true, force: true });
  }
});
