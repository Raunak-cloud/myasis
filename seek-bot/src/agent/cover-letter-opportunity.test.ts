import assert from 'node:assert/strict';
import { offersCoverLetter } from './cover-letter-opportunity.js';
import type { Observation } from './observe.js';

const observation = (overrides: Partial<Observation>): Observation => ({
  url: 'https://smartapply.indeed.com/beta/indeedapply/form/review',
  title: 'Review your application',
  actions: [],
  fields: [],
  text: '',
  ...overrides,
});

assert.equal(
  offersCoverLetter(observation({
    actions: [{ ref: 'a1', role: 'button', text: 'Add', disabled: false }],
    text: 'Supporting documents No cover letter or additional documents added. This is optional to add.',
  })),
  true,
  'recognises Indeed supporting documents even though its control is only labelled Add',
);

assert.equal(
  offersCoverLetter(observation({
    fields: [{ ref: 'f1', kind: 'textarea', label: 'Write a cover letter', required: false }],
    text: 'Add supporting documents Cover letter',
  })),
  true,
  'recognises the revealed cover-letter writing field',
);

assert.equal(
  offersCoverLetter(observation({
    actions: [{ ref: 'a1', role: 'button', text: 'Add', disabled: false }],
    text: 'The job advertisement says a cover letter is welcome.',
  })),
  false,
  'does not treat job-ad prose and an unrelated Add button as an upload opportunity',
);

assert.equal(
  offersCoverLetter(observation({
    actions: [{ ref: 'a1', role: 'button', text: 'Submit your application', disabled: false }],
    text: 'Supporting documents are accepted. Mention your cover letter in your application.',
  })),
  false,
  'does not block submission when there is no control that can reveal supporting documents',
);

console.log('cover-letter opportunity checks passed');
