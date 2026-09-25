import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/**
 * What a SOCKS5 proxy is, as this server will accept one: read from the way
 * providers hand them over, and only ever on the public internet.
 *
 * Shared by the per-account proxy an operator types in and the pool of
 * proxies synced from Webshare, so both obey the same rules.
 */

export interface ProxyDetails {
  host: string;
  port: number;
  username: string;
  password: string;
}

/**
 * Reads a proxy as a provider hands it over: `socks5://user:pass@host:port`,
 * or the `host:port:user:pass` lines of a downloaded proxy list. Only SOCKS5:
 * the switch speaks SOCKS to the exit, and a plain HTTP proxy cannot carry it.
 */
export function parseProxy(raw: string): ProxyDetails | string {
  const text = raw.trim();
  const parts = text.split(':');
  if (!text.includes('://') && parts.length === 4) {
    const [host, port, username, password] = parts;
    return checked({ host, port: Number(port), username, password });
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return 'Paste the proxy as socks5://username:password@host:port, or host:port:username:password.';
  }
  if (url.protocol !== 'socks5:' && url.protocol !== 'socks5h:') return 'Use the proxy\'s SOCKS5 address (socks5://…): the connection switch speaks SOCKS5, not HTTP.';
  return checked({
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  });
}

function checked(proxy: ProxyDetails): ProxyDetails | string {
  if (!proxy.host) return 'The proxy has no host.';
  if (!Number.isInteger(proxy.port) || proxy.port < 1 || proxy.port > 65535) return 'The proxy port must be a whole number from 1 to 65535.';
  if (!proxy.username || !proxy.password) return 'The proxy needs its username and password.';
  // RFC 1929 gives each one byte of length.
  if (Buffer.byteLength(proxy.username) > 255 || Buffer.byteLength(proxy.password) > 255) return 'The proxy username or password is too long.';
  return proxy;
}

export function proxyUrl(proxy: ProxyDetails): string {
  const host = isIP(proxy.host) === 6 ? `[${proxy.host}]` : proxy.host;
  return `socks5://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@${host}:${proxy.port}`;
}

/** host:port, the one thing two records of the same proxy always agree on. */
export function endpointOf(proxy: { host: string; port: number }): string {
  return `${proxy.host.toLowerCase()}:${proxy.port}`;
}

/** Everything that is this server's own network, or no one's. */
const PRIVATE = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]] as const) {
  PRIVATE.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [['::', 127], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) PRIVATE.addSubnet(net, bits, 'ipv6');

export function isPublic(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return isPublic(mapped);
  const family = isIP(address);
  if (!family) return false;
  return !PRIVATE.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

/** Whether every address the host resolves to is on the public internet. */
export async function resolvesPublic(host: string): Promise<boolean> {
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((entry) => entry.address);
  return addresses.length > 0 && addresses.every(isPublic);
}
