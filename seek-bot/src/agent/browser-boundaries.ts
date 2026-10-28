import { isExternalApplicationUrl } from '../job-board-url.js';
export const isExternal = isExternalApplicationUrl;

/** Payment flows remain outside employer authentication. */
const FORBIDDEN_URL = /\/(checkout|payment|billing)\b/i;

export function isForbiddenDestination(url: string): boolean {
  return FORBIDDEN_URL.test(url);
}
