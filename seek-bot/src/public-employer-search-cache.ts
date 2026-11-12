import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

/** Short-lived public search results only. Detail, authentication and error responses are never cached. */
export function publicEmployerSearchCache(directory: string, network: typeof fetch = fetch, now = Date.now): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input)), headers = new Headers(init?.headers ?? request?.headers);
    const smart = url.hostname === 'api.smartrecruiters.com' && /^\/v1\/companies\/[A-Za-z0-9_-]+\/postings$/.test(url.pathname);
    const pageup = url.hostname === 'careers.pageuppeople.com' && /^\/\d{1,8}\/[a-z][a-z0-9_-]{0,31}\/en\/(search|listing)\/$/i.test(url.pathname);
    if ((!smart && !pageup) || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
      || (init?.method ?? request?.method ?? 'GET') !== 'GET' || headers.has('authorization') || headers.has('cookie')) return network(input, init);
    // The provider's age cutoff changes by milliseconds on each run. Bucket
    // the cache key, while sending the exact requested cutoff to the provider.
    // Normal listing-age checks and fresh details still govern every match.
    const cacheUrl=new URL(url);
    const cutoff=Date.parse(cacheUrl.searchParams.get('releasedAfter')??'');
    if(smart&&Number.isFinite(cutoff))cacheUrl.searchParams.set('releasedAfter',new Date(Math.floor(cutoff/1800000)*1800000).toISOString());
    const key = createHash('sha256').update(cacheUrl.href).digest('hex'), file = resolve(directory, key + '.json');
    try {
      const saved = JSON.parse(await readFile(file, 'utf8'));
      if (saved.at <= now() && now() - saved.at < 30 * 60_000 && typeof saved.body === 'string') return new Response(saved.body, { headers: { 'Content-Type': smart ? 'application/json' : 'text/html' } });
    } catch { /* Cache is optional. */ }
    const response = await network(input, init); if (!response.ok) return response;
    const body = await response.text(); if (Buffer.byteLength(body) > (smart ? 1_000_000 : 8_000_000)) throw Error('Public search response exceeded size limit.');
    try {
      const valid = smart ? Array.isArray(JSON.parse(body).content) : /id\s*=\s*["']search-results-content["']/.test(body);
      if (valid) {
        await mkdir(directory, { recursive: true }); const temporary = file + '.' + randomUUID() + '.tmp';
        try { await writeFile(temporary, JSON.stringify({ at: now(), body }), { mode: 0o600 }); await rename(temporary, file); }
        finally { await unlink(temporary).catch(() => {}); }
      }
    } catch { /* A cache failure cannot invalidate a public response. */ }
    return new Response(body, { status: response.status, headers: response.headers });
  };
}
