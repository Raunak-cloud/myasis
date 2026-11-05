import assert from 'node:assert/strict';
import {test} from 'node:test';
import {externalIndexUrl} from './config.js';
test('job catalog requires an external session-capable database with verified TLS',()=>{
  const url=externalIndexUrl('postgresql://fixture:fictional@ep-demo.ap-southeast-2.aws.neon.tech/owtomate_jobs?sslmode=require&channel_binding=require');
  assert.equal(new URL(url).searchParams.get('sslmode'),'verify-full');
  for(const value of ['postgresql://u:p@127.0.0.1/jobs?sslmode=require','postgresql://u:p@195.114.15.103/jobs?sslmode=require','postgresql://u:p@localhost/jobs?sslmode=require','postgresql://u:p@db.internal/jobs?sslmode=require','postgresql://u:p@ep-demo-pooler.aws.neon.tech/jobs?sslmode=require','postgresql://u:p@ep-demo.aws.neon.tech/jobs?sslmode=disable','postgresql://u:p@ep-demo.aws.neon.tech/jobs?sslmode=require&sslcert=/private/key'])assert.throws(()=>externalIndexUrl(value));
});
