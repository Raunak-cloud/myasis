import type { JobListing } from './types.js';

export type EmployerFeedBatch = { jobs: JobListing[]; hasMore: boolean };

/** Track each provider's pages independently of which rows became valid jobs. */
export class EmployerFeedPaging {
  private readonly endPages = new Map<string, number>();
  private readonly signatures = new Map<string, { page: number; signature: string }>();

  exhausted(query: string, page: number): boolean {
    return page >= (this.endPages.get(query) ?? Infinity);
  }

  end(query: string, page: number): void {
    this.endPages.set(query, page + 1);
  }

  repeated(query: string, page: number, ids: unknown[]): boolean {
    if (!ids.length || !ids.every(id => (typeof id === 'string' && id.trim()) || Number.isSafeInteger(id))) return false;
    const signature = JSON.stringify(ids.map(String).sort());
    const previous = this.signatures.get(query);
    this.signatures.set(query, { page, signature });
    return previous?.page === page - 1 && previous.signature === signature;
  }
}
