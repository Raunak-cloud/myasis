import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationReadiness } from './application-readiness.js';
import type { Observation } from './observe.js';

const page = (month = '1', day = '11'): Observation => ({ url: 'https://employer.invalid/apply', title: 'Form', actions: [], text: '',
  fields: [{ ref: 'f0', label: 'Month', section: 'Available start date', hints: 'start-month', required: true, kind: 'text', currentValue: month },
    { ref: 'f1', label: 'Day', section: 'Available start date', hints: 'start-day', required: true, kind: 'text', currentValue: day }] });

test('date review preserves actual components across pages and invalidates after correction', () => {
 const review = new ApplicationReadiness(); review.observe(page());
 assert.equal(review.request(), true);
 assert.match(review.render(), /"label":"Month".*"value":"1"/);
 review.record('correct'); assert.equal(review.needsDeepReasoning, true);
 review.observe(page('11','1'), 'wizard'); review.invalidate();
 assert.equal(review.needsDeepReasoning, true, 'a repair or rerender cannot clear the agent-authored escalation');
 assert.equal(review.request(), true, 'correction is not a ready judgment');
 review.record('ready'); review.observe({ ...page(), fields: [] }, 'wizard');
 assert.equal(review.needsDeepReasoning, false, 'only the agent ends its correction assessment');
 assert.equal(review.request(), false, 'leaving a wizard page retains the reviewed evidence');
 review.observe(page('11','1')); assert.equal(review.request(), true, 'changed components need fresh assessment');
 review.record('ready'); review.invalidate(); assert.equal(review.request(), true, 'batch mutations cannot reuse an earlier judgment');
});

test('unknown optional date components remain blank; credentials never enter evidence', () => {
 const review = new ApplicationReadiness(); review.observe({ ...page(), fields: [
   { ...page().fields[0], currentValue: '' },
   { ...page().fields[1], label: 'Password date', inputType: 'password', currentValue: 'private-fixture', sensitive: true },
 ] });
 assert.match(review.render(), /"value":""/); assert.doesNotMatch(review.render(), /private-fixture/);
 const ordinary = new ApplicationReadiness(); ordinary.observe({ ...page(), fields: [{ ...page().fields[0], label: 'City', hints: 'city' }] });
 assert.equal(ordinary.request(), true, 'ordinary personal fields also need source review');
});

test('source review covers ordinary answers, cancelled editors and unresolved claims', () => {
 const review = new ApplicationReadiness();
 review.observe({ ...page(), fields: [{ ...page().fields[0], label: 'Previously employed here?', currentValue: 'No', controlIdentity: 'employment-history' }] });
 assert.equal(review.request(), true);
 assert.throws(() => review.record('ready', ['Employer history not confirmed']), /Resolve/);
 assert.equal(review.request(), true, 'conflicting review cannot authorize a send');
 review.record('needs_answer');
 review.observe({ ...page(), fields: [] });
 assert.match(review.render(), /earlier saved-form readback; recheck retained entries if uncertain/);
 review.record('ready');
 assert.equal(review.request(), false);
 review.invalidate();
 assert.equal(review.request(), true, 'document or letter changes require a new review even with no date fields');
});

test('raw autocomplete search values cannot overwrite reviewed committed tags', () => {
 const review=new ApplicationReadiness();
 const field={...page().fields[0],label:'Work environment',controlIdentity:'tag-widget',currentValue:'["On Site"]'};
 review.observe({...page(),fields:[field]});review.record('ready');
 review.observe({...page(),fields:[{...field,currentValue:''}]},'wizard');
 assert.equal(review.request(),false,'ordinary inspection is historical evidence, not a conflicting canonical read');
 review.observe({...page(),fields:[field]});assert.equal(review.request(),false,'unchanged committed selection permits the newly chosen send');
 review.observe({...page(),fields:[{...field,currentValue:'["Remote"]'}]});
 assert.equal(review.request(),true,'a genuinely changed committed selection still requires a new review');
});
