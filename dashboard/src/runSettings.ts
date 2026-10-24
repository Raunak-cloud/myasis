import { CUSTOM_MIN_SCORE, MAX_MATCH_SCORE } from './pricing.js';

export function matchThresholdError(value: unknown, minimum = CUSTOM_MIN_SCORE): string | null {
  const text = String(value ?? '').trim();
  const score = Number(text);
  return text && Number.isFinite(score) && score >= minimum && score <= MAX_MATCH_SCORE
    ? null : `Match threshold must be between ${minimum}% and ${MAX_MATCH_SCORE}%.`;
}

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
