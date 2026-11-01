import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-credential-fixture-'));
const before = process.env.DATA_DIR;
process.env.DATA_DIR = directory;
const { storedCredential, stagePendingCredential, pendingCredential, markPendingVerification, discardPendingCredential, acceptPendingCredential } = await import('./site-credentials.js');
const email = 'candidate@fixture.invalid';
const credential = { format: 'readable-v1' as const, rules: { max_length: 16 } };
try {
  stagePendingCredential('https://employer.fixture.invalid', email, 'Fixture Employer', 'reset_password', credential);
  assert.equal(storedCredential('https://employer.fixture.invalid', email), null, 'field preparation does not persist credentials');
  assert.equal(acceptPendingCredential('https://employer.fixture.invalid', 'other@fixture.invalid', 'Fixture Employer', 'reset_password'), false);
  assert.equal(storedCredential('https://employer.fixture.invalid', email), null, 'another candidate acceptance cannot authorize this credential');
  assert.equal(acceptPendingCredential('https://www.employer.fixture.invalid', email, 'Fixture Employer', 'reset_password', credential), true);
  assert.deepEqual(storedCredential('https://employer.fixture.invalid', email)?.rules, credential.rules, 'an explicitly accepted reset persists with canonical host identity');
  assert.equal(acceptPendingCredential('https://employer.fixture.invalid', email, 'Fixture Employer', 'reset_password', credential), false, 'accepted proposals are retired so later acceptance cannot recommit them');
  assert.equal(storedCredential('https://different.fixture.invalid', email), null);
  const url = 'https://employer.fixture.invalid', employer = 'Fixture Employer';
  stagePendingCredential(url, email, employer, 'create_account', credential);
  assert.equal(markPendingVerification(url, email, employer, 'create_account'), true);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import {pendingCredential} from ${JSON.stringify(new URL('./site-credentials.js', import.meta.url).href)}; console.log(JSON.stringify(pendingCredential(${JSON.stringify(url)},${JSON.stringify(email)},${JSON.stringify(employer)},'create_account')))`], { env: { ...process.env, DATA_DIR: directory }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout.trim()).phase, 'needs_verification', 'pending state survives a new worker process');
  assert.deepEqual(pendingCredential(url, email, '  FIXTURE   EMPLOYER ', 'create_account')?.rules, credential.rules);
  assert.equal(pendingCredential(url, 'other@fixture.invalid', employer, 'create_account'), null);
  assert.equal(pendingCredential(url, email, 'Another Employer', 'create_account'), null, 'shared ATS host is not enough to recover another employer proposal');
  assert.equal(pendingCredential('https://other.fixture.invalid', email, employer, 'create_account'), null);
  assert.equal(pendingCredential(url, email, employer, 'reset_password'), null);
  assert.equal(markPendingVerification(url, email, employer, 'reset_password'), false, 'a reset email alone cannot create a credential');
  stagePendingCredential(url, email, employer, 'create_account', { format: 'readable-v1', rules: { max_length: 24 } });
  discardPendingCredential(url, email, employer, 'create_account');
  assert.deepEqual(pendingCredential(url, email, employer, 'create_account')?.rules, credential.rules, 'duplicate registration cannot replace or erase activation-pending credentials');
  assert.deepEqual(storedCredential(url, email)?.rules, credential.rules, 'pending state never displaces accepted credentials');
  stagePendingCredential(url, email, employer, 'reset_password', { format: 'readable-v1', rules: { max_length: 20 } });
  markPendingVerification(url, email, employer, 'reset_password');
  discardPendingCredential(url, email, employer, 'reset_password');
  assert.equal(pendingCredential(url, email, employer, 'reset_password'), null, 'rejected prepared reset is retired');
  assert.equal(acceptPendingCredential(url, email, employer, 'create_account', credential), true);
  assert.equal(pendingCredential(url, email, employer, 'create_account'), null);
  const old = { format: 'readable-v1' as const, rules: { max_length: 18 } };
  stagePendingCredential(url, email, employer, 'reset_password', old);
  stagePendingCredential(url, email, employer, 'reset_password', credential);
  assert.equal(markPendingVerification(url, email, employer, 'reset_password', old), false, 'late verification cannot mark a replacement proposal');
  discardPendingCredential(url, email, employer, 'reset_password', old);
  assert.deepEqual(pendingCredential(url, email, employer, 'reset_password')?.rules, credential.rules, 'late rejection cannot delete a replacement proposal');
  assert.equal(acceptPendingCredential(url, email, employer, 'reset_password', old), false, 'late acceptance cannot promote or delete a replacement proposal');
  assert.deepEqual(pendingCredential(url, email, employer, 'reset_password')?.rules, credential.rules);
  assert.equal(acceptPendingCredential(url, email, employer, 'reset_password', credential), true);
  assert.equal(pendingCredential(url, email, employer, 'reset_password'), null);
  // Separate processes, one owner directory: exercise actual kernel locks,
  // not just JavaScript promise ordering or a mocked file writer.
  const workers = Array.from({ length: 4 }, (_, owner) => {
    const code = `import {stagePendingCredential,markPendingVerification,acceptPendingCredential} from ${JSON.stringify(new URL('./site-credentials.js', import.meta.url).href)};
      process.send('ready');process.once('message',()=>{try{for(let n=0;n<12;n++){
        const site='worker-${owner}-'+n+'.fixture.invalid',email='parallel@fixture.invalid',proposal={format:'readable-v1',rules:{max_length:16}};
        stagePendingCredential('https://'+site,email,'Fixture Employer','create_account',proposal);
        markPendingVerification('https://'+site,email,'Fixture Employer','create_account');
        stagePendingCredential('https://accepted-'+site,email,'Fixture Employer','reset_password',proposal);
        if(!acceptPendingCredential('https://accepted-'+site,email,'Fixture Employer','reset_password',proposal))throw Error('Synthetic proposal was lost');
      }process.disconnect();}catch(error){console.error(error);process.exit(1);}});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, DATA_DIR: directory }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let errors = '';child.stderr!.on('data',chunk=>{errors+=chunk;});
    return { child, ready: new Promise<void>((done,fail)=>{child.once('message',()=>done());child.once('error',fail);child.once('exit',code=>{if(code)fail(new Error(errors));});}),
      exited: new Promise<void>((done,fail)=>{child.once('error',fail);child.once('exit',code=>code===0?done():fail(new Error(errors)));}) };
  });
  await Promise.all(workers.map(worker=>worker.ready));workers.forEach(worker=>worker.child.send('go'));
  await Promise.all(workers.map(worker=>worker.exited));
  for(let owner=0;owner<4;owner++)for(let n=0;n<12;n++){
    const site=`https://worker-${owner}-${n}.fixture.invalid`;
    assert.equal(pendingCredential(site,'parallel@fixture.invalid',employer,'create_account')?.phase,'needs_verification','no pending records lost between simultaneous workers');
    assert.deepEqual(storedCredential(site.replace('https://','https://accepted-'),'parallel@fixture.invalid')?.rules,credential.rules,'no accepted records lost between simultaneous workers');
  }
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync(${JSON.stringify(join(directory,'site-credentials-lock.sqlite'))});db.exec('BEGIN IMMEDIATE');
    process.on('message',()=>{});process.send('locked');`], { stdio: ['ignore','ignore','ignore','ipc'] });
  await once(holder,'message');
  const waiting = spawn(process.execPath, ['--input-type=module', '-e', `import {stagePendingCredential} from ${JSON.stringify(new URL('./site-credentials.js',import.meta.url).href)};
    process.send('starting');stagePendingCredential('https://crash.fixture.invalid','parallel@fixture.invalid','Fixture Employer','create_account',{format:'readable-v1'});process.disconnect();`], { env:{...process.env,DATA_DIR:directory},stdio:['ignore','ignore','ignore','ipc'] });
  const waitingExit=once(waiting,'exit'),holderExit=once(holder,'exit');
  try {
    await once(waiting,'message');await new Promise(done=>setTimeout(done,100));
    assert.equal(waiting.exitCode,null,'a second worker must not bypass a live credential lock');
  } finally { holder.kill('SIGKILL');await holderExit; }
  assert.equal((await waitingExit)[0],0,'a crashed worker releases its lock without manual recovery');
  assert.ok(pendingCredential('https://crash.fixture.invalid','parallel@fixture.invalid',employer,'create_account'));
  const corrupt = '{interrupted or corrupt metadata';
  writeFileSync(join(directory, 'pending-site-credentials.json'), corrupt);
  assert.throws(() => stagePendingCredential(url, email, employer, 'create_account', credential));
  assert.equal(readFileSync(join(directory, 'pending-site-credentials.json'), 'utf8'), corrupt, 'corrupt metadata is preserved rather than silently overwritten');
  console.log('PASS: credential preparation, explicit password-reset acceptance, canonical hosts and candidate isolation.');
} finally {
  rmSync(directory, { recursive: true, force: true });
  if (before === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = before;
}
