import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';
import config from '../vite.config.js';
import { getPool } from '../server/db/index.js';
import { userDir, USERS_DIR } from '../server/userdata.js';
import { accountRequest, accountUnavailable } from '../server/account-lifecycle.js';

const pool = getPool();
const client = await pool.connect();
const originalQuery = pool.query;
const originalConnect = pool.connect;
const originalOrigin = process.env.APP_BASE_URL;
const schema = `account_settings_api_${randomUUID().replaceAll('-','')}`;
const owner = `${Date.now()}01`, peer = `${Date.now()}02`;
const paths = [owner,peer].map(id => userDir(id));
const created: string[] = [];
let server: ReturnType<typeof createServer> | undefined;
try {
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}, public`);
  await client.query(readFileSync(new URL('../server/db/schema.sql',import.meta.url),'utf8'));
  await client.query("INSERT INTO users(id,email) VALUES($1,'owner@example.test'),($2,'peer@example.test')",[owner,peer]);
  await client.query("INSERT INTO sessions(token,user_id,expires_at) VALUES('owner-token',$1,now()+interval '1 day'),('peer-token',$2,now()+interval '1 day')",[owner,peer]);
  await client.query("INSERT INTO profiles(user_id,full_name) VALUES($1,'Owner'),($2,'Peer')",[owner,peer]);
  // Every real route query goes to this private schema, never to live accounts.
  pool.query = client.query.bind(client) as typeof pool.query;
  pool.connect = (async () => ({query:client.query.bind(client),release() {}})) as unknown as typeof pool.connect;
  const plugin = (config as {plugins:Plugin[]}).plugins.find(p=>p.name==='seek-bot-data-api')!;
  let handler: ((req:unknown,res:unknown,next:()=>void)=>void)|undefined;
  (plugin.configureServer as (server:ViteDevServer)=>void)({middlewares:{use(value:typeof handler) {handler??=value;}},httpServer:null} as unknown as ViteDevServer);
  server=createServer((req,res)=>{ Promise.resolve(handler!(req,res,()=>{res.statusCode=404;res.end();})).catch(()=>{res.statusCode=500;res.end();}); });
  await new Promise<void>(done=>server!.listen(0,'127.0.0.1',done));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  process.env.APP_BASE_URL=origin;
  const request=(path:string,method='GET',body?:unknown,cookie='owner-token',requestOrigin:string|null=origin,contentType='application/json')=>fetch(origin+path,{
    method,headers:{...(cookie?{cookie:`myasis_session=${cookie}`} : {}),...(requestOrigin?{origin:requestOrigin}:{}),...(body===undefined?{}:{'content-type':contentType})},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
  });
  for(const path of ['/api/daily-summary','/api/account']) assert.equal((await request(path,'GET',undefined,'')).status,401);
  assert.equal((await request('/api/daily-summary','DELETE')).status,405);
  assert.equal((await request('/api/account','POST',{})).status,405);
  assert.deepEqual(await (await request('/api/daily-summary')).json(),{enabled:true});
  assert.equal((await request('/api/daily-summary','POST',{enabled:'off'})).status,400);
  assert.equal((await request('/api/daily-summary','POST',{enabled:false},'owner-token','https://other.invalid')).status,403);
  assert.equal((await request('/api/daily-summary','POST',{enabled:false},'owner-token',null)).status,403);
  assert.deepEqual(await (await request(`/api/daily-summary?userId=${peer}`,'POST',{enabled:false,userId:peer})).json(),{enabled:false});
  assert.deepEqual(await (await request('/api/daily-summary','GET',undefined,'peer-token')).json(),{enabled:true},'another account keeps its summary preference');
  assert.deepEqual(await (await request('/api/email-alerts')).json(),{enabled:true},'attention alerts remain independent');
  assert.deepEqual(await (await request('/api/daily-summary','POST',{enabled:true})).json(),{enabled:true});
  assert.deepEqual(await (await request(`/api/account?userId=${peer}`)).json(),{email:'owner@example.test'});
  assert.equal((await request('/api/account','DELETE',{confirmEmail:'peer@example.test'})).status,400);
  for(const badOrigin of [null,'https://other.invalid','chrome-extension://fixture']) {
    assert.equal((await request('/api/account','DELETE',{confirmEmail:'owner@example.test'},'owner-token',badOrigin)).status,403);
  }
  assert.equal((await request('/api/account','DELETE',{confirmEmail:'owner@example.test'},'owner-token',origin,'text/plain')).status,403);
  for(const path of paths) {
    assert.equal(dirname(path),resolve(USERS_DIR));
    assert.equal(existsSync(path),false,'only create brand-new isolated fixture directories');
    mkdirSync(path,{recursive:true}); created.push(path); writeFileSync(resolve(path,'fixture-only.txt'),'isolated account fixture');
  }
  const site=randomUUID(),job=randomUUID();
  await client.query("INSERT INTO marketing_sites(id,user_id,url,cta_url) VALUES($1,$2,'https://fixture.invalid','https://fixture.invalid')",[site,owner]);
  await client.query("INSERT INTO marketing_jobs(id,site_id,user_id,kind,status,idempotency_key) VALUES($1,$2,$3,'research','running','api-fixture')",[job,site,owner]);
  const busy=await request('/api/account','DELETE',{confirmEmail:'owner@example.test'});
  assert.equal(busy.status,409);
  assert.equal(busy.headers.get('set-cookie'),null,'a failed deletion does not log out the owner');
  assert.equal((await request('/api/account')).status,200,'a refused deletion remains retryable');
  assert.equal(existsSync(paths[0]),true);
  await client.query("UPDATE marketing_jobs SET status='done'");
  let finishUpload!:()=>void;
  const upload=accountRequest(owner,()=>new Promise<void>(done=>{finishUpload=()=>{writeFileSync(resolve(paths[0],'last-upload.txt'),'private upload');done();};}));
  await Promise.resolve();
  const deleting=request(`/api/account?userId=${peer}`,'DELETE',{confirmEmail:' OWNER@example.test ',userId:peer});
  const deadline=Date.now()+5000;
  while(!accountUnavailable(owner) && Date.now()<deadline) await new Promise(done=>setTimeout(done,5));
  assert.equal(accountUnavailable(owner),true);
  assert.equal(existsSync(paths[0]),true,'a pending upload must settle before its account files are removed');
  finishUpload(); await upload;
  const deleted=await deleting;
  assert.equal(deleted.status,200);
  assert.deepEqual(await deleted.json(),{ok:true});
  assert.match(deleted.headers.get('set-cookie')??'',/myasis_session=;.*Max-Age=0/);
  assert.equal((await request('/api/account')).status,401,'all deleted-account sessions are invalid');
  assert.equal((await request('/api/daily-summary')).status,401);
  assert.equal((await client.query('SELECT * FROM users WHERE id=$1',[owner])).rowCount,0);
  assert.equal((await client.query('SELECT * FROM profiles WHERE user_id=$1',[owner])).rowCount,0);
  assert.equal(existsSync(paths[0]),false);
  assert.equal(existsSync(resolve(paths[1],'fixture-only.txt')),true);
  assert.deepEqual(await (await request('/api/account','GET',undefined,'peer-token')).json(),{email:'peer@example.test'});
  console.log('PASS: real account Settings API, private PostgreSQL schema, authentication, CSRF, strict values, email confirmation, busy/retry, owner isolation, session invalidation and file deletion.');
} finally {
  if(server) await new Promise<void>(done=>server!.close(()=>done()));
  pool.query=originalQuery; pool.connect=originalConnect;
  if(originalOrigin===undefined) delete process.env.APP_BASE_URL; else process.env.APP_BASE_URL=originalOrigin;
  await client.query('ROLLBACK').catch(()=>{});
  await client.query('SET search_path TO public');
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  client.release(); await pool.end();
  for(const path of created) {
    assert.equal(dirname(path),resolve(USERS_DIR));
    if(existsSync(resolve(path,'fixture-only.txt'))) rmSync(path,{recursive:true,force:true});
  }
}
