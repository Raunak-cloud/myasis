/** Test-only continuation for fixtures whose terminal technical failure is intentional.
 * Recovery behavior itself is exercised by automatic-specialist.test.ts and
 * investigation-browser.test.ts; this adapter retains their controlled stop. */
export function isSpecialistFixtureRequest(body:any):boolean {
  return /^You are (?:a read-only |an )application specialist assisting the applying agent\b/.test(String(body.messages?.[0]?.content));
}
export function specialistFixtureReply(body: any): Response | undefined {
  if (isSpecialistFixtureRequest(body)) {
    return Response.json({ usage: { prompt_tokens: 0, completion_tokens: 0 }, choices: [{ message: {
      content: JSON.stringify({ advice: 'Preserve completed fixture work and use the current observed evidence. This fixture supplies no additional recovery path.',
        evidence: [], unknowns: [], nextSteps: ['The parent should record the controlled outcome honestly if the blocker remains.'] }),
    } }] });
  }
  const last = body.messages?.filter((message: any) => message.role === 'tool').at(-1);
  if (typeof last?.content !== 'string' || !['AUTOMATIC SPECIALIST REVIEW BEFORE STOPPING','UNCERTAINTY INVESTIGATION BEFORE STOPPING'].some(prefix=>last.content.startsWith(prefix))) return;
  const calls = body.messages.flatMap((message: any) => message.role === 'assistant' ? message.tool_calls || [] : []);
  const held = calls.findLast((call: any) => call.id === last.tool_call_id)?.function;
  if (held?.name !== 'finish') throw new Error('Fixture could not correlate the stopping review with its held finish.');
  return Response.json({ usage: { prompt_tokens: 0, completion_tokens: 0 }, choices: [{ message: { role: 'assistant', content: null,
    tool_calls: [{ id: `${last.tool_call_id}-after-specialist`, type: 'function', function: held }],
  } }] });
}
