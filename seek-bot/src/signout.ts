import { launchBrowser, closeBrowser, recordSiteSession, type SigninSite } from './browser.js';

/**
 * Signs this profile out of a job board, because the person asked to.
 *
 * Done by forgetting the board's cookies rather than pressing its sign-out
 * link: that works whatever the board's pages look like this month, and it
 * leaves everything else in the profile — the Google session, other boards —
 * as it was. The sign-out is recorded as the person's own, which is what stops
 * the next check from quietly signing them straight back in; it stays that way
 * until they sign in again themselves.
 *
 *   CHROME_PROFILE_DIR=… DATA_DIR=… SIGNIN_SITE=seek|indeed node dist/signout.js
 */
const DOMAINS: Record<SigninSite, RegExp> = {
  // SEEK's session lives on the site and on its sign-in host.
  seek: /(^|\.)seek\.com(\.au)?$/,
  indeed: /(^|\.)indeed\.com$/,
};

async function main(): Promise<void> {
  const site: SigninSite = process.env.SIGNIN_SITE === 'indeed' ? 'indeed' : 'seek';
  const context = await launchBrowser();
  try {
    await context.clearCookies({ domain: DOMAINS[site] });
    recordSiteSession(site, false, { signedOutByPerson: true });
    console.log(`${site}: signed out at the person's request`);
  } finally {
    await closeBrowser(context).catch(() => {});
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.log(`sign-out failed: ${(error as Error).message}`);
    process.exit(1);
  },
);
