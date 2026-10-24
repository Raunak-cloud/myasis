import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

test('customer unlimited access lifts only application caps, keeping review and search budgets', () => {
  const source = `import {config} from ${JSON.stringify(new URL('./config.js', import.meta.url).href)};
    console.log(JSON.stringify([config.limits.maxApplicationsPerRun===Infinity,config.limits.maxApplicationsPerDay===Infinity,config.limits.maxEvaluations,config.limits.pagesPerKeyword]));`;
  for (const unlimited of ['true', 'false']) {
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, ADMIN_UNLIMITED: 'false', APPLICATIONS_UNLIMITED: unlimited,
        MAX_APPS_PER_RUN: 'none', MAX_APPS_PER_DAY: 'none', MAX_EVALUATIONS: '80', PAGES_PER_KEYWORD: '999' }, encoding: 'utf8',
    });
    assert.deepEqual(JSON.parse(result.trim().split('\n').at(-1)!), [unlimited==='true',unlimited==='true',80,3]);
  }
});
