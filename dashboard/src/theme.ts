export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'myasis-theme';

export function loadThemePref(): ThemePref {
  const v = localStorage.getItem(KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
}

export function saveThemePref(p: ThemePref) {
  if (p === 'system') localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, p);
}

const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Applies a preference to the document. Auto sets no attribute at all, so the
 * stylesheet's prefers-color-scheme rules follow the device — including a
 * device that switches itself at sunset — with no timer or listener here.
 */
export function applyTheme(p: ThemePref) {
  if (p === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', p);
}

/** What the user sees right now, given the preference. */
export function resolvedTheme(p: ThemePref): 'light' | 'dark' {
  if (p !== 'system') return p;
  return typeof window !== 'undefined' && window.matchMedia?.(DARK_QUERY).matches ? 'dark' : 'light';
}
