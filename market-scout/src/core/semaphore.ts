/** Bounds concurrent work and hands each released slot to the oldest waiter. */
export class Semaphore {
  private waiting: Array<() => void> = [];
  constructor(private free: number) {}

  async acquire(): Promise<void> {
    if (this.free > 0) {
      this.free -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.free += 1;
  }
}
