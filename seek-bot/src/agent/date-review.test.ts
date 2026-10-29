import assert from 'node:assert/strict';
import test from 'node:test';
import { DateReview } from './date-review.js';
import type { Observation } from './observe.js';

const page = (month = '1', day = '11'): Observation => ({ url: 'https://employer.invalid/apply', title: 'Form', actions: [], text: '',
  fields: [{ ref: 'f0', label: 'Month', section: 'Available start date', hints: 'start-month', required: true, kind: 'text', currentValue: month },
    { ref: 'f1', label: 'Day', section: 'Available start date', hints: 'start-day', required: true, kind: 'text', currentValue: day }] });

test('date review preserves actual components across pages and invalidates after correction', () => {
 const review = new DateReview(); review.observe(page());
 assert.equal(review.request(), true);
 assert.match(review.render(), /"label":"Month".*"value":"1"/);
 review.record('correct'); assert.equal(review.request(), true, 'correction is not a ready judgment');
 review.record('ready'); review.observe({ ...page(), fields: [] });
 assert.equal(review.request(), false, 'leaving a wizard page retains the reviewed evidence');
 review.observe(page('11','1')); assert.equal(review.request(), true, 'changed components need fresh assessment');
 review.record('ready'); review.invalidate(); assert.equal(review.request(), true, 'batch mutations cannot reuse an earlier judgment');
});

test('unknown optional date components remain blank; credentials never enter evidence', () => {
 const review = new DateReview(); review.observe({ ...page(), fields: [
   { ...page().fields[0], currentValue: '' },
   { ...page().fields[1], label: 'Password date', inputType: 'password', currentValue: 'private-fixture', sensitive: true },
 ] });
 assert.match(review.render(), /"value":""/); assert.doesNotMatch(review.render(), /private-fixture/);
 const ordinary = new DateReview(); ordinary.observe({ ...page(), fields: [{ ...page().fields[0], label: 'City', hints: 'city' }] });
 assert.equal(ordinary.request(), false, 'non-date forms need no extra review');
});
