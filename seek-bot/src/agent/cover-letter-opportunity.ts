import type { Observation } from './observe.js';

const COVER_LETTER = /\bcover[\s-]?letter\b/i;
const SUPPORTING_DOCUMENTS = /\b(?:supporting|additional) documents?\b/i;
const REVEAL_DOCUMENTS = /\b(?:add|attach|include|upload|write)(?:\s+(?:a|any|supporting|additional))?(?:\s+documents?)?\b/i;

/**
 * Identifies a real place in the current application where a cover letter can
 * be supplied. Some sites label the control itself "Cover letter"; Indeed's
 * review step instead labels it only "Add" and puts the useful meaning in the
 * surrounding "Supporting documents" copy.
 *
 * Requiring both that copy and a reveal control prevents job-ad prose from
 * being mistaken for an application field.
 */
export function offersCoverLetter(observation: Observation): boolean {
  if (
    observation.fields.some(field => COVER_LETTER.test(`${field.label} ${field.description ?? ''}`)) ||
    observation.actions.some(action => COVER_LETTER.test(action.text))
  ) {
    return true;
  }

  return (
    COVER_LETTER.test(observation.text) &&
    SUPPORTING_DOCUMENTS.test(observation.text) &&
    observation.actions.some(action => REVEAL_DOCUMENTS.test(action.text))
  );
}
