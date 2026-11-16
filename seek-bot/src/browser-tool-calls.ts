export const BROWSER_TOOL_ACTIONS: Readonly<Record<string, string>> = Object.freeze({
  browser_click: 'click', browser_fill: 'fill', browser_upload: 'set_input_files', browser_navigate: 'navigate',
  browser_select_dropdown: 'select', browser_choose_radio: 'check', browser_set_checkbox: 'check',
  browser_press_key: 'press', browser_inspect: 'inspect', browser_snapshot: 'take_snapshot',
  browser_run_script: 'script',
});

/** One command representation for execution, recovery and historical audits.
 * Keep this in the browser build so isolated repair artifacts include it. */
export function browserToolCall(name: string, args: Record<string, unknown>): { name: string; args: Record<string, unknown> } {
  if (name === 'browser_batch' && Array.isArray(args?.actions)) return { name, args: { ...args, actions: args.actions.map(command => {
    if (!command || typeof command !== 'object' || !Object.hasOwn(command, 'tool')) return command;
    const item = command as { tool: string; args: Record<string, unknown> };
    if (typeof item.tool !== 'string' || !item.args || typeof item.args !== 'object' || Array.isArray(item.args)) return command;
    const operation = browserToolCall(item.tool, item.args);
    return operation.name === 'browser_action' ? operation.args : command;
  }) } };
  const action = Object.hasOwn(BROWSER_TOOL_ACTIONS, name) ? BROWSER_TOOL_ACTIONS[name] : undefined;
  if (!action) return { name, args };
  if (name === 'browser_navigate') {
    const { url, ...rest } = args;
    return { name: 'browser_action', args: { ...rest, action, value: url } };
  }
  if (name === 'browser_select_dropdown') {
    const { option, ...rest } = args;
    return { name: 'browser_action', args: { ...rest, action, value: option } };
  }
  if (name === 'browser_press_key') {
    const { key, ...rest } = args;
    return { name: 'browser_action', args: { ...rest, action, value: key } };
  }
  if (name === 'browser_set_checkbox') {
    const { checked, ...rest } = args;
    return { name: 'browser_action', args: { ...rest, action, value: String(checked) } };
  }
  if (name === 'browser_choose_radio') return { name: 'browser_action', args: { ...args, action, value: 'true' } };
  return { name: 'browser_action', args: { ...args, action } };
}
