import { getDocument } from '../../../lib/document';
export async function GET() { const document = await getDocument('/blog/rss.xml'); return new Response(document.text, { status: document.status, headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } }); }
