import { existsSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { isIP } from 'node:net';
import { JobIndexStore } from './store.js';
import {readEnv} from '../runner.js';

export interface JobIndexConfig { indexUrl: string; appReadUrl: string; braveKey?: string }
/** The catalog must be off-VPS, with verified TLS and a session-capable URL. */
export function externalIndexUrl(value:string):string {
  const u=new URL(value);
  if(!['postgres:','postgresql:'].includes(u.protocol)||!u.username||!u.password||u.pathname==='/')throw Error('Use a hosted PostgreSQL connection URL.');
  if(isIP(u.hostname.replace(/^\[|\]$/g,''))||!u.hostname.includes('.')||/(^|\.)(?:localhost|local|internal|test|invalid)\.?$/i.test(u.hostname))throw Error('The job database must be hosted externally, outside the VPS.');
  if(!/\.neon\.tech$/i.test(u.hostname))throw Error('Use the direct connection URL from the separate Neon project.');
  if(/-pooler\./i.test(u.hostname)||u.port==='6543')throw Error('Use the direct database URL; transaction poolers cannot preserve crawler locks.');
  for(const key of u.searchParams.keys())if(!['sslmode','channel_binding'].includes(key))throw Error('Use the standard direct TLS connection URL without extra connection options.');
  if(!['require','verify-full'].includes(u.searchParams.get('sslmode')??''))throw Error('The external database requires verified TLS.');
  u.searchParams.set('sslmode','verify-full');return u.href;
}
export function indexConfig():JobIndexConfig|null {
  const path=process.env.JOB_INDEX_CONFIG??'/etc/owtomate-job-index.json';
  if(!existsSync(path))return null;
  const config=JSON.parse(readFileSync(path,'utf8')) as JobIndexConfig;
  const env=readEnv();config.indexUrl=(process.env.JOB_INDEX_DATABASE_URL??env.JOB_INDEX_DATABASE_URL??config.indexUrl??'').trim();
  config.braveKey=(process.env.BRAVE_SEARCH_API_KEY??env.BRAVE_SEARCH_API_KEY??config.braveKey??'').trim();
  if(!config.indexUrl)return null;
  config.indexUrl=externalIndexUrl(config.indexUrl);
  const index=new URL(config.indexUrl),app=new URL(config.appReadUrl);
  if(!['postgres:','postgresql:'].includes(app.protocol)||index.hostname===app.hostname)throw Error('The job index requires an external database separate from the application database.');
  return config;
}
let store:JobIndexStore|undefined;
let storeUrl='';
export function indexStore():JobIndexStore|null {
  const config=indexConfig();if(!config)return null;
  if(!store||storeUrl!==config.indexUrl) {if(store)void store.pool.end().catch(()=>{});storeUrl=config.indexUrl;const pool=new pg.Pool({connectionString:config.indexUrl,max:3,connectionTimeoutMillis:15_000,idleTimeoutMillis:10_000});pool.on('error',()=>console.warn('[job-index] database connection unavailable'));store=new JobIndexStore(pool); }
  return store;
}
export function appReader(config:JobIndexConfig):pg.Pool {
  const pool=new pg.Pool({connectionString:config.appReadUrl,max:2,connectionTimeoutMillis:5000,options:'-c default_transaction_read_only=on',idleTimeoutMillis:10_000});
  pool.on('error',()=>console.warn('[job-index] account read connection unavailable'));return pool;
}
