import {readFileSync,appendFileSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {readEnv} from '../server/runner.js';
import {auditContactProvider,type AuditCompany} from '../server/hr-outreach/contact-provider-audit.js';
import {createHiringContactSearch,discoverHiringContact} from '../server/hr-outreach/discovery.js';
import {researchHiringContact} from '../server/hr-outreach/research.js';
import {HrPublicCrawler} from '../server/hr-outreach/public-crawler.js';

// Deliberately has no sender, mailbox, profile, application or HR-store imports.
// Source data belongs in the operator's output file, not in the repository.
const arg=(name:string)=>process.argv.find(value=>value.startsWith(`--${name}=`))?.slice(name.length+3);
if(!process.argv.includes('--live'))throw Error('Use --live to authorize metered, read-only provider requests. This script cannot send emails.');
const inputPath=arg('cases'),output=arg('output');
if(!inputPath||!output)throw Error('Supply --cases=/path/cases.json and --output=/path/results.jsonl.');
const outputPath=output;
const raw:unknown=JSON.parse(readFileSync(inputPath,'utf8'));
if(!Array.isArray(raw)||raw.some(row=>!row||typeof row.company!=='string'||!row.company.trim()))throw Error('Cases must be a JSON array with a company name on each row.');
const cases:AuditCompany[]=raw.slice(0,Math.max(1,Math.min(30,Number(arg('limit')??16)||16)));
const providerNames=(arg('providers')??'serper,hunter,apollo').split(',');
if(providerNames.some(name=>!['serper','hunter','apollo'].includes(name)))throw Error('Providers must be serper,hunter,apollo.');
const env={...readEnv(),...process.env},maxReveals=Math.max(0,Math.min(2,Number(arg('max-reveals')??1)||0));
const hunterDepartmentValue=arg('hunter-department')??'hr';
if(hunterDepartmentValue!=='hr'&&hunterDepartmentValue!=='all')throw Error('Hunter department must be hr or all.');
const hunterDepartment:'hr'|'all'=hunterDepartmentValue;
mkdirSync(dirname(output),{recursive:true});
const completed=new Set<string>();
try{for(const line of readFileSync(output,'utf8').split('\n').filter(Boolean)){const row=JSON.parse(line);if(row.outcome!=='not_configured')completed.add(`${row.company}\n${row.provider}`);}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
const concurrency=Math.max(1,Math.min(2,Number(arg('concurrency')??1)||1));
console.log(JSON.stringify({companies:cases.length,providers:providerNames,emailsEnabled:false,maximumApolloRevealsPerCompany:maxReveals,concurrency}));
async function compareCompany(item:AuditCompany){for(const provider of providerNames){
 if(completed.has(`${item.company}\n${provider}`))continue;
 let result:Record<string,unknown>;
 if(provider==='hunter'||provider==='apollo'){
  result={...await auditContactProvider(provider,item,{key:provider==='hunter'?env.HUNTER_API_KEY:env.APOLLO_API_KEY,maxReveals,hunterDepartment}),...(provider==='hunter'?{departmentFilter:hunterDepartment}:{})};
 }else if(!env.SERPER_API_KEY||!env.OPENROUTER_API_KEY){
  result={provider,company:item.company,outcome:'not_configured',contacts:[],calls:0,reason:!env.SERPER_API_KEY?'Serper key is not configured.':'The HR research model key is not configured.'};
 }else{
  const started=Date.now(),crawler=new HrPublicCrawler(),signal=AbortSignal.timeout(300_000);let calls=0;
  const search=createHiringContactSearch({provider:'serper',key:env.SERPER_API_KEY,reserveSearch:async()=>{calls++;return true;}});
  try{
   const input={company:item.company,website:item.domain?`https://${item.domain}/`:undefined,jobUrl:item.url,roleTitle:item.title,location:item.location,signal};
   const first=await discoverHiringContact(input,{search,crawler,maxPages:12});
   const found=await researchHiringContact(input,first,{search,crawler,apiKey:env.OPENROUTER_API_KEY});
   result={provider,company:item.company,outcome:found.outcome,contacts:found.contact?[found.contact]:[],calls,elapsedMs:Date.now()-started,modelCostUsd:found.costUsd,reason:found.reason,research:found.diagnostics.research,events:found.diagnostics.events};
  }catch{result={provider,company:item.company,outcome:'error',contacts:[],calls,elapsedMs:Date.now()-started,error:{code:signal.aborted?'cancelled_or_timeout':'request_or_response_failed'}};}
 }
 const row:Record<string,unknown>={...result,checkedAt:new Date().toISOString(),suitabilityRequiresReview:true};appendFileSync(outputPath,JSON.stringify(row)+'\n');
 console.log(JSON.stringify({provider,company:item.company,outcome:row.outcome,emailsReturned:Array.isArray(row.contacts)?row.contacts.length:0,calls:row.calls}));
}}
let nextCase=0;
await Promise.all(Array.from({length:concurrency},async()=>{while(nextCase<cases.length){const item=cases[nextCase++];await compareCompany(item);}}));
