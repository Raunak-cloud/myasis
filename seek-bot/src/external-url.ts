import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { BrowserContext } from 'patchright';
import { isAustralianGovernmentUrl } from './site-policy.js';

const PRIVATE = new BlockList();
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]] as const) {
  PRIVATE.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [['::', 127], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) {
  PRIVATE.addSubnet(network, prefix, 'ipv6');
}

const publicAddress = (address: string): boolean => {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return publicAddress(mapped);
  const family = isIP(address);
  return Boolean(family) && !PRIVATE.check(address, family === 6 ? 'ipv6' : 'ipv4');
};

async function resolvesOnlyPublic(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((entry) => entry.address);
  return addresses.length > 0 && addresses.every(publicAddress);
}

/** Defense-in-depth validation at the browser process, not only the dashboard API. */
export async function assertExternalJobUrl(raw: string): Promise<string> {
  if (!raw || raw.length > 2_048) throw new Error('The direct external job URL is missing or too long.');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('The direct external job URL is invalid.');
  }
  if (url.protocol !== 'https:') throw new Error('The direct external job URL must use HTTPS.');
  if (url.username || url.password || (url.port && url.port !== '443')) throw new Error('The direct external job URL contains credentials or a custom port.');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('The direct external job URL is not a public website.');
  }
  if (isAustralianGovernmentUrl(url.href)) throw new Error('Australian government application sites are excluded.');
  if (/(^|\.)(seek\.com\.au|seek\.com|indeed\.com)$/.test(host)) throw new Error('A direct external run cannot target a SEEK or Indeed listing.');
  if (/\/(?:checkout|payment|billing)(?:\/|$)/i.test(url.pathname)) throw new Error('Payment pages cannot be used as a direct job URL.');
  if (!(await resolvesOnlyPublic(host))) throw new Error('The direct external job URL does not resolve only to public internet addresses.');
  return url.href;
}

/**
 * Re-check every document navigation, including redirects and tabs opened by
 * the ATS. This keeps a public URL from redirecting the production browser to
 * localhost, cloud metadata, a private network, government, or payment pages.
 */
export async function guardExternalNavigations(context: BrowserContext): Promise<{ blocked: () => string | null }> {
  let blocked: string | null = null;
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (request.resourceType() !== 'document') return route.continue();
    try {
      await assertExternalJobUrl(request.url());
      return route.continue();
    } catch (error) {
      blocked = (error as Error).message;
      return route.abort('blockedbyclient');
    }
  });
  return { blocked: () => blocked };
}
