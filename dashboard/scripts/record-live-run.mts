/** Record an explicitly selected account's actual, one-application live run.
 * From repository root:
 * node --import ./seek-bot/node_modules/tsx/dist/loader.mjs dashboard/scripts/record-live-run.mts <account-id>
 * Raw footage and logs stay in ignored render_check/, never public/.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, createWriteStream, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const account = process.argv[2];
if (!account || !/^\d+$/.test(account)) throw new Error('Provide the account ID explicitly authorized for the live demo.');
const root = fileURLToPath(new URL('../../', import.meta.url));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const folder = resolve(root, 'render_check', `live-demo-${stamp}`);
const footage = resolve(folder, 'raw');
mkdirSync(footage, { recursive: true });
const log = createWriteStream(resolve(folder, 'run.log'));
const startedAt = Date.now();
const events: { elapsedSeconds: number; stream: string; text: string }[] = [];
writeFileSync(resolve(folder, 'source.json'), JSON.stringify({ account, startedAt: new Date(startedAt).toISOString(), mode: 'live', maxApplications: 1, source: 'dashboard/run-account.mjs', footage }, null, 2));
const child = spawn(process.execPath, [
  '--import', pathToFileURL(resolve(root, 'seek-bot/node_modules/tsx/dist/loader.mjs')).href,
  resolve(root, 'dashboard/run-account.mjs'), account, 'live',
  'MAX_APPS_PER_RUN=1', 'MAX_EVALUATIONS=40',
  'BROWSER_CONNECT_CDP=false', 'HEADLESS=false', 'BACKGROUND=true',
  'CAPTCHA_SOLVER=off', `RUN_VIDEO_DIR=${footage}`,
], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
for (const [name, stream] of [['out', child.stdout], ['err', child.stderr]] as const) {
  stream.on('data', (data: Buffer) => {
    const text = data.toString();
    log.write(text);
    events.push({ elapsedSeconds: (Date.now() - startedAt) / 1000, stream: name, text });
    // Summaries only: account/profile details stay in the local log.
    for (const line of text.split(/\r?\n/)) {
      if (/starting |discovered|shortlist|evaluat|submitted|rehearsed|needs.human|Fatal:|finished|Run complete|could not start|signed.in|verification|CAPTCHA/i.test(line)) console.log(line);
    }
  });
}
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('close', (code) => {
  log.end();
  writeFileSync(resolve(folder, 'events.json'), JSON.stringify(events, null, 2));
  console.log(`Recording folder: ${folder}`);
  console.log(`Run exited: ${code}`);
  process.exitCode = code ?? 1;
});
