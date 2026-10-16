import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { one } from '../db/index.js';
import { readEnv } from '../runner.js';
import type { WebsitePatch } from '../../src/marketingTypes.js';
import { applyPagePatch, editablePath } from './page-edits.js';

function origin() {try {return new URL(process.env.APP_BASE_URL || readEnv().APP_BASE_URL || 'https://owtomate.com').origin;} catch {return 'https://owtomate.com';}}
export async function publicPagePatch(path:string):Promise<WebsitePatch|null> {
  if(!editablePath(new URL(path,origin()).href,origin())) return null;
  const row=await one<{patch:WebsitePatch}>(`SELECT p.patch FROM marketing_page_patches p JOIN marketing_sites s ON s.id=p.site_id
    WHERE s.publisher='owtomate' AND s.url=$1 AND p.path=$2`,[`${origin()}/`,path]);
  return row?.patch || null;
}
export async function publishPageHtml(html:string,path:string):Promise<string> {
  try {const patch=await publicPagePatch(path);return patch && Object.keys(patch).length?applyPagePatch(html,patch,new URL(path,origin()).href):html;}
  catch {return html;} // Keep the public site available when the database is unavailable. Verification will report missing edits.
}
export function improvedStaticPages(directory:string,transform?:(url:string,html:string)=>Promise<string>) {
  return (req:IncomingMessage,res:ServerResponse,next:(e?:unknown)=>void)=>{
    if(!['GET','HEAD'].includes(req.method || '')) return next();
    const path=new URL(req.url || '/','http://localhost').pathname;
    const file=path==='/'?'index.html':path==='/automate-job-applications-australia'?'automate-job-applications-australia.html':null;
    if(!file) return next();
    void (async()=>{
      let patch:WebsitePatch|null;
      try {patch=await publicPagePatch(path);} catch {return next();}
      if(!patch || !Object.keys(patch).length) return next();
      let html=readFileSync(resolve(directory,file),'utf8');
      if(transform) html=await transform(path,html);
      html=applyPagePatch(html,patch,new URL(path,origin()).href);
      res.statusCode=200;res.setHeader('Content-Type','text/html; charset=utf-8');
      res.setHeader('Cache-Control','no-store');res.setHeader('Vary','Cookie');
      res.end(req.method==='HEAD'?undefined:html);
    })().catch(next);
  };
}
