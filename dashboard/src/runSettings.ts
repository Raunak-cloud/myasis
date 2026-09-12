export const AUSTRALIAN_CITIES = [
  'Sydney',
  'Melbourne',
  'Brisbane',
  'Perth',
  'Adelaide',
  'Canberra',
  'Hobart',
  'Darwin',
  'Gold Coast',
  'Newcastle',
  'Wollongong',
  'Geelong',
  'Sunshine Coast',
  'Townsville',
  'Cairns',
  'Toowoomba',
  'Ballarat',
  'Bendigo',
  'Launceston',
  'Mackay',
  'Rockhampton',
  'Bunbury',
  'Coffs Harbour',
  'Wagga Wagga',
  'Albury',
  'Hervey Bay',
  'Mildura',
  'Shepparton',
  'Port Macquarie',
  'Gladstone',
] as const;

/** Store free text safely in the KEY=value environment passed to a run. */
export function encodeSettingText(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeSettingText(value: string): string {
  if (!value) return '';
  try {
    const binary = atob(value);
    return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  } catch {
    return '';
  }
}
