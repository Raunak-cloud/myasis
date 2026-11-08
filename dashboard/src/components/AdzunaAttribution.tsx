/** Adzuna API attribution accompanies every displayed advert from this source. */
export function AdzunaAttribution({ platform, jobId }: { platform?: string; jobId?: string }) {
  if (platform !== 'adzuna' && !jobId?.startsWith('adzuna-')) return null;
  return <a href="https://www.adzuna.com.au" target="_blank" rel="noreferrer"
    style={{ display: 'inline-block', minWidth: 116, minHeight: 23, fontSize: 24, lineHeight: '28px' }}>Adzuna</a>;
}
