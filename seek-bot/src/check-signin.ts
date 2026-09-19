import { launchBrowser, closeBrowser, getPage, ensureSignedIn, ensureIndeedSignedIn, type SigninSite } from './browser.js';

/**
 * Asks SEEK itself whether this profile is signed in, and records the answer.
 *
 * The dashboard used to take the person's word for it when they closed the
 * sign-in window. This opens the same profile the runs use, loads the same
 * profile page a run loads first, and writes the same `seek-session.json` —
 * so the Apply page shows what SEEK says, not what was clicked.
 *
 *   CHROME_PROFILE_DIR=… DATA_DIR=… SIGNIN_SITE=seek|indeed node dist/check-signin.js
 *
 * A lapsed session is signed back in with the account the browser already
 * holds (signin-agent.ts) before the answer is recorded.
 *
 * Exit 0: signed in. Exit 2: signed out. Exit 3: could not tell (nothing is
 * recorded then, so a slow page never overwrites a known-good state).
 */
async function main(): Promise<number> {
  const site: SigninSite = process.env.SIGNIN_SITE === 'indeed' ? 'indeed' : 'seek';
  const context = await launchBrowser();
  try {
    const page = await getPage(context);
    await (site === 'indeed' ? ensureIndeedSignedIn(page) : ensureSignedIn(page));
    console.log(`${site}: signed-in`);
    return 0;
  } catch (error) {
    const message = (error as Error).message ?? String(error);
    if (/not signed in/i.test(message)) {
      console.log(`signed-out: ${message}`);
      return 2;
    }
    console.log(`unclear: ${message}`);
    return 3;
  } finally {
    await closeBrowser(context).catch(() => {});
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.log(`unclear: ${(error as Error).message}`);
    process.exit(3);
  },
);
