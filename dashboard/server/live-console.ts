/** A disconnected/slow viewer must not retain an unbounded queue of tool
 * output. EventSource reconnects and reads the bounded worker backlog. */
export interface ConsoleResponse {
  destroyed?: boolean; writableEnded?: boolean; writableLength?: number;
  destroy?: () => unknown; write: (text: string) => unknown;
}
export function writeConsole(res: ConsoleResponse, text: string): void {
  if (res.destroyed || res.writableEnded) return;
  if ((res.writableLength ?? 0) > 1024 * 1024) { res.destroy?.(); return; }
  res.write(text);
}
