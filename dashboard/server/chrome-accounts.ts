import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { userChromeDir } from './userdata.js';

/**
 * Google accounts signed in inside an account's own Chrome profile.
 *
 * Chrome records every Google account the profile has signed into — including
 * a plain web sign-in to Gmail, not only signing into the browser itself — in
 * `account_info` in its Preferences file. That is ordinary JSON, so this needs
 * no browser, no cookie decryption and no dependency: the file either names an
 * account or it does not.
 *
 * Used to decide whether to ask someone to connect Gmail at all. If the agent
 * can already read the inbox through the browser it is driving, the OAuth
 * prompt is asking for something it does not need.
 */
export function chromeGoogleAccounts(userId: string): string[] {
  const preferences = resolve(userChromeDir(userId), 'Default', 'Preferences');
  if (!existsSync(preferences)) return [];
  try {
    const parsed = JSON.parse(readFileSync(preferences, 'utf8')) as {
      account_info?: Array<{ email?: unknown }>;
    };
    if (!Array.isArray(parsed.account_info)) return [];
    return parsed.account_info
      .map((entry) => (typeof entry.email === 'string' ? entry.email.trim() : ''))
      .filter(Boolean);
  } catch {
    // A profile mid-write, or a Chrome that changed the format: treat it as
    // "nothing known", which only ever costs an unnecessary prompt.
    return [];
  }
}
