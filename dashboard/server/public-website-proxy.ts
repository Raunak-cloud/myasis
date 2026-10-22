import { request } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

export function isPublicWebsiteRequest(raw: string): boolean {
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return false;
  const url = new URL(raw, 'http://localhost');
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  if ((url.pathname === '/' || url.pathname === '/index.html') && url.searchParams.has('tab')) return false;
  return ['/', '/index.html', '/privacy', '/privacy.html', '/terms', '/terms.html',
    '/automate-job-applications-australia', '/automate-job-applications-australia.html', '/sitemap.xml'].includes(url.pathname)
    || /^\/blog(?:\/|\.html|$)/.test(url.pathname) || url.pathname.startsWith('/_next/');
}
const hop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/** APIs, browser streams and signed-in dashboard requests are handled before this middleware. */
export function publicWebsiteProxy(origin: string | undefined) {
  if (origin && !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(origin)) throw new Error('PUBLIC_SITE_URL must be a loopback HTTP origin');
  return (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => {
    if (!origin || !['GET', 'HEAD'].includes(req.method ?? '') || !isPublicWebsiteRequest(req.url ?? '/')) return next();
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([key]) => !hop.has(key) && key !== 'host'));
    headers['x-forwarded-host'] = req.headers.host;
    const upstream = request(new URL(req.url ?? '/', origin), { method: req.method, headers }, incoming => {
      res.statusCode = incoming.statusCode ?? 502;
      for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined && !hop.has(key)) res.setHeader(key, value);
      incoming.on('error', () => res.destroy());
      incoming.pipe(res);
    });
    upstream.setTimeout(20_000, () => upstream.destroy(new Error('Public website timed out')));
    upstream.on('error', () => {
      if (res.headersSent) return res.destroy();
      res.statusCode = 503;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end('The website is temporarily unavailable. Please try again shortly.');
    });
    res.on('close', () => upstream.destroy());
    upstream.end();
  };
}
