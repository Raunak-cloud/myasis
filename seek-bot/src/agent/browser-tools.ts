import type { ToolSchema } from './celeris.js';
import { browserCommandContract } from './browser-command-schema.js';
import { BROWSER_TOOL_ACTIONS as operations } from '../browser-tool-calls.js';
export { browserToolCall } from '../browser-tool-calls.js';

export function namedBrowserToolCall(name: string, args: Record<string, unknown>) {
  if (name !== 'browser_action') return { name, args };
  const match = Object.entries(operations).find(([, action]) => action === args.action);
  if (!match) return { name, args };
  const { action, ...rest } = args;
  if (match[0] === 'browser_navigate') {
    const { value, ...target } = rest;
    return { name: match[0], args: { ...target, url: value } };
  }
  return { name: match[0], args: rest };
}

/** Keep the generic command format inside batches and saved helpers. Advertise
 * the common operations only once, with their own required arguments. */
export function splitBrowserTools(tool: ToolSchema, preparing = false): ToolSchema[] {
  if (tool.name !== 'browser_action') return [tool];
  const properties = tool.parameters.properties as Record<string, Record<string, unknown>>;
  const actions = (properties.action.enum as string[]).filter(action => !Object.values(operations).includes(action));
  const pick = (keys: string[]) => Object.fromEntries(keys.map(key => [key, properties[key]]));
  const targets = pick(['ref', 'selector', 'locator']);
  const targetMode = { ...properties.target_mode, enum: ['ref', 'selector', 'locator'] };
  const targetAlternatives = ['ref', 'selector', 'locator'].map(key => ({ required: [key] }));
  const make = (name: string, description: string, fields: Record<string, unknown>, required: string[], alternatives?: unknown[]): ToolSchema => ({
    name, description, parameters: { type: 'object', additionalProperties: false, properties: fields, required,
      ...(alternatives ? { anyOf: alternatives } : {}) },
  });
  const control = { ...targets, target_mode: targetMode };
  const { file_ids, replaces_file_ids, file_chooser, ...remaining } = properties;
  return [
    make('browser_click', 'Click a current button or link. Use its ref when available. Set sends_application=true only when sending the completed application.',
      { ...control, target_mode: { ...targetMode, enum: [...targetMode.enum, ...preparing ? [] : ['coordinates']] },
        ...preparing ? {} : pick(['x', 'y']), ...pick(['wait', 'sends_application']) },
      preparing ? ['sends_application'] : [], [...targetAlternatives, ...preparing ? [] : [{ required: ['x', 'y'] }]]),
    make('browser_fill', 'Fill an ordinary application text field, such as name, email, city or cover letter. Use its current field ref when available; supply the exact value.',
      { ...control, value: properties.value, ...pick(['wait', 'sends_application']) }, ['value'], targetAlternatives),
    make('browser_upload', 'Attach files to the selected file input. Use its current ref and exact file_ids from the inventory or document tools. For an upload button, set file_chooser=true.',
      { ...control, file_ids, replaces_file_ids, file_chooser, ...pick(['wait', 'sends_application']) }, ['file_ids'], targetAlternatives),
    make('browser_navigate', 'Open the supplied web URL in the current tab.',
      { url: { type: 'string', minLength: 1 }, ...pick(['wait', 'sends_application']) }, ['url']),
    { ...tool, description: `For one control, use action=inspect with ref, selector or locator. For the whole page, use action=take_snapshot, optionally screenshot=true. Select uses value=option; check uses value=true/false; type uses value=text; press uses value=key. Waits need a target or URL condition. select_page uses page_index.${preparing ? '' : ' Scripts use script.'} Use browser_click, browser_fill, browser_upload and browser_navigate for those operations.`,
      parameters: { ...tool.parameters, properties: { ...remaining, action: { ...properties.action, enum: actions } },
        ...browserCommandContract(actions, preparing) } },
  ];
}
