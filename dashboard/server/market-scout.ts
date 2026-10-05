import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import { readRawBodyLimited, DEFAULT_BODY_LIMIT } from './http-guards.js';

/** A private admin tool. The standalone service is never exposed at the edge. */
export function marketScoutProxy(
  authorize: (req: IncomingMessage) => Promise<'admin' | 'user' | null>,
  originAllowed: (req: IncomingMessage) => boolean,
  port = 5190,
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const reply = (status: number, error: string) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error }));
    };
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    try {
      const user = await authorize(req);
      if (!user) return reply(401, 'Sign in to Owtomate to open market research.');
      if (user !== 'admin') return reply(403, 'Admins only.');
      if (req.method !== 'GET' && req.method !== 'POST') return reply(405, 'Method not allowed.');
      if (req.method === 'POST' && !originAllowed(req)) return reply(403, 'Forbidden origin');
      const path = (req.url ?? '').slice('/market-research'.length) || '/';
      if (!path.startsWith('/') || path.startsWith('//')) return reply(400, 'Invalid research path');
      const body = req.method === 'POST' ? await readRawBodyLimited(req, DEFAULT_BODY_LIMIT) : undefined;
      const upstream = request({
        hostname: '127.0.0.1', port, path, method: req.method,
        // Do not forward cookies or client headers into the browser agent.
        headers: {
          origin: `http://127.0.0.1:${port}`,
          ...(body ? { 'content-type': 'application/json', 'content-length': String(body.length) } : {}),
        },
      }, (response) => {
        res.writeHead(response.statusCode ?? 502, {
          'content-type': response.headers['content-type'] ?? 'application/json',
          'cache-control': 'no-store',
          'X-Accel-Buffering': 'no',
        });
        response.pipe(res);
      });
      upstream.on('error', () => {
        if (!res.headersSent) reply(502, 'Market research is temporarily unavailable. Try again shortly.');
        else res.end();
      });
      res.on('close', () => upstream.destroy());
      upstream.end(body);
    } catch {
      if (!res.headersSent) reply(503, 'Market research could not be opened. Try again shortly.');
      else res.end();
    }
  };
}
