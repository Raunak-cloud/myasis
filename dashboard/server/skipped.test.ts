import assert from 'node:assert/strict';
import test from 'node:test';
import { listingUrl, skipKind, skipText } from './skipped.js';

test('each fit skip is named for what decided it', () => {
  assert.equal(skipKind('Fit check (skip): Your instructions rule this out ("no senior roles"). The title says Senior.'), 'rules');
  assert.equal(skipKind('Fit check (skip): The role requires 5+ years.'), 'fit');
  assert.equal(skipKind('Fit check (uncertain): The listing does not say.'), 'uncertain');
  assert.equal(skipKind('Model match score 62 below minimum 75'), 'score');
});

test("the check's own words are shown without the log prefix", () => {
  assert.equal(skipText('Fit check (skip): The role requires 5+ years.'), 'The role requires 5+ years.');
  assert.equal(skipText('Model match score 62 below minimum 75'), 'Model match score 62 below minimum 75');
});

test('a listing address is rebuilt from the board id when an older event did not record one', () => {
  assert.equal(listingUrl('94000001', null), 'https://www.seek.com.au/job/94000001');
  assert.equal(listingUrl('abcdef0123456789', null), 'https://au.indeed.com/viewjob?jk=abcdef0123456789');
  assert.equal(listingUrl('94000001', 'https://www.seek.com.au/job/94000001?ref=x'), 'https://www.seek.com.au/job/94000001?ref=x');
  assert.equal(listingUrl('not-a-board-id', null), '');
});
