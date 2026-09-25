export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'myasis-theme';

export function loadThemePref(): ThemePref {
  const v = localStorage.getItem(KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
}

export function saveThemePref(p: ThemePref) {
  p === 'system' ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, p);
}

/** The hours, Sydney time, between which Auto is dark: from 7 pm until 7 am. */
const AUTO_DARK_FROM = 19;
const AUTO_DARK_UNTIL = 7;
const AUTO_TIME_ZONE = 'Australia/Sydney';

/**
 * What Auto means: dark in the evening and overnight, light in the day, by
 * the clock in Sydney rather than by the device. Every account is in
 * Australia and the device setting is often wrong (a laptop left on light
 * all day, a phone on dark all day), so the time of day is the honest
 * signal for a job-search tool used at night.
 */
function autoTheme(now: Date = new Date()): 'light' | 'dark' {
  const hour = Number(new Intl.DateTimeFormat('en-AU', { timeZone: AUTO_TIME_ZONE, hour: 'numeric', hour12: false }).format(now));
  return hour >= AUTO_DARK_FROM || hour < AUTO_DARK_UNTIL ? 'dark' : 'light';
}

/** Applies a preference to the document; Auto resolves to the time of day right now. */
export function applyTheme(p: ThemePref) {
  document.documentElement.setAttribute('data-theme', resolvedTheme(p));
}

/** What the user will actually see right now, given the preference. */
export function resolvedTheme(p: ThemePref): 'light' | 'dark' {
  return p === 'system' ? autoTheme() : p;
}
