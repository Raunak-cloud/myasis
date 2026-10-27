/** Explicit mock for browser transport tests. Semantic source-check quality is
 * exercised separately with missing/conflicting facts and paid model evals. */
export function personalAnswerFixtureResponse(body: { messages?: Array<{ role: string; content?: unknown }> }): Response | null {
  if (!String(body.messages?.[0]?.content).startsWith('You perform one read-only source check')) return null;
  const payload = JSON.parse(String(body.messages?.find(message => message.role === 'user')?.content));
  return Response.json({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ reviews: payload.answers.map((answer: { id: string }) => ({
    id: answer.id, basis: 'routine', citations: [], reason: 'Scripted transport fixture; semantic checks have dedicated tests.',
  })) }) } }], usage: { prompt_tokens: 30, completion_tokens: 10 } });
}
