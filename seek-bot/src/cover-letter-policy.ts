export const COVER_LETTER_INSTRUCTION_WORD_LIMIT = 50;
export const instructionWordCount = (text: string) => text.trim() ? text.trim().split(/\s+/u).length : 0;

export function validateCoverLetterInstructions(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2000 || instructionWordCount(value) > COVER_LETTER_INSTRUCTION_WORD_LIMIT) {
    throw new Error('Cover letter instructions must be 50 words or fewer.');
  }
  return value.trim();
}

/** Keep paragraph breaks and ordinary hyphens; normalize prohibited punctuation at every writing boundary. */
export const cleanCoverLetter = (text: string) => text.replace(/\r\n?/g, '\n').replace(/[\t ]*\u2014+[\t ]*/g, ', ').trim();
export const isCoverLetterField = (label: string) => /cover[\s_-]*(?:letter|note)|letter of application/i.test(label);

export function coverLetterInstructionPrompt(instructions: string | undefined): string {
  return `COVER LETTER STYLE: Never use em dashes. Use commas, full stops or parentheses. Follow the candidate's saved cover letter instructions for every new letter while keeping all claims grounded in their evidence. For a previously approved application, preserve its exact approved letter instead of rewriting it to match newer preferences.\nSaved instructions: ${JSON.stringify(instructions ?? '')}`;
}
