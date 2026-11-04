import { existsSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { hostOf, type SiteCredential } from './site-auth.js';
import { employerAccountSite, employerName, sharedEmployerHost } from './employer-account.js';

/**
 * How each employer-site account's password was made: its format and the
 * site's rules, never the password. Kept with the account's data so a later
 * run signs in with the same password and the dashboard can show it.
 */
const FILE = () => resolve(config.dataDir, 'site-credentials.json');
const key = (url: string, email: string, employer = '') => `${employerAccountSite(url, employer)}|${email.trim().toLowerCase()}`;
export type CredentialPurpose = 'create_account' | 'reset_password';
type PendingCredential = SiteCredential & { purpose: CredentialPurpose; phase: 'prepared' | 'needs_verification'; at: string };
const pendingFile = () => resolve(config.dataDir, 'pending-site-credentials.json');
// Shared ATS hosts serve several employers. Pending recovery must also match
// the employer, rather than adopting another tenant's unverified proposal.
const pendingKey = (url: string, email: string, employer: string, purpose: CredentialPurpose) =>
  JSON.stringify([employerAccountSite(url, employer), email.trim().toLowerCase(), employerName(employer), purpose]);
const legacyPendingKey = (url: string, email: string, employer: string, purpose: CredentialPurpose) =>
  JSON.stringify([hostOf(url), email.trim().toLowerCase(), employerName(employer), purpose]);
const matchesProposal = (value: SiteCredential, expected?: SiteCredential) => !expected
  || JSON.stringify([value.format, value.rules ?? {}, value.derivationScope]) === JSON.stringify([expected.format, expected.rules ?? {}, expected.derivationScope]);

function readRecords<T>(file: string): Record<string, T> {
  if (!existsSync(file)) return {};
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid private credential metadata. Preserve the file for recovery.');
  return value;
}

function writeRecords(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

/** Atomic rename protects readers, not concurrent read/modify/write cycles.
 * A short owner-local SQLite write transaction serializes all credential
 * mutations across processes and is automatically released after a crash.
 * The existing JSON format remains readable by the candidate dashboard. */
function mutate<T>(action: () => T): T {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const file = resolve(config.dataDir, 'site-credentials-lock.sqlite');
  const db = new DatabaseSync(file);
  try {
    chmodSync(file, 0o600);
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    try { const value = action(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}

function pendingId(all:Record<string,PendingCredential>,url:string,email:string,employer:string,purpose:CredentialPurpose):string|undefined {
  for(const id of [pendingKey(url,email,employer,purpose),legacyPendingKey(url,email,employer,purpose)])if(all[id])return id;
  if(!new URL(url).searchParams.has('company')){
    const matches=Object.entries(all).filter(([id])=>{try{const [site,mail,name,flow]=JSON.parse(id);return hostOf(`https://${site}`)===hostOf(url)&&mail===email.trim().toLowerCase()&&name===employerName(employer)&&flow===purpose;}catch{return false;}});
    if(matches.length===1)return matches[0][0];
  }
}
export function pendingCredential(url: string, email: string, employer: string, purpose: CredentialPurpose): PendingCredential | null {
  const all=readRecords<PendingCredential>(pendingFile()),id=pendingId(all,url,email,employer,purpose);
  const value=id?all[id]:undefined;
  return value?.format === 'readable-v1' && value.purpose === purpose
    && ['prepared', 'needs_verification'].includes(value.phase) ? value : null;
}

/** Durable proposals are not accepted credentials and never authorize sign-in. */
export function stagePendingCredential(url: string, email: string, employer: string, purpose: CredentialPurpose, credential: SiteCredential): PendingCredential {
 return mutate(() => {
  const file = pendingFile(), all = readRecords<PendingCredential>(file), id = pendingId(all,url,email,employer,purpose)??pendingKey(url, email, employer, purpose);
  const previous = pendingCredential(url, email, employer, purpose);
  // An accepted registration awaiting activation already has a password.
  // Reopening registration must not silently replace that proposed password.
  const value: PendingCredential = purpose === 'create_account' && previous?.phase === 'needs_verification' ? previous
    : { ...credential, purpose, phase: 'prepared', at: new Date().toISOString() };
  all[id] = value; writeRecords(file, all); return value;
 });
}

export function markPendingVerification(url: string, email: string, employer: string, purpose: CredentialPurpose, expected?: SiteCredential): boolean {
 return mutate(() => {
  const file = pendingFile(), all = readRecords<PendingCredential>(file), id = pendingId(all,url,email,employer,purpose);
  const value = pendingCredential(url, email, employer, purpose);
  // Requesting a reset email without filling a new password is not a proposal.
  if (!id || !value || !matchesProposal(value, expected)) return false;
  all[id] = { ...value, phase: 'needs_verification', at: new Date().toISOString() };
  writeRecords(file, all); return true;
 });
}

export function discardPendingCredential(url: string, email: string, employer: string, purpose: CredentialPurpose, expected?: SiteCredential): void {
 mutate(() => {
  const file = pendingFile(), all = readRecords<PendingCredential>(file), id = pendingId(all,url,email,employer,purpose);
  // A later duplicate-registration rejection cannot erase an earlier
  // registration that is known to be awaiting activation.
  const value=pendingCredential(url,email,employer,purpose);
  if (!id || !value || !matchesProposal(value, expected) || (purpose === 'create_account' && value.phase === 'needs_verification')) return;
  delete all[id]; writeRecords(file, all);
 });
}

type CredentialRecord = Partial<SiteCredential> & { at?: string; status?: 'accepted' | 'rejected' | 'external'; employer?:string };
function readAll(): Record<string, CredentialRecord> {
  return readRecords<CredentialRecord>(FILE());
}

function credentialRecord(url:string,email:string,employer=''): {id:string;record:CredentialRecord}|undefined {
  const all=readAll(), id=key(url,email,employer), direct=all[id];
  if(direct && (!sharedEmployerHost(url)||employerAccountSite(url,employer)!==hostOf(url)))return {id,record:direct};
  // A company-less redirect can recover one exact employer record, never another tenant.
  const explicitTenant=new URL(url.includes('://')?url:`https://${url}`).searchParams.has('company');
  const matches=Object.entries(all).filter(([k,v])=>k.endsWith(`|${email.trim().toLowerCase()}`)
    &&hostOf(`https://${k.slice(0,k.lastIndexOf('|'))}`)===hostOf(url)
    &&(!employer||v.employer===employerName(employer))&&!explicitTenant
    &&(!sharedEmployerHost(url)||Boolean(employer&&v.employer===employerName(employer))));
  if(matches.length===1)return {id:matches[0][0],record:matches[0][1]};
  // Old dedicated-domain records retain their exact original password recipe.
  const legacy=all[key(url,email)];
  return !sharedEmployerHost(url)&&legacy?{id:key(url,email),record:legacy}:undefined;
}
export function storedCredential(url: string, email: string, employer=''): SiteCredential | null {
  const record = credentialRecord(url,email,employer)?.record;
  if (!record || (record.status !== undefined && record.status !== 'accepted') || record.format !== 'readable-v1') return null;
  return { format: record.format, ...(record.rules ? { rules: record.rules } : {}),...(record.derivationScope?{derivationScope:record.derivationScope}:{}) };
}
export function employerCredentialState(url:string,email:string,employer:string) {
  const known=credentialRecord(url,email,employer);
  if(known&&(known.record.status==='external'||known.record.format==='readable-v1'))return {state:known.record.status??'accepted',site:known.id.slice(0,known.id.lastIndexOf('|'))} as const;
  for(const purpose of ['create_account','reset_password'] as const){
    const pending=pendingCredential(url,email,employer,purpose);
    if(pending)return {state:'pending',purpose,phase:pending.phase,site:pending.derivationScope??employerAccountSite(url,employer)} as const;
  }
  return {state:'missing',site:employerAccountSite(url,employer)} as const;
}
export function rememberExternalAccount(url:string,email:string,employer:string): void {
  mutate(()=>{if(employerCredentialState(url,email,employer).state!=='missing')return;
    const all=readAll();all[key(url,email,employer)]={status:'external',employer:employerName(employer),at:new Date().toISOString()};writeRecords(FILE(),all);});
}

/** Rejected passwords remain unavailable in subsequent attempts and runs.
 * No password bytes, derived passwords or candidate answers are stored. */
export function rejectCredential(url: string, email: string, employer=''): void {
 mutate(() => {
  const known=credentialRecord(url,email,employer);if(!known||known.record.format!=='readable-v1')return;
  const all = readAll(), id = known.id;
  all[id] = { ...all[id], status: 'rejected',employer:employerName(employer), at: new Date().toISOString() };
  writeRecords(FILE(), all);
 });
}

function rememberCredential(url: string, email: string, credential: SiteCredential,employer:string): void {
  const all = readAll();
  const site=credential.derivationScope??employerAccountSite(url,employer);
  all[`${site}|${email.trim().toLowerCase()}`] = { ...credential,employer:employerName(employer), status: 'accepted', at: new Date().toISOString() };
  writeRecords(FILE(), all);
}

/** Promote and retire the same proposal under one cross-process lock. Writing
 * acceptance first makes a crash before retirement safe to repeat. A stale
 * worker cannot discard or accept a replacement password proposal. */
export function acceptPendingCredential(url: string, email: string, employer: string, purpose: CredentialPurpose, expected?: SiteCredential): boolean {
  return mutate(() => {
    const file = pendingFile(), all = readRecords<PendingCredential>(file),id=pendingId(all,url,email,employer,purpose);
    const credential = pendingCredential(url, email, employer, purpose);
    if (!id || !credential || !matchesProposal(credential, expected)) return false;
    rememberCredential(url, email, credential,employer);
    delete all[id];
    writeRecords(file, all);
    return true;
  });
}
