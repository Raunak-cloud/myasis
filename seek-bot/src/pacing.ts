/**
 * A polite gap per site, the way Scrapy keeps a download slot per domain.
 *
 * One shared pause made a SEEK search wait out the gap meant for Indeed and
 * the other way round. Each site now keeps its own: the next request to a
 * site waits only for what is left of that site's gap, so the time spent on
 * the other board counts toward it. A site sees requests no closer together
 * than before, since the gap is still measured from when its last request
 * finished, and stays randomized, since a fixed gap is a fingerprint.
 */
export class SitePacer {
  private readonly readyAt = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly random: () => number = Math.random,
  ) {}

  /** Waits until `site` may be asked again; returns how long that took. */
  async ready(site: string): Promise<number> {
    const wait = (this.readyAt.get(site) ?? 0) - this.now();
    if (wait <= 0) return 0;
    await this.sleep(wait);
    return wait;
  }

  /** A request to `site` just finished: the next one waits a randomized gap from now. */
  done(site: string, minMs: number, maxMs: number): void {
    this.readyAt.set(site, this.now() + Math.floor(minMs + this.random() * Math.max(0, maxMs - minMs)));
  }
}
