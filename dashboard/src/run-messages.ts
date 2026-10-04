/**
 * Plain wording for reasons written before runs produced their own.
 *
 * Older rows hold the technical form — "model budget exhausted (21 calls ·
 * 339614 prompt (28% cached) · $0.05270)" — because that string was once the
 * only one a run produced. Runs now write a plain reason and keep the detail
 * in their log; this covers what is already stored. The final line strips a
 * meter summary from anything the patterns miss, so a token count can never
 * reach the page whatever the wording around it.
 */
const PLAIN: Array<[RegExp, string]> = [
  [/capmonster|captcha|cloudflare|security (?:check|verification)|anti-bot/i,
    "The site's security check could not be completed."],
  [/CELERIS_API_KEY|matching service is not configured|\bAPI[ _-]?key\b/i,
    'A service needed for this run is unavailable. Please try again later.'],
  [/AuthorMist|humanizer/i, 'The cover letter service is unavailable. Please try again later.'],
  [/browser has disconnected|has been closed|Target closed/i,
    'The application stopped unexpectedly. Please try again.'],
  [/net::ERR|ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed/i,
    'The connection was interrupted. Please try again.'],
  [/^\S+ is not attempted today:/i, "The employer's site is unavailable for applications today."],
  [/^The application (?:needed more steps|used up its allowance)/i,
    'This application could not be completed in this attempt.'],
  [/^model budget exhausted/i, 'This application could not be completed in this attempt.'],
  [/^step budget exhausted/i, 'This application could not be completed in this attempt.'],
  [/^stuck for \d+s/i, 'The page stopped responding to what the agent did.'],
  [/^overall time limit/i, 'The application ran out of time.'],
  [/^the agent stopped proposing/i, 'The agent could not work out a next step on this page.'],
  [/^stuck repeating/i, 'The agent kept repeating the same action with no effect.'],
  [/^no progress after six/i, 'The page did not change in response to anything the agent tried.'],
  [/^agent claimed submission/i, 'The application was not confirmed as submitted.'],
  [/^[a-z_]+ failed: /i, 'A step failed while filling in the application.'],
  [/^Fields not verified: (.+)/i, 'Required answers could not be confirmed: $1'],
  [/^the model could not ground \d+ answer\(s\): (.+)/i, 'These questions could not be answered from the profile: $1'],
  [/^submit is on an external site/i, "The application continues on the employer's own site."],
  /**
   * A thrown error, in the browser driver's own words.
   *
   * These reach the tab verbatim — "locator.click: Timeout 30000ms exceeded.
   * Call log: - waiting for locator('[data-automation=...]')" — which tells a
   * candidate nothing and reads like the product is broken. Matched loosely on
   * purpose: it is the shape of machinery talking, and every library has its
   * own. The original still goes to the run log.
   */
  [/^\w+\.\w+: |Timeout \d+ms exceeded|Call log:|net::ERR_|page\.goto|waiting for locator/i,
    'The page did not respond as expected, so the application stopped.'],
];

/** A meter summary, wherever it sits: "21 calls · 339614 prompt (28% cached) · 3042 completion · $0.05270". */
const METER = /\s*\(?\d+ calls · .*?\$\d+(?:\.\d+)?\)?/g;

export function plainReason(reason: string): string {
  const withoutInternalRefs = reason.replace(/\s*\([af]\d+(?::\d+)?\)/gi, '');
  let translated = withoutInternalRefs;
  for (const [pattern, wording] of PLAIN) {
    if (!pattern.test(withoutInternalRefs)) continue;
    /**
     * A wording with a "$1" keeps the part of the original it refers to —
     * the list of questions. Any other wording replaces the whole reason:
     * the original's tail is the technical part ("(24 steps)", the meter),
     * which is exactly what must not be shown.
     */
    translated = wording.includes('$1') ? withoutInternalRefs.replace(pattern, wording) : wording;
    break;
  }
  const plain = translated.replace(METER, '').trim();
  // Unknown diagnostic text must not become product copy, including provider
  // errors nested inside an otherwise readable reason.
  if (/\b(?:[A-Z][A-Z_]+_(?:KEY|TOKEN|URL)|[A-Za-z]+Error|HTTP\s*\d{3}|status(?: code)?[\s:=]+[45]\d{2})\b|\b(?:token|prompt|completion)\s*(?:count|budget|limit|[:=]\s*\d)|https?:\/\/|\bat .+\.(?:ts|js):\d+|\b(?:locator|page|browser|context)\.[a-z]+|Call log:|\b(?:selector|stack trace)\b/i.test(plain)) {
    return 'This step could not be completed. Please try again later.';
  }
  return plain;
}

