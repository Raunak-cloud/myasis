import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getPool, one, query } from '../db/index.js';
import { applyImprovement, executionWorkspace, prepareImprovements, queueImprovement, rollbackImprovement } from './execution.js';
import { publishPageHtml } from './page-publisher.js';
import { healthReport } from './growth.js';
import { siteView, ownedSite } from './store.js';
import type { HealthPage } from '../../src/marketingTypes.js';

test('real page edits prepare, publish, verify and roll back; stale edits and cross-owner writes are refused',{skip:process.env.RUN_MARKETING_DB_TESTS!=='1'},async()=>{
  const schema=`website_qa_${randomUUID().replace(/-/g,'')}`;
  process.env.PGOPTIONS=`-c search_path=${schema}`;
  const pool=getPool(),oldAdmin=process.env.ADMIN_EMAILS,oldOrigin=process.env.APP_BASE_URL;
  const actualFetch=globalThis.fetch,oldKey=process.env.GEMINI_API_KEY,oldModel=process.env.BLOG_GEMINI_MODEL;
  process.env.ADMIN_EMAILS='website-admin@example.com';process.env.APP_BASE_URL='https://example.com';
  let base='<!doctype html><html lang="en"><head><title>Useful guide</title><meta name="description" content="A useful guide"><script type="application/ld+json">{"@type":"Organization"}</script></head><body><main><h1>Useful guide</h1><p>Useful information for customers.</p></main></body></html>';
  const server=createServer((_req,res)=>{void publishPageHtml(base,'/').then(html=>{res.setHeader('Content-Type','text/html');res.end(html);}).catch(()=>{res.statusCode=500;res.end();});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address() as {port:number};
  const readPage=async()=>{const response=await actualFetch(`http://127.0.0.1:${address.port}/`);assert.equal(response.status,200);return response.text();};
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    const sql=readFileSync(new URL('../db/schema.sql',import.meta.url),'utf8');await pool.query(sql);await pool.query(sql);
    const users=await query<{id:string}>("INSERT INTO users(email) VALUES('website-admin@example.com'),('other@example.com') RETURNING id");
    const user=users[0].id,other=users[1].id,site=randomUUID();
    const page={url:'https://example.com/',requestedUrl:'https://example.com/',status:200,title:'Useful guide',description:'A useful guide',canonical:'',robotsMeta:'',xRobotsTag:'',h1:['Useful guide'],wordCount:100,text:'Useful information for customers.',links:[],jsonLdTypes:['Organization'],invalidJsonLd:0,imagesWithoutAlt:0,lang:'en',error:null} satisfies HealthPage;
    const health=healthReport({checkedAt:new Date().toISOString(),pages:[page],robots:{url:'https://example.com/robots.txt',status:200,body:''},sitemaps:[{url:'https://example.com/sitemap.xml',status:200,urls:[page.url],error:null}],gaps:[]},page.url);
    await query("INSERT INTO marketing_sites(id,user_id,url,cta_url,publisher,profile_confirmed,health) VALUES($1,$2,$3,$3,'owtomate',true,$4)",[site,user,page.url,health]);
    assert.equal((await prepareImprovements(user,site,readPage)).prepared,1);
    const getChanges=async()=>(await executionWorkspace(user,siteView(await ownedSite(user,site)),true)).changes;
    const change=(await getChanges())[0];assert.equal(change.status,'proposed');assert.equal(change.original.canonical,'');
    assert.ok(!(await readPage()).includes('rel="canonical"'));
    await assert.rejects(applyImprovement(other,site,change.id,readPage),/not found/);
    assert.equal((await applyImprovement(user,site,change.id,readPage)).passed,true);
    assert.equal((await getChanges())[0].status,'verified');assert.match(await readPage(),/rel="canonical" href="https:\/\/example.com\/"/);
    assert.equal((await one('SELECT status FROM marketing_action_states WHERE site_id=$1 AND action_id=$2',[site,change.actionId]))?.status,'done');
    assert.equal((await applyImprovement(user,site,change.id,readPage)).passed,true,'Recovered apply verifies without duplicating the edit');
    // An unconfirmed new profile must never prevent undoing an existing edit.
    await query('UPDATE marketing_sites SET profile_confirmed=false WHERE id=$1',[site]);
    assert.equal((await rollbackImprovement(user,site,change.id,readPage)).passed,true);
    assert.equal((await getChanges())[0].status,'rolled_back');assert.equal(await readPage(),base);
    assert.equal((await rollbackImprovement(user,site,change.id,readPage)).passed,true,'Recovered rollback is idempotent');
    await query('UPDATE marketing_sites SET profile_confirmed=true WHERE id=$1',[site]);
    await prepareImprovements(user,site,readPage);
    const stale=(await getChanges()).find(c=>c.status==='proposed')!;
    base=base.replace('Useful information','Changed information');
    await assert.rejects(applyImprovement(user,site,stale.id,readPage),/page changed/);
    assert.equal((await getChanges()).find(c=>c.id===stale.id)?.status,'conflict');assert.equal(await readPage(),base);
    await prepareImprovements(user,site,readPage);
    const current=(await getChanges()).find(c=>c.status==='proposed')!;
    await assert.rejects(applyImprovement(user,site,current.id,readPage,true,true),/paused/);
    await applyImprovement(user,site,current.id,readPage);
    await query('UPDATE marketing_page_patches SET patch=$2 WHERE site_id=$1',[site,{title:'A newer edit'}]);
    await assert.rejects(rollbackImprovement(user,site,current.id,readPage),/newer edit/);
    assert.match(await readPage(),/<title>A newer edit<\/title>/);
    // Queue uniqueness and owner scoping use the same constraints as the existing worker.
    await assert.rejects(queueImprovement(other,site,'prepare'),/not found/);
    await queueImprovement(user,site,'verify',current.id);
    await assert.rejects(queueImprovement(user,site,'verify',current.id),/in progress/);
    await query("UPDATE marketing_jobs SET status='done' WHERE site_id=$1",[site]);
    // Source-reviewed metadata and summaries must travel through the same public-serving adapter.
    await query('UPDATE marketing_page_patches SET patch=$2 WHERE site_id=$1',[site,{}]);
    const summary='This guide explains the available products and helps customers compare the information before choosing what fits their needs.';
    base=base.replace('</head>','<link rel="canonical" href="https://example.com/"></head>').replace('Changed information for customers.',summary);
    health.pages[0].canonical=page.url;await query('UPDATE marketing_sites SET health=$2 WHERE id=$1',[site,health]);
    process.env.GEMINI_API_KEY='website-qa-key';process.env.BLOG_GEMINI_MODEL='gemini-qa';
    let exactSummary=true,approved=true;
    globalThis.fetch=(async(input,init)=>{
      assert.ok(String(input).includes('generativelanguage.googleapis.com'));
      const request=JSON.parse(String(init?.body));
      const answer=request.generationConfig.responseJsonSchema.properties.approved?{approved,issues:approved?[]:['Unsupported claim']}:{title:'Compare products with this useful guide',description:'Read the product guide and compare the information before choosing.',summary:exactSummary?summary:'An invented claim that is absent from the page and must never be accepted as an answer summary.'};
      return new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(answer)}]}}]}));
    }) as typeof fetch;
    assert.equal((await prepareImprovements(user,site,readPage)).prepared,1);
    const refresh=(await getChanges()).find(c=>c.status==='proposed')!;
    assert.equal(refresh.after.summary,summary);assert.equal((await applyImprovement(user,site,refresh.id,readPage)).passed,true);
    assert.match(await readPage(),/<title>Compare products with this useful guide<\/title>/);
    assert.ok((await readPage()).includes('data-marketing-enhancements="true"'));
    // A stale/cached public response keeps the write visible but removes the verified completion claim.
    assert.equal((await applyImprovement(user,site,refresh.id,async()=>base)).passed,false);
    assert.equal((await getChanges()).find(c=>c.id===refresh.id)?.status,'applied');
    assert.equal((await one('SELECT status FROM marketing_action_states WHERE site_id=$1 AND action_id=$2',[site,refresh.actionId]))?.status,'open');
    assert.equal((await applyImprovement(user,site,refresh.id,readPage)).passed,true);
    await rollbackImprovement(user,site,refresh.id,readPage);
    exactSummary=false;
    assert.equal((await prepareImprovements(user,site,readPage)).prepared,0);
    exactSummary=true;approved=false;
    assert.equal((await prepareImprovements(user,site,readPage)).prepared,0);
    assert.ok(!(await getChanges()).some(c=>c.status==='proposed'),'Unverified model proposals never reach the apply queue');
  } finally {
    await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
    if(oldAdmin===undefined) delete process.env.ADMIN_EMAILS;else process.env.ADMIN_EMAILS=oldAdmin;
    if(oldOrigin===undefined) delete process.env.APP_BASE_URL;else process.env.APP_BASE_URL=oldOrigin;
    globalThis.fetch=actualFetch;
    if(oldKey===undefined) delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=oldKey;
    if(oldModel===undefined) delete process.env.BLOG_GEMINI_MODEL;else process.env.BLOG_GEMINI_MODEL=oldModel;
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await pool.end();
  }
});
