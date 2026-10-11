import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { releaseChromeProfile } from './chrome-profile.js';

test('Linux profile cleanup finds a browser argument and forces only that profile to close', {
  skip: process.platform !== 'linux', timeout: 15_000,
}, async () => {
  const profile = `/tmp/run-cleanup-${process.pid}-${Date.now()}`;
  const script = "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)";
  const browser = spawn(process.execPath, ['-e', script, '--', `--user-data-dir=${profile}`]);
  const other = spawn(process.execPath, ['-e', script, '--', `--user-data-dir=${profile}-other`]);
  const browserReady = once(browser.stdout!, 'data');
  const otherReady = once(other.stdout!, 'data');
  const browserExited = once(browser, 'exit');
  try {
    await Promise.all([browserReady, otherReady]);
    assert.equal(await releaseChromeProfile(profile), true);
    const [code, signal] = await browserExited;
    assert.equal(code, null);
    assert.equal(signal, 'SIGKILL');
    assert.doesNotThrow(() => process.kill(other.pid!, 0), 'a different profile must stay alive');
  } finally {
    browser.kill('SIGKILL');
    other.kill('SIGKILL');
  }
});
