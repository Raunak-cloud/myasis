/** Test-only continuation for fixtures whose terminal technical failure is intentional.
 * Recovery behavior itself is exercised by automatic-specialist.test.ts and
 * investigation-browser.test.ts; this adapter retains their controlled stop. */
export function isSpecialistFixtureRequest(body:any):boolean {
  return /^You are (?:a read-only |an )application specialist assisting the applying agent\b/.test(String(body.messages?.[0]?.content));
}
/** Scripted providers must obey the offered wire schema too. The canonical
 * argument validator remains in the actual client and dispatch path. */
export function fixtureToolArguments(body:any,name:string,args:Record<string,unknown>):string {
  const parameters=body.tools?.find((tool:any)=>tool.function?.name===name)?.function?.parameters;
  return JSON.stringify(parameters?.properties?.arguments_json?{arguments_json:JSON.stringify(args)}:args);
}
export function specialistFixtureReply(body: any): Response | undefined {
  if (isSpecialistFixtureRequest(body)) {
    return Response.json({ usage: { prompt_tokens: 0, completion_tokens: 0 }, choices: [{ message: {
      content: JSON.stringify({ advice: 'Preserve completed fixture work and use the current observed evidence. This fixture supplies no additional recovery path.',
        evidence: [], unknowns: [], nextSteps: ['The parent should record the controlled outcome honestly if the blocker remains.'],recovery_goal:{kind:'visible-text',target:'Controlled fixture recovery',value:'Controlled fixture recovery'} }),
    } }] });
  }
  const forced=body.tool_choice?.function?.name;
  if(['respond_to_specialist','check_specialist_recovery'].includes(forced)) {
    const text=body.messages.map((m:any)=>typeof m.content==='string'?m.content:Array.isArray(m.content)?m.content.map((p:any)=>p.text??'').join('\n'):'').reverse().find((text:string)=>text.includes('SPECIALIST RECOVERY OBLIGATION\n'));
    const task=JSON.parse(text.match(/SPECIALIST RECOVERY OBLIGATION\n([^\n]+)/)[1]);
    const pageEvidence=text.split('Current observation evidence for exact quotations: ')[1];
    const quote=JSON.parse('"'+pageEvidence.match(/"url":"([^"]+)"/)[1]+'"');
    const args=forced==='respond_to_specialist'?{advice_id:task.advice_id,decision:'adopt',reason:'Read the actual controlled fixture once before preserving its intentional technical stop.',evidence_quote:quote,
      operation_tool:'browser_action',operation_action:'inspect',operation_purpose:'Inspect the actual controlled fixture body before its technical stop.',verification:task.verification}
      :{advice_id:task.advice_id,assessment:'blocked',result_quote:task.result.slice(0,200),observation_quote:quote,reason:'The isolated fixture supplies no supported recovery path; preserve its controlled unresolved outcome.'};
    return Response.json({usage:{prompt_tokens:0,completion_tokens:0},choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'fixture-specialist-'+forced,type:'function',function:{name:forced,arguments:fixtureToolArguments(body,forced,args)}}]}}]});
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
