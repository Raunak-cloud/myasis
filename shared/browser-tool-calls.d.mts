export const BROWSER_TOOL_ACTIONS: Readonly<Record<string, string>>;
export function browserToolCall(name: string, args: Record<string, unknown>): { name: string; args: Record<string, unknown> };
