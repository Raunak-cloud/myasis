import { headers } from 'next/headers';
export async function StructuredData({ values }: { values: unknown[] }) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return <>{values.map((value, index) => <script key={index} nonce={nonce} type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(value).replace(/</g, '\\u003c') }} />)}</>;
}
