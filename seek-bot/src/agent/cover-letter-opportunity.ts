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
    observation.actions.some(action => COVER_LETTER.test(`${action.text} ${action.context ?? ''}`))
  ) {
    return true;
  }

  /**
   * "Supporting documents" with a control to add them is where a letter goes,
   * whether or not the page also says "cover letter": that is the employer's
   * place for one, and the candidate sends a letter wherever there is a place.
   * The heading must sit on the page or beside the control itself — never
   * only in job-ad prose with an unrelated button.
   */
  const addsDocuments = observation.actions.some(action =>
    REVEAL_DOCUMENTS.test(action.text) &&
    (SUPPORTING_DOCUMENTS.test(action.context ?? '') || SUPPORTING_DOCUMENTS.test(observation.text)));
  // Indeed's "Supporting documents" is itself the control: clicking it reveals the cover-letter option.
  const opensDocuments = observation.actions.some(action => SUPPORTING_DOCUMENTS.test(action.text));
  return addsDocuments || opensDocuments;
}
