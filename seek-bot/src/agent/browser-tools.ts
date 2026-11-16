import type { ToolSchema } from './celeris.js';
import { browserCommandContract } from './browser-command-schema.js';
import { BROWSER_TOOL_ACTIONS as operations } from '../browser-tool-calls.js';
export { browserToolCall } from '../browser-tool-calls.js';

export function namedBrowserToolCall(name: string, args: Record<string, unknown>) {
  if (name !== 'browser_action') return { name, args };
  if (args.action === 'check') {
    const { action, value, ...rest } = args;
    return { name: 'browser_set_checkbox', args: { ...rest, checked: value !== 'false' } };
  }
  const match = Object.entries(operations).find(([, action]) => action === args.action);
  if (!match) return { name, args };
  const { action, ...rest } = args;
  if (match[0] === 'browser_navigate') {
    const { value, ...target } = rest;
    return { name: match[0], args: { ...target, url: value } };
  }
  if (match[0] === 'browser_select_dropdown') {
    const { value, ...target } = rest;
    return { name: match[0], args: { ...target, option: value } };
  }
  if (match[0] === 'browser_press_key') {
    const { value, ...target } = rest;
    return { name: match[0], args: { ...target, key: value } };
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
  const { file_ids, replaces_file_ids, file_chooser, screenshot, ...remaining } = properties;
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
    make('browser_select_dropdown', 'Choose the exact observed dropdown option. Use the dropdown field ref and option (its label or value). For a radio answer use browser_choose_radio.',
      { ...control, option: { type: 'string' }, ...pick(['wait', 'sends_application']) }, ['option'], targetAlternatives),
    make('browser_choose_radio', 'Choose one radio answer, such as Yes or No. Target that individual answer option using its current ref or a scoped locator, not the whole question. No value argument is needed.',
      { ...control, ...pick(['wait', 'sends_application']) }, [], targetAlternatives),
    make('browser_set_checkbox', 'Tick or untick one checkbox. Target its current ref and supply checked=true or checked=false.',
      { ...control, checked: { type: 'boolean' }, ...pick(['wait', 'sends_application']) }, ['checked'], targetAlternatives),
    make('browser_press_key', 'Press a key such as Enter or Tab, optionally in a targeted field. Supply key, not value. Mark sends_application=true if this transmits the completed application.',
      { ...control, key: { type: 'string' }, ...pick(['wait', 'sends_application']) }, preparing ? ['key', 'sends_application'] : ['key']),
    make('browser_inspect', 'Read one current control, its value, options and validation without changing it. Use its ref or a scoped locator.',
      control, [], targetAlternatives),
    make('browser_snapshot', 'Read the current page and its control refs without changing anything. Optionally supply screenshot=true for a privacy-masked screenshot, or a target for a focused snapshot.',
      { ...pick(['ref', 'selector', 'locator', 'target_mode']), screenshot }, []),
    { ...tool, description: `For remaining operations: type uses value=text; wait needs a target or URL condition; scroll uses the current target; hover targets a control; select_page uses page_index; dialog uses value for its response.${preparing ? '' : ' Scripts use script.'} Use the dedicated browser tools for clicks, text fills, uploads, navigation, dropdowns, radio answers, checkboxes, key presses, inspection and snapshots.`,
      parameters: { ...tool.parameters, properties: { ...remaining, action: { ...properties.action, enum: actions } },
        ...browserCommandContract(actions, preparing) } },
  ];
}
