import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,rmdirSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markHrActive,hrActive } from './activity.js';
const directory=mkdtempSync(join(tmpdir(),'hr-outreach-activity-'));
const old=process.env.OWTOMATE_RUN_SERVICE_DIR;process.env.OWTOMATE_RUN_SERVICE_DIR=directory;
try{
  assert.equal(hrActive(),false);const clear=markHrActive();assert.equal(hrActive(),true);clear();assert.equal(hrActive(),false);
  writeFileSync(join(directory,'hr-outreach-active.json'),JSON.stringify({pid:2147483647}));assert.equal(hrActive(),false,'crash marker cannot permanently block deployment');
  writeFileSync(join(directory,'hr-outreach-active.json'),'bad-json');assert.equal(hrActive(),false);
  console.log('PASS: deployment sees live HR work and ignores expired/corrupt activity markers.');
}finally{if(old===undefined)delete process.env.OWTOMATE_RUN_SERVICE_DIR;else process.env.OWTOMATE_RUN_SERVICE_DIR=old;rmSync(join(directory,'hr-outreach-active.json'),{force:true});rmdirSync(directory);}
