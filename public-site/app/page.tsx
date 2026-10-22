import { Landing } from '../components/landing';
import { PublicTracking } from '../components/tracking';
import { StructuredData } from '../components/structured-data';
import { getDocument, parseDocument } from '../lib/document';

export async function generateMetadata() { return parseDocument(await getDocument('/')).metadata; }
export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const document = await getDocument('/');
  const params = await searchParams;
  return <><StructuredData values={parseDocument(document).structuredData} />
    <Landing googleConfigured={document.googleConfigured ?? false} initialImprovements={document.patch ?? {}} initialAuthError={typeof params.auth_error === 'string' ? params.auth_error : null} />
    <PublicTracking page="landing" /></>;
}
