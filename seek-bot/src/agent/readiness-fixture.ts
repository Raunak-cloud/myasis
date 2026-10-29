/** Test-only scripted model continuation for existing non-readiness fixtures.
 * The dedicated readiness browser suite supplies explicit decisions instead. */
export function createReadinessFixtureReply(): (body: any) => Response | undefined {
  let pending: any;
  let sequence = 0;
  const reply = (call: any) => Response.json({ choices: [{ message: { role: 'assistant', content: null,
    tool_calls: [{ id: `fixture-review-${++sequence}`, type: 'function', function: call }] } }], usage: { prompt_tokens: 0, completion_tokens: 0 } });
  return body => {
    if (body.tool_choice?.function?.name === 'record_application_review') {
      const latest = [...body.messages].reverse().find((message: any) => message.role === 'assistant' && message.tool_calls?.some((call: any) => ['browser_action', 'browser_batch', 'prepare_application', 'prepare_email_application'].includes(call.function.name)));
      pending = latest?.tool_calls.find((call: any) => ['browser_action', 'browser_batch', 'prepare_application', 'prepare_email_application'].includes(call.function.name))?.function;
      // A previously held batch may contain already-executed fills. Retry only
      // its final explicitly marked send; never replay its writes.
      if (pending?.name === 'browser_batch') {
        const send = JSON.parse(pending.arguments).actions.find((action: any) => action.sends_application === true);
        pending = send ? { name: 'browser_action', arguments: JSON.stringify(send) } : undefined;
      }
      return reply({ name: 'record_application_review', arguments: JSON.stringify({ assessment: 'ready',
        vacancy: 'The controlled fictional vacancy in this fixture', documents: 'The explicitly scripted fixture documents', unresolved: [],
        checks: [{ question: 'Fixture values', source_evidence: 'Explicit fictional test inputs', intended_meaning: 'Controlled fixture data', observed_value: 'Scripted browser readbacks', conclusion: 'Fixture precondition' }], next_action: 'Choose the held operation again' }) });
    }
    if (pending) { const call = pending; pending = undefined; return reply(call); }
    return undefined;
  };
}
