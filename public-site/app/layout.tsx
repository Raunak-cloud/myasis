import { headers } from 'next/headers';
import './public.css';
import { getDocument, parseDocument } from '../lib/document';

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const requestHeaders = await headers();
  const path = requestHeaders.get('x-public-path') ?? '/';
  const document = await getDocument(path);
  const resource = path.startsWith('/blog') || path === '/automate-job-applications-australia';
  return <html lang={parseDocument(document).lang}><head>
    <meta name="theme-color" content="#2f73b9" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#14243d" media="(prefers-color-scheme: dark)" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500;1,600;1,700&family=Pacifico&display=swap" />
  </head><body className={resource ? 'resource-page' : undefined}>{children}</body></html>;
}
