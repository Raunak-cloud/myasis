import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

test('unlimited access lifts the per-run application cap while keeping the daily and review limits', () => {
  const source = `import {config} from ${JSON.stringify(new URL('./config.js', import.meta.url).href)};
    console.log(JSON.stringify([config.limits.maxApplicationsPerRun===Infinity,config.limits.maxApplicationsPerDay,config.limits.maxEvaluations,config.limits.pagesPerKeyword]));`;
  for (const unlimited of ['true', 'false']) {
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, ADMIN_UNLIMITED: 'false', APPLICATIONS_UNLIMITED: unlimited,
        MAX_APPS_PER_RUN: 'none', MAX_APPS_PER_DAY: 'none', MAX_EVALUATIONS: '80', PAGES_PER_KEYWORD: '999' }, encoding: 'utf8',
    });
    assert.deepEqual(JSON.parse(result.trim().split('\n').at(-1)!), [unlimited==='true',100,80,null]);
  }
});

test('actual runner config enforces age, selected daily cap and no retired search depth for customers and admins', () => {
  const source = `import {config} from ${JSON.stringify(new URL('./config.js', import.meta.url).href)};
    console.log(JSON.stringify([config.rules.maxAgeDays,config.limits.maxApplicationsPerDay,config.limits.pagesPerKeyword]));`;
  for (const admin of ['true', 'false']) for (const unlimited of ['true', 'false']) for (const [age, daily, pages] of [['30','100','6'], ['999','999','999'], ['30','none','6'], ['30','','6']]) {
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, ADMIN_UNLIMITED: admin, APPLICATIONS_UNLIMITED: unlimited,
        MAX_AGE_DAYS:age, MAX_APPS_PER_DAY:daily, PAGES_PER_KEYWORD:pages }, encoding:'utf8',
    });
    assert.deepEqual(JSON.parse(result.trim().split('\n').at(-1)!), [30,100,null]);
  }
});


test('ordinary runners can use the complete daily allowance without the old ten-application ceiling', () => {
  const source = `import {config} from ${JSON.stringify(new URL('./config.js', import.meta.url).href)};
    console.log(JSON.stringify([config.limits.maxApplicationsPerRun,config.limits.maxApplicationsPerDay]));`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, ADMIN_UNLIMITED:'false', APPLICATIONS_UNLIMITED:'false', MAX_APPS_PER_RUN:'100', MAX_APPS_PER_DAY:'100' }, encoding:'utf8',
  });
  assert.deepEqual(JSON.parse(output.trim().split('\n').at(-1)!), [100,100]);
});

test('a bounded sponsored review allowance lifts reviews only and does not leak to the next runner', () => {
  const source = `import {config} from ${JSON.stringify(new URL('./config.js', import.meta.url).href)};
    console.log(JSON.stringify([config.limits.maxEvaluations,config.limits.maxApplicationsPerRun,config.limits.maxApplicationsPerDay]));`;
  for (const [marker, expected] of [['400',400],['401',150],['',150]]) {
    const output=execFileSync(process.execPath,['--input-type=module','-e',source],{
      env:{...process.env,ADMIN_UNLIMITED:'false',APPLICATIONS_UNLIMITED:'false',OPERATOR_MAX_EVALUATIONS:String(marker),MAX_EVALUATIONS:'999',MAX_APPS_PER_RUN:'999',MAX_APPS_PER_DAY:'999'},encoding:'utf8'});
    assert.deepEqual(JSON.parse(output.trim().split('\n').at(-1)!),[expected,100,100]);
  }
});
