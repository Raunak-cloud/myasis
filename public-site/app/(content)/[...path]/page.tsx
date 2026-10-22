import { notFound } from 'next/navigation';
import { SiteHeader } from '../../../components/header';
import { PublicTracking } from '../../../components/tracking';
import { StructuredData } from '../../../components/structured-data';
import { getDocument, parseDocument } from '../../../lib/document';

type Props = { params: Promise<{ path: string[] }> };
export async function generateMetadata({ params }: Props) {
  const document = await getDocument(`/${(await params).path.join('/')}`);
  if (document.status === 404) notFound();
  return parseDocument(document).metadata;
}
export default async function Content({ params }: Props) {
  const path = `/${(await params).path.join('/')}`;
  const document = await getDocument(path);
  if (document.status === 404 || !document.html) notFound();
  const parsed = parseDocument(document);
  const resource = path === '/automate-job-applications-australia' || path.startsWith('/blog');
  return <div className={resource ? 'resource-page' : undefined}>
    <StructuredData values={parsed.structuredData} />
    {resource && <SiteHeader active={path.startsWith('/blog') ? 'blog' : 'guide'} googleConfigured={document.googleConfigured ?? false} />}
    <div dangerouslySetInnerHTML={{ __html: parsed.body }} />
    <PublicTracking page={path.startsWith('/blog') ? 'blog' : path === '/automate-job-applications-australia' ? 'guide' : path.slice(1)} />
  </div>;
}
