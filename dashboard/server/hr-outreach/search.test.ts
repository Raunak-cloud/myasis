import assert from 'node:assert/strict';
import { getPool } from '../db/index.js';
import { reserveHrContactSearch } from './search.js';
import { createHiringContactSearch } from './discovery.js';
const client=await getPool().connect();
try{
 await client.query('BEGIN');
 await client.query('CREATE TEMP TABLE hr_contact_search_usage(day DATE PRIMARY KEY,calls INTEGER NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT now())');
 const db={query:async(sql:string,params?:any[])=>client.query(sql,params)};
 assert.equal(await reserveHrContactSearch(db,2),true);assert.equal(await reserveHrContactSearch(db,2),true);assert.equal(await reserveHrContactSearch(db,2),false);
 assert.equal((await client.query('SELECT calls FROM hr_contact_search_usage')).rows[0].calls,2);
 let requests=0;
 const search=createHiringContactSearch({key:'fixture-only',reserveSearch:()=>reserveHrContactSearch(db,2),network:async()=>{requests++;return Response.json({web:{results:[]}});}});
 await assert.rejects(search('recruitment contact'),/allowance|deferred/);assert.equal(requests,0,'no paid query is made after the HR allowance is exhausted');
 for(const limit of [0,501,NaN,1.5])await assert.rejects(reserveHrContactSearch(db,limit),/allowance/);
 await client.query("UPDATE hr_contact_search_usage SET day=current_date-1");assert.equal(await reserveHrContactSearch(db,2),true,'daily reservations roll over');
 console.log('PASS: separate bounded HR search allowance, atomic hard cap, daily rollover and no provider request when exhausted. TEMP tables only.');
}finally{await client.query('ROLLBACK');client.release();await getPool().end();}
