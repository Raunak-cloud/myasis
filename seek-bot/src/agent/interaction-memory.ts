/** Compact execution evidence survives retiring old DOM observations. It never
 * chooses an answer, repairs a widget, blocks an action or calls another model. */
export class InteractionMemory {
  private failures = new Map<string, { target: string; error: string; count: number }>();

  failed(tool: string, args: Record<string, unknown>, url: string, error: string): void {
    let location = '';
    try { const parsed = new URL(url); location = parsed.origin + parsed.pathname; } catch { /* Unfinished navigation. */ }
    const target = JSON.stringify({ tool, action: args.action,
      target: args.observed_target ?? args.locator ?? args.selector ?? args.ref, location });
    const key = target + error.split('\n')[0];
    const count = (this.failures.get(key)?.count ?? 0) + 1;
    this.failures.delete(key);
    this.failures.set(key, { target: target.slice(0, 700), error: error.slice(0, 800), count });
    while (this.failures.size > 6) this.failures.delete(this.failures.keys().next().value!);
  }

  render(): string {
    return this.failures.size ? `PREVIOUS FAILED INTERACTIONS (historical evidence, not restrictions). Diagnose using fresh controls; do not blindly repeat the same failed approach.\n${JSON.stringify([...this.failures.values()])}` : '';
  }
}
