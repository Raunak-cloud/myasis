// Temporary edge maintenance gate. Caddy forward_auth calls this on loopback.
// Administrator identity remains owned by the live application's session checks.
import { createServer } from 'node:http';

const message = "We're under maintenance. We'll be back at 6 PM AEDT.";
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Owtomate | Under maintenance</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f7fa;color:#172b45;font:18px/1.6 system-ui,sans-serif}main{margin:24px;padding:48px 32px;max-width:600px;text-align:center;background:white;border:1px solid #dce5ec;border-radius:20px}h1{font-size:34px;line-height:1.2}p{color:#52647b}a{color:#225d84;font-size:14px}.brand{font-weight:750;font-size:24px;color:#225d84}</style><main><div class="brand">Owtomate</div><h1>We're under maintenance</h1><p>We're making improvements.<br>We'll be back at <strong>6 PM AEDT</strong>.</p><p>Thank you for your patience.</p><a href="/api/auth/google">Admin sign in</a></main></html>`;
const authPaths = new Set(['/api/auth/google', '/api/auth/callback/google']);
const server = createServer(async (req, res) => {
  const path = new URL(String(req.headers['x-forwarded-uri'] ?? '/'), 'http://localhost').pathname;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Cookie');
  // Keep OAuth sign-in available so an administrator with an expired session
  // can sign in. Payment callbacks continue through their ordinary validation.
  if (authPaths.has(path) || path === '/api/auth/logout' || path === '/api/billing/webhook') {
    res.writeHead(200); return res.end();
  }
  try {
    if (req.headers.cookie) {
      const check = await fetch('http://127.0.0.1:5180/api/admin/simulations', {
        headers: { Cookie: req.headers.cookie }, redirect: 'error', signal: AbortSignal.timeout(5000),
      });
      await check.body?.cancel();
      if (check.status === 200) { res.writeHead(200); return res.end(); }
    }
  } catch { /* Authentication unavailable: keep maintenance closed. */ }
  res.setHeader('Retry-After', 'Tue, 03 Nov 2026 07:00:00 GMT');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('Content-Type', path.startsWith('/api/') ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8');
  res.writeHead(503);
  res.end(path.startsWith('/api/') ? JSON.stringify({ maintenance: true, error: message }) : html);
});
server.requestTimeout = 10_000;
server.headersTimeout = 10_000;
server.listen(Number(process.env.MAINTENANCE_GATE_PORT ?? 5191), '127.0.0.1', () => console.log('Maintenance gate ready on loopback.'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
