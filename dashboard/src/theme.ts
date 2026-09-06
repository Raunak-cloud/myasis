export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'myasis-theme';

export function loadThemePref(): ThemePref {
  const v = localStorage.getItem(KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
}

export function saveThemePref(p: ThemePref) {
  p === 'system' ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, p);
}

/**
 * Applies a preference to the document.
 *
 * "system" removes the attribute entirely rather than resolving it here, so the
 * CSS `prefers-color-scheme` media query stays in charge — that way the page
 * follows the OS live, including its own time-of-day scheduling, without the
 * app polling anything.
 */
export function applyTheme(p: ThemePref) {
  const root = document.documentElement;
  if (p === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', p);
}

/** What the user will actually see right now, given the preference. */
export function resolvedTheme(p: ThemePref): 'light' | 'dark' {
  if (p !== 'system') return p;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
