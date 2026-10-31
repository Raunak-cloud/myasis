import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {getPool} from './db/index.js';
import {sitePasswordFor} from './site-accounts.js';
import {userDir,USERS_DIR} from './userdata.js';
const owner='fixture-auth-'+randomUUID(),directory=userDir(owner),site='employer.fixture.invalid',email='candidate@fixture.invalid';
assert.ok(resolve(directory).startsWith(resolve(USERS_DIR)+sep));
assert.ok(!existsSync(directory));mkdirSync(directory,{recursive:true});
const pool=getPool(),originalQuery=pool.query,oldSecret=process.env.SITE_AUTH_SECRET;
pool.query=(async()=>({rows:[{site}]})) as unknown as typeof pool.query;
process.env.SITE_AUTH_SECRET='fixture-only-secret';
try{
 assert.equal(await sitePasswordFor(owner,site,email),null,'a site-account row alone cannot establish a password');
 const record=(status?:string)=>({[site+'|'+email]:{format:'readable-v1',...(status?{status}:{})}});
 const file=resolve(directory,'site-credentials.json');
 writeFileSync(file,JSON.stringify(record('accepted')));
 const known=await sitePasswordFor(owner,site,email);assert.ok(known);
 writeFileSync(file,JSON.stringify(record('rejected')));
 assert.equal(await sitePasswordFor(owner,site,email),null,'the dashboard must never display a rejected password as a usable login');
 assert.equal(await sitePasswordFor(owner,site,'other@fixture.invalid'),null);
 writeFileSync(file,JSON.stringify(record()));
 assert.equal(await sitePasswordFor(owner,site,email),known,'previously accepted metadata remains usable without a new schema field');
 console.log('PASS: dashboard password access requires accepted owner-scoped metadata; unknown and rejected records have no generated fallback. No database connection or account action.');
}finally{pool.query=originalQuery;await pool.end();if(oldSecret===undefined)delete process.env.SITE_AUTH_SECRET;else process.env.SITE_AUTH_SECRET=oldSecret;assert.ok(resolve(directory).startsWith(resolve(USERS_DIR)+sep));rmSync(directory,{recursive:true,force:true});}
