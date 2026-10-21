import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

test('CLI search is capped at three titles even for unlimited admin runs', () => {
  for (const unlimited of ['false', 'true']) {
    const source = `import {config} from ${JSON.stringify(new URL('./config.js', import.meta.url).href)}; console.log(JSON.stringify(config.keywords));`;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, ADMIN_UNLIMITED: unlimited, KEYWORDS: ' AI Engineer, , Web Developer, Python Developer, Frontend Developer ' },
      encoding: 'utf8',
    });
    assert.deepEqual(JSON.parse(output.trim().split('\n').at(-1)!), ['AI Engineer', 'Web Developer', 'Python Developer']);
  }
});
