import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

/** Short-lived public search results only. Detail, authentication and error responses are never cached. */
export function publicEmployerSearchCache(directory: string, network: typeof fetch = fetch, now = Date.now): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input)), headers = new Headers(init?.headers ?? request?.headers);
    const greenhouse = url.hostname === 'boards-api.greenhouse.io' && /^\/v1\/boards\/[A-Za-z0-9_-]+\/jobs$/.test(url.pathname) && url.search === '?content=true';
    if (!greenhouse || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
      || (init?.method ?? request?.method ?? 'GET') !== 'GET' || headers.has('authorization') || headers.has('cookie')) return network(input, init);
    const key = createHash('sha256').update(url.href).digest('hex'), file = resolve(directory, key + '.json');
    try {
      const saved = JSON.parse(await readFile(file, 'utf8'));
      if (saved.at <= now() && now() - saved.at < 30 * 60_000 && typeof saved.body === 'string') return new Response(saved.body, { headers: { 'Content-Type': 'application/json' } });
    } catch { /* Cache is optional. */ }
    const response = await network(input, init); if (!response.ok || !response.body) return response;
    if (/^(challenge|captcha|block)$/i.test(response.headers.get('x-amzn-waf-action') ?? '')) return response;
    const reader = response.body.getReader();
    const limit = 8_000_000;
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw Error('Public search response exceeded size limit.'); }
      chunks.push(part.value);
    }
    const body = Buffer.concat(chunks, bytes).toString('utf8');
    try {
      const valid = Array.isArray(JSON.parse(body)?.jobs);
      if (valid) {
        await mkdir(directory, { recursive: true }); const temporary = file + '.' + randomUUID() + '.tmp';
        try { await writeFile(temporary, JSON.stringify({ at: now(), body }), { mode: 0o600 }); await rename(temporary, file); }
        finally { await unlink(temporary).catch(() => {}); }
      }
    } catch { /* A cache failure cannot invalidate a public response. */ }
    return new Response(body, { status: response.status, headers: response.headers });
  };
}
