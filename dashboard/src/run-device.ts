export type RunDevice = 'mobile' | 'desktop' | 'tablet';

/** The browser that pressed Start, never the server that submits applications. */
export function runDeviceFromHeaders(headers: Record<string, string | string[] | undefined>): RunDevice | null {
  const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? '' : value ?? '';
  const ua = first(headers['user-agent']).slice(0, 400);
  const mobile = first(headers['sec-ch-ua-mobile']).trim();
  if (/iPad|Tablet|Android(?!.*Mobi)/i.test(ua)) return 'tablet';
  if (mobile === '?1') return 'mobile';
  if (mobile === '?0') return 'desktop';
  if (/Mobi|iPhone|iPod/i.test(ua)) return 'mobile';
  if (/Mozilla\/.*(?:Windows|Macintosh|Mac OS X|X11|CrOS|Linux)/i.test(ua)) return 'desktop';
  return null;
}

export function runDeviceLabel(device: RunDevice | null, trigger: string): string {
  if (trigger === 'auto') return 'Scheduled';
  const label = device === 'mobile' ? 'Mobile' : device === 'desktop' ? 'Desktop' : device === 'tablet' ? 'Tablet' : 'Not recorded';
  return trigger === 'admin' ? `Admin · ${label}` : label;
}
