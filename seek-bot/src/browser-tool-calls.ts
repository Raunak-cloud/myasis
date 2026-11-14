export const BROWSER_TOOL_ACTIONS: Readonly<Record<string, string>> = Object.freeze({
  browser_click: 'click', browser_fill: 'fill', browser_upload: 'set_input_files', browser_navigate: 'navigate',
});

/** One command representation for execution, recovery and historical audits.
 * Keep this in the browser build so isolated repair artifacts include it. */
export function browserToolCall(name: string, args: Record<string, unknown>): { name: string; args: Record<string, unknown> } {
  const action = Object.hasOwn(BROWSER_TOOL_ACTIONS, name) ? BROWSER_TOOL_ACTIONS[name] : undefined;
  if (!action) return { name, args };
  if (name === 'browser_navigate') {
    const { url, ...rest } = args;
    return { name: 'browser_action', args: { ...rest, action, value: url } };
  }
  return { name: 'browser_action', args: { ...args, action } };
}
