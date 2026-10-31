/** Shared browser/server key; preserve display copy separately from required markers. */
export function blockedQuestionKey(item: { question?: unknown; prompt?: unknown }): string {
  const normalise = (value: unknown) => typeof value === 'string' ? value.replace(/\s+/g, ' ').replace(/(?:\s*\*)+\s*$/, '').trim() : '';
  const prompt = normalise(item?.prompt);
  const question = normalise(item?.question);
  return prompt || question;
}
