import type { ToolContext, ToolResult } from './context.js';

/** Test-only scripted choice. Production choices come from the applying agent. */
export async function chooseTestVerification(tool: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>,
  ctx: ToolContext, args: Record<string, unknown>, kind: 'code' | 'link', subject?: RegExp) {
  const inspected = await tool(ctx, args);
  if (inspected.kind !== 'ok') return inspected;
  let packet: { messages?: Array<{ subject: string; candidates: Array<{ kind: string; credential_id: string }> }> };
  try { packet = JSON.parse(inspected.message); } catch { return inspected; }
  const selected = packet.messages?.filter(message => !subject || subject.test(message.subject)).flatMap(message => message.candidates).find(choice => choice.kind === kind);
  if (!selected) return inspected;
  return tool(ctx, { ...args, credential_id: selected.credential_id });
}
