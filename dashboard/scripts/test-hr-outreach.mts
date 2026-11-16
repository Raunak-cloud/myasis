/** No real emails. PostgreSQL checks use TEMP tables and roll back. */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..');
const cli=resolve(root,'../seek-bot/node_modules/tsx/dist/cli.mjs');
const runs=[
  ['--test','server/hr-outreach/discovery.test.ts','server/hr-outreach/agent.test.ts','server/hr-outreach/transport.test.ts','server/hr-outreach/worker.test.ts','server/hr-outreach/worker-simulation.test.ts','server/hr-outreach/run-completion.test.ts'],
  ['server/hr-outreach/activity.test.ts'],['server/hr-outreach/store.test.ts'],
  ['scripts/test-hr-outreach-access.mts'],['scripts/test-hr-outreach-ui.mts'],
  ['--test','../seek-bot/src/hr-email-browser.test.ts'],
  ['--test','../seek-bot/src/gmail-source-run.test.ts','server/application-email.test.ts','server/auto-application-email.test.ts'],
];
for(const args of runs){const result=spawnSync(process.execPath,[cli,...args],{cwd:root,stdio:'inherit',timeout:90_000});if(result.error)throw result.error;if(result.status!==0)process.exit(result.status??1);}
console.log('PASS: complete HR outreach suite. No real mail sent.');
