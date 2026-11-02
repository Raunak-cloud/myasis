/** Test-only scripted model continuation for existing non-readiness fixtures.
 * The dedicated readiness browser suite supplies explicit decisions instead. */
export function createReadinessFixtureReply(): (body: any) => Response | undefined {
  let pending: any;
  let sequence = 0;
  const reply = (call: any, body: any) => {
    const offered = body.tools?.find((tool: any) => tool.function.name === call.name)?.function;
    const args = JSON.parse(call.arguments);
    if (offered?.parameters?.properties?.arguments_json && typeof args.arguments_json !== 'string') {
      call = { ...call, arguments: JSON.stringify({ arguments_json: call.arguments }) };
    }
    return Response.json({ choices: [{ message: { role: 'assistant', content: null,
      tool_calls: [{ id: `fixture-review-${++sequence}`, type: 'function', function: call }] } }], usage: { prompt_tokens: 0, completion_tokens: 0 } });
  };
  return body => {
    if (body.tool_choice?.function?.name === 'record_application_review') {
      const calls = body.messages.flatMap((message: any) => message.role === 'assistant' ? message.tool_calls || [] : []);
      const requestsReview = (message: unknown) => typeof message === 'string'
        && ['Before this send,', 'Before preparing this email,', 'Before preparing,'].some(prefix => message.startsWith(prefix));
      pending = undefined;
      for (const message of [...body.messages].reverse()) {
        if (message.role !== 'tool') continue;
        const call = calls.find((item: any) => item.id === message.tool_call_id)?.function;
        if (!call) continue;
        if (['browser_action', 'prepare_application', 'prepare_email_application'].includes(call.name) && requestsReview(message.content)) {
          pending = call; break;
        }
        if (call.name === 'browser_batch') {
          let result: any;
          try { result = JSON.parse(message.content); } catch { continue; }
          const stopped = result.results?.find((item: any) => item.index === result.stopped);
          if (!requestsReview(stopped?.message)) continue;
          const wire = JSON.parse(call.arguments);
          const command = (typeof wire.arguments_json === 'string' ? JSON.parse(wire.arguments_json) : wire).actions[result.stopped];
          if (command?.sends_application !== true) throw new Error('Fixture checkpoint did not hold an explicitly marked send.');
          // Prefix writes already ran; tail operations need a fresh scripted
          // decision. Resume only the actual command held by this checkpoint.
          pending = { name: 'browser_action', arguments: JSON.stringify(command) }; break;
        }
      }
      if (!pending) throw new Error('Fixture could not correlate the review checkpoint with its held tool_call_id.');
      return reply({ name: 'record_application_review', arguments: JSON.stringify({ assessment: 'ready',
        vacancy: 'The controlled fictional vacancy in this fixture', documents: 'The explicitly scripted fixture documents', unresolved: [],
        checks: [{ question: 'Fixture values', source_evidence: 'Explicit fictional test inputs', intended_meaning: 'Controlled fixture data', observed_value: 'Scripted browser readbacks', conclusion: 'Fixture precondition' }], next_action: 'Choose the held operation again' }) }, body);
    }
    if (pending && body.tool_choice?.function?.name) return undefined;
    if (pending) { const call = pending; pending = undefined; return reply(call, body); }
    return undefined;
  };
}
