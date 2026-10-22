import { getDocument } from '../../lib/document';
export async function GET() { const document = await getDocument('/sitemap.xml'); return new Response(document.text, { status: document.status, headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } }); }
