/** Command arguments belong in the advertised schema, not only in dispatch
 * errors. Keep alternatives under the closed parent property catalogue so
 * providers and local validation read the same action-specific contract. */
export function browserCommandContract(actions: readonly string[],requireSendIntent=false): Record<string, unknown> {
  const target = ['ref', 'selector', 'locator'].map(key => ({ required: [key] }));
  const special = ['script', 'set_input_files', 'wait',...requireSendIntent?['click','press']:[]];
  return { anyOf: [
    ...requireSendIntent?[{properties:{action:{enum:actions.filter(action=>['click','press'].includes(action))}},required:['sends_application']}]:[],
    ...actions.includes('script') ? [{ properties: { action: { enum: ['script'] } }, required: ['script'] }] : [],
    ...actions.includes('set_input_files') ? [{ properties: { action: { enum: ['set_input_files'] } },
      required: ['file_ids'], anyOf: target }] : [],
    ...actions.includes('wait') ? [{ properties: { action: { enum: ['wait'] } }, anyOf: [
      ...target,
      { required: ['wait'], properties: { wait: { anyOf: [...target, { required: ['url'] }] } } },
    ] }] : [],
    { properties: { action: { enum: actions.filter(action => !special.includes(action)) } } },
  ] };
}
