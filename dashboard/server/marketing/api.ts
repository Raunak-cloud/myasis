import type { IncomingMessage, ServerResponse } from 'node:http';
import { one, query } from '../db/index.js';
import { isAdmin } from '../billing.js';
import { deploying } from '../runner.js';
import { writerConfig } from '../blog/models.js';
import { exportArticle } from './content.js';
import { isId } from './policy.js';
import { addTopic, createSite, enqueue, MarketingError, ownedSite, saveDraft, saveMetrics, setTopicStatus, siteView, updateSite, workspace } from './store.js';
import { beginReportingConnection, configureReporting, disconnectReporting, finishReportingConnection, availableProperties } from './google-results.js';
import { confirmRecommendation, queueVisibility, saveObservation, saveResultsSnapshot, updateAction } from './growth-store.js';
import { importResults, recordedResults } from './results.js';

export async function handleMarketing(req: IncomingMessage,res: ServerResponse,url: URL,user: {id:string;email:string},send:(body:unknown,status?:number)=>void,readBody:()=>Promise<unknown>) {
  res.setHeader('Cache-Control','no-store');
  const admin=isAdmin(user.email), method=req.method;
  if (!admin) return send({error:'Admins only.'},403);
  const parts=url.pathname.slice('/api/marketing/'.length).split('/').filter(Boolean);
  const body=async()=>{const value=await readBody();if(!value || typeof value!=='object' || Array.isArray(value)) throw new MarketingError('Enter valid form details.');return value as Record<string,unknown>;};
  const configured=()=>{if(!writerConfig()) throw new MarketingError('Gemini is not configured. Ask an admin to add its API key under Config → Weekly blog.',503);if(deploying()) throw new MarketingError('An update is being installed. Try again shortly.',503);};
  try {
    if(parts.join('/')==='google/callback' && method==='GET') {
      const result=await finishReportingConnection(user.id,url,req.headers.cookie);
      res.setHeader('Set-Cookie',result.cookie);res.statusCode=303;
      res.setHeader('Location',`/?tab=marketing&marketingConnection=${result.ok?'connected':'denied'}&marketingSite=${result.siteId}`);res.end();return;
    }
    if(parts[0]!=='sites') throw new MarketingError('Route not found.',404);
    if(parts.length===1) {
      if(method==='GET') return send({sites:(await query('SELECT * FROM marketing_sites WHERE user_id=$1 ORDER BY created_at DESC',[user.id])).map(r=>siteView(r as Parameters<typeof siteView>[0])),writerConfigured:Boolean(writerConfig()),websiteLimit:admin?20:3});
      if(method==='POST') {configured();return send({site:await createSite(user.id,admin,await body())},201);}
      throw new MarketingError('Method not supported.',405);
    }
    const siteId=parts[1];if(!isId(siteId)) throw new MarketingError('Website not found.',404);
    await ownedSite(user.id,siteId);
    if(parts.length===2) {
      if(method==='GET') return send(await workspace(user.id,siteId,admin));
      if(method==='PATCH') return send({site:await updateSite(user.id,siteId,admin,await body())});
    }
    if(parts.length===3 && method==='POST') {
      if(parts[2]==='growth') {configured();return send({job:await enqueue(user.id,siteId,admin,'growth')},202);}
      if(parts[2]==='health') {if(deploying()) throw new MarketingError('An update is being installed. Try again shortly.',503);return send({job:await enqueue(user.id,siteId,admin,'health')},202);}
      if(parts[2]==='visibility') {if(deploying()) throw new MarketingError('An update is being installed. Try again shortly.',503);return send({job:await queueVisibility(user.id,siteId,await body())},202);}
      if(parts[2]==='research') {configured();return send({job:await enqueue(user.id,siteId,admin,'research')},202);}
      if(parts[2]==='drafts') {configured();const b=await body();if(typeof b.topicId!=='string'||!isId(b.topicId)) throw new MarketingError('Choose a topic.');return send({job:await enqueue(user.id,siteId,admin,'write',b.topicId)},202);}
      if(parts[2]==='topics') {await addTopic(user.id,siteId,await body());return send({ok:true},201);}
    }
    if(parts[2]==='actions' && parts.length===4 && method==='PATCH') {await updateAction(user.id,siteId,parts[3],(await body()).status);return send({ok:true});}
    if(parts[2]==='observations') {
      if(parts.length===3 && method==='POST') return send(await saveObservation(user.id,siteId,await body()),201);
      if(parts.length===4 && isId(parts[3]) && method==='PATCH') {await confirmRecommendation(user.id,siteId,parts[3],(await body()).recommendationQuote);return send({ok:true});}
    }
    if(parts[2]==='google') {
      if(parts.length===4 && parts[3]==='connect' && method==='POST') {const result=await beginReportingConnection(user.id,siteId);res.setHeader('Set-Cookie',result.cookie);return send({url:result.url});}
      if(parts.length===4 && parts[3]==='properties' && method==='GET') return send(await availableProperties(user.id,siteId));
      if(parts.length===3 && method==='PATCH') {await configureReporting(user.id,siteId,await body());return send({ok:true});}
      if(parts.length===3 && method==='DELETE') {await disconnectReporting(user.id,siteId);return send({ok:true});}
    }
    if(parts[2]==='results' && parts.length===4 && method==='POST') {
      if(parts[3]==='sync') {if(deploying()) throw new MarketingError('An update is being installed. Try again shortly.',503);return send({job:await enqueue(user.id,siteId,admin,'results')},202);}
      if(parts[3]==='import' || parts[3]==='record') {
        const b=await body(),site=await ownedSite(user.id,siteId);
        let snapshot;try {snapshot=parts[3]==='import'?importResults(b,site.url):recordedResults(b);} catch(e) {throw new MarketingError((e as Error).message);}
        await saveResultsSnapshot(user.id,siteId,snapshot);return send({ok:true},201);
      }
    }
    const id=parts[3];if(!id || !isId(id)) throw new MarketingError('Item not found.',404);
    if(parts[2]==='topics' && parts.length===4 && method==='PATCH') {await setTopicStatus(user.id,siteId,id,(await body()).status);return send({ok:true});}
    if(parts[2]==='posts') {
      if(parts.length===5 && parts[4]==='handled' && method==='PATCH') {
        const b=await body();if(typeof b.handled!=='boolean') throw new MarketingError('Choose whether this draft is handled.');
        const saved=await query("UPDATE marketing_posts SET handled_at=CASE WHEN $4::boolean THEN now() ELSE NULL END,updated_at=now() WHERE id=$1 AND site_id=$2 AND user_id=$3 AND status='draft' RETURNING id",[id,siteId,user.id,b.handled]);
        if(!saved.length) throw new MarketingError('Unpublished draft not found.',404);return send({ok:true});
      }
      if(parts.length===4 && method==='PATCH') return send({post:await saveDraft(user.id,siteId,id,await body())});
      if(parts.length===5 && method==='POST' && (parts[4]==='review'||parts[4]==='publish')) {configured();return send({job:await enqueue(user.id,siteId,admin,parts[4],undefined,id)},202);}
      if(parts.length===5 && parts[4]==='metrics' && method==='PATCH') {await saveMetrics(user.id,siteId,id,await body());return send({ok:true});}
      if(parts.length===5 && parts[4]==='export' && method==='GET') {
        const post=await one('SELECT * FROM marketing_posts WHERE id=$1 AND site_id=$2 AND user_id=$3',[id,siteId,user.id]);
        if(!post?.article || !post.brief) throw new MarketingError('Draft not found.',404);
        const format=url.searchParams.get('format');if(format!=='html' && format!=='markdown') throw new MarketingError('Choose HTML or Markdown.');
        res.setHeader('Content-Type',format==='html'?'text/html; charset=utf-8':'text/markdown; charset=utf-8');
        res.setHeader('Content-Disposition',`attachment; filename="blog-${id}.${format==='html'?'html':'md'}"`);
        res.setHeader('X-Content-Type-Options','nosniff');res.end(exportArticle(post.article,post.brief,format));return;
      }
    }
    throw new MarketingError('Route or method not supported.',404);
  } catch(error) {
    if(error instanceof MarketingError) return send({error:error.message},error.status);
    if((error as {code?:string}).code==='23505') return send({error:'This item or website job already exists. Refresh your workspace.'},409);
    // Validation errors have no server details; unexpected DB/provider errors stay in server logs.
    const message=(error as Error).message;
    if(/^(The draft|A draft|Choose a|This focus|Edited draft)/.test(message)) return send({error:message},400);
    console.warn('[marketing] request failed:',message.slice(0,160));return send({error:'The request could not be completed. Refresh and try again.'},500);
  }
}
