import type { ToolSchema } from './celeris.js';
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
  const pick = (keys: string[]) => Object.fromEntries(keys.map(key => [key, properties[key]]));
  const targets = pick(['ref', 'selector', 'locator']);
  const targetMode = { ...properties.target_mode, enum: ['ref', 'selector', 'locator'] };
  const targetAlternatives = ['ref', 'selector', 'locator'].map(key => ({ required: [key] }));
  const make = (name: string, description: string, fields: Record<string, unknown>, required: string[], alternatives?: unknown[]): ToolSchema => ({
    name, description, parameters: { type: 'object', additionalProperties: false, properties: fields, required,
      ...(alternatives ? { anyOf: alternatives } : {}) },
  });
  const control = { ...targets, target_mode: targetMode };
  const { file_ids, replaces_file_ids, file_chooser, screenshot } = properties;
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
    ...preparing ? [] : [make('browser_run_script', 'Run your complete browser JavaScript once. Supply script, not a description of the script. Use script_intent=inspect for read-only code or act for changes. Mark sends_application=true if it sends the application.',
      { ...pick(['script_intent', 'sends_application']), script: { ...properties.script, minLength: 1 } }, ['script'])],
    { ...tool, description: `Advanced browser operations when the simple tools do not fit. Supports every native action using a ref, CSS selector or scoped Playwright locator, including iframes, file choosers, conditional waits, typing, scrolling, hovering, tabs and dialogs.${preparing ? ' Semi auto retains its existing restrictions.' : ' Coordinate clicks and complete scripts are supported.'} Supply only arguments used by the chosen action. For script supply script; press uses value=key; select uses value=option; check uses value="true" or "false"; navigate uses value=URL; select_page uses page_index. Prefer the simple ref-based tools for ordinary controls.` },
  ];
}

/** Small model-facing inputs; the full native contracts remain available to
 * advanced actions, saved helpers and existing transcripts. No action is gated. */
export function presentBrowserTool(tool: ToolSchema): ToolSchema {
  const props = tool.parameters.properties as Record<string, Record<string, unknown>>;
  if (tool.name === 'fill_authentication_fields') {
    const { reason, ...accountFields } = props;
    return { ...tool, parameters: { ...tool.parameters, properties: accountFields } };
  }
  const fields: Record<string, string[]> = {
    browser_click: ['ref', 'sends_application'], browser_fill: ['ref', 'value'],
    browser_upload: ['ref', 'file_ids', 'file_chooser', 'replaces_file_ids'],
    browser_navigate: ['url'], browser_select_dropdown: ['ref', 'option'],
    browser_choose_radio: ['ref'], browser_set_checkbox: ['ref', 'checked'],
    browser_press_key: ['ref', 'key', 'sends_application'], browser_inspect: ['ref'],
    browser_snapshot: ['screenshot'], browser_run_script: ['script', 'script_intent', 'sends_application'],
  };
  const keys = fields[tool.name];
  if (keys) {
    const required = [...(tool.parameters.required as string[] ?? [])];
    if (!['browser_navigate', 'browser_press_key', 'browser_snapshot', 'browser_run_script'].includes(tool.name) && !required.includes('ref')) required.push('ref');
    return { ...tool, description: tool.name === 'browser_snapshot' ? 'Read the current page and its control refs. Set screenshot=true for a privacy-masked screenshot. For a focused selector/frame snapshot use browser_action with action=take_snapshot.' : tool.description.replace(/ or a scoped locator/g, ''), parameters: {
      type: 'object', additionalProperties: false, properties: Object.fromEntries(keys.map(key => [key, key === 'ref' ? { ...props.ref, minLength: 1, description: 'Current control number from the page, for example f0, f2:1 or frame1:f0.' } : props[key]])), required,
    } };
  }
  if (tool.name !== 'browser_batch') return tool;
  const simple = ['ref', 'value', 'option', 'checked', 'file_ids', 'file_chooser', 'replaces_file_ids', 'key', 'sends_application', 'script', 'script_intent'];
  const original = (props.actions.items as Record<string, any>).properties;
  return { ...tool, description: (tool.description.startsWith('CURRENT MODE:') ? 'CURRENT MODE: Semi-auto preparation. Native actions only; scripts are unavailable. ' : '') + 'Run browser tools in order using the same tool names and arguments as standalone calls. Example: {"actions":[{"tool":"browser_fill","args":{"ref":"f0","value":"Alex"}},{"tool":"browser_set_checkbox","args":{"ref":"f1","checked":true}}]}. Read results before continuing after a failure or page handoff.', parameters: {
    type: 'object', additionalProperties: false, required: ['actions'], properties: { actions: { ...props.actions, items: {
      type: 'object', additionalProperties: false, required: ['tool', 'args'], properties: {
        tool: { type: 'string', enum: Object.keys(operations).filter(name => original.action.enum.includes(operations[name])) },
        args: { type: 'object', additionalProperties: false, properties: Object.fromEntries(simple.filter(key => original[key] || ['option', 'checked', 'key'].includes(key)).map(key => [key,
          key === 'checked' ? { type: 'boolean' } : ['option', 'key'].includes(key) ? { type: 'string' } : original[key]])) },
      },
    } } },
  } };
}
