/** Reproducible, bounded, offline integration matrix using installed Chrome. */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { superviseRun } from '../../dashboard/server/run-watchdog.ts';
const repetitions = Number(process.argv.find(a => a.startsWith('--repeat='))?.slice(9) ?? 2);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) throw new Error('--repeat must be 1–10');
const output = resolve(process.env.FIXTURE_OUTPUT ?? `data/headless-fixtures/${Date.now()}`);
mkdirSync(output, { recursive: true, mode: 0o700 });
const results = [];
let current, interrupted = false;
const stop = () => { interrupted = true; current?.stop(); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
for (let n = 0; n < repetitions; n++) for (const mode of n % 2 ? ['headless', 'headed'] : ['headed', 'headless']) {
  if (interrupted) break;
  const directory = resolve(output, `${n + 1}-${mode}`);
  const child = spawn(process.execPath, ['dist/headless-fixtures.test.js', `--mode=${mode}`], { detached: process.platform !== 'win32', env: { ...process.env, FIXTURE_OUTPUT: directory, CDP_PORT: String(19800 + n), CHROME_PATH: process.env.CHROME_PATH ?? (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/usr/bin/google-chrome-stable') }, stdio: ['ignore', 'pipe', 'pipe'] });
  // Do not dump browser-launch stderr: it may contain inherited configuration.
  child.stdout.on('data', data => process.stdout.write(data)); child.stderr.resume();
  let timedOut = false;
  let code;
  current = superviseRun(child, { timeoutMs: 180_000, graceMs: 10_000,
    onTimeout: () => { timedOut = true; }, onEscalation: () => {},
    onError: () => { code = -1; }, onFinish: async exit => { code = exit; },
  });
  await current.finished; current = undefined;
  let result;
  try { result = JSON.parse(readFileSync(resolve(directory, 'result.json'), 'utf8')); }
  catch { result = { mode, ok: false, error: 'Worker did not produce a result', timedOut }; }
  results.push({ ...result, exitCode: code });
  writeFileSync(resolve(output, 'results.json'), JSON.stringify({ repetitions, results }, null, 2));
}
console.log(`Report: ${resolve(output, 'results.json')}`);
if (interrupted || results.some(r => !r.ok || r.exitCode !== 0)) process.exitCode = 1;
