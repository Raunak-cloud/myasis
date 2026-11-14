export const BROWSER_TOOL_ACTIONS = Object.freeze({
  browser_click: 'click', browser_fill: 'fill', browser_upload: 'set_input_files', browser_navigate: 'navigate',
});

/** One command representation for execution, recovery and historical audits. */
export function browserToolCall(name, args) {
  const action = Object.hasOwn(BROWSER_TOOL_ACTIONS, name) ? BROWSER_TOOL_ACTIONS[name] : undefined;
  if (!action) return { name, args };
  if (name === 'browser_navigate') {
    const { url, ...rest } = args;
    return { name: 'browser_action', args: { ...rest, action, value: url } };
  }
  return { name: 'browser_action', args: { ...args, action } };
}
