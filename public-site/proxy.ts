import { NextResponse, type NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const development = process.env.NODE_ENV !== 'production';
  const policy = `default-src 'self'; script-src 'self' 'nonce-${nonce}' https://www.redditstatic.com https://connect.facebook.net${development ? " 'unsafe-eval'" : ''}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https://*.googleusercontent.com https://alb.reddit.com https://www.facebook.com; media-src 'self' blob:; connect-src 'self' https://alb.reddit.com https://pixel-config.reddit.com https://www.facebook.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`;
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('x-public-path', request.nextUrl.pathname);
  headers.set('Content-Security-Policy', policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', policy);
  response.headers.set('X-Public-Site', 'nextjs');
  return response;
}
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
