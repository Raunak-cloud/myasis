/**
 * What a rewrite may not change, shared by every rewriting path: the bot's
 * cover-letter humanizer and the dashboard's Rewrite text tool.
 *
 * Kept free of configuration and I/O so the dashboard can import it without
 * loading the bot. The rewrite model sees the real text — no placeholders to
 * copy, which a 3B model mangles — and this checks the result afterwards.
 */

export function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

/** Bare numerals, so "40%" and "40 percent" are the same figure. */
function numbers(text: string): string[] {
  return (text.match(/\b\d+(?:[.,]\d+)*\b/g) ?? []).map((value) => value.replace(/,/g, ''));
}

/** Addresses and emails; trailing sentence punctuation is not part of them. */
function protectedTokens(text: string): string[] {
  return (text.match(/(?:https?:\/\/|www\.)\S+|[\w.+-]+@[\w.-]+\.\w+|\b[\w-]+\.(?:com|net|org|io|ai|app|co)(?:\.[a-z]{2})?\b/gi) ?? [])
    .map((token) => token.replace(/[.,;:!?)\]]+$/, ''));
}

/**
 * Substance only. Style is the rewrite's whole job, so nothing here judges
 * it. What a rewrite may not do is state a figure, URL or email the original
 * never made. Asymmetric on purpose: spelling "3" as "three" or dropping a
 * figure is style; inventing one is a claim nobody made.
 */
export function validateRewrite(original: string, candidate: string, maxWords: number): string | null {
  if (!candidate.trim()) return 'the service returned empty text';
  const normalise = (text: string) => text.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase();
  if (normalise(original) === normalise(candidate)) return 'the service returned the original text unchanged';
  if (wordCount(candidate) > maxWords) return `the rewrite exceeded its ${maxWords}-word limit`;

  const draftNumbers = new Set(numbers(original));
  const invented = numbers(candidate).find((value) => !draftNumbers.has(value));
  if (invented) return `the rewrite introduced a figure the original does not make (${invented})`;

  const draftTokens = new Set(protectedTokens(original).map((token) => token.toLowerCase()));
  const fabricated = protectedTokens(candidate).find((token) => !draftTokens.has(token.toLowerCase()));
  if (fabricated) return `the rewrite introduced a web address or email not in the original (${fabricated})`;
  return null;
}
