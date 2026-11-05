import assert from 'node:assert/strict';
import {test} from 'node:test';
import {externalIndexUrl} from './config.js';
import {readEnvSafe} from '../runner.js';
import {envReport} from '../env-settings.js';
test('Neon and Brave credentials stay masked in both configuration readers',()=>{
  const values=readEnvSafe({JOB_INDEX_DATABASE_URL:'postgresql://fixture:fictional@db.neon.tech/jobs',BRAVE_SEARCH_API_KEY:'fictional-provider-key'});
  assert.doesNotMatch(JSON.stringify(values),/fictional|postgresql:/);
  const entries=envReport().groups.flatMap(g=>g.entries);
  for(const name of ['JOB_INDEX_DATABASE_URL','BRAVE_SEARCH_API_KEY']){const e=entries.find(e=>e.key===name);assert.equal(e?.kind,'secret');assert.equal(e?.value,null);}
});
test('job catalog requires an external session-capable database with verified TLS',()=>{
  const url=externalIndexUrl('postgresql://fixture:fictional@ep-demo.ap-southeast-2.aws.neon.tech/owtomate_jobs?sslmode=require&channel_binding=require');
  assert.equal(new URL(url).searchParams.get('sslmode'),'verify-full');
  for(const value of ['postgresql://u:p@127.0.0.1/jobs?sslmode=require','postgresql://u:p@195.114.15.103/jobs?sslmode=require','postgresql://u:p@localhost/jobs?sslmode=require','postgresql://u:p@db.internal/jobs?sslmode=require','postgresql://u:p@ep-demo-pooler.aws.neon.tech/jobs?sslmode=require','postgresql://u:p@ep-demo.aws.neon.tech/jobs?sslmode=disable','postgresql://u:p@ep-demo.aws.neon.tech/jobs?sslmode=require&sslcert=/private/key'])assert.throws(()=>externalIndexUrl(value));
});
