import {backup,DatabaseSync} from 'node:sqlite';
import {chmodSync,existsSync,lstatSync,mkdirSync,readFileSync,readlinkSync,renameSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

const downloadTables=['downloads_url_chains','downloads_slices','downloads'] as const;
export function affectedDownloadHistoryVersion(version:string):boolean {
  return /(?:Google Chrome|Chromium)\s+(?:152|153)\./.test(version);
}

/** A crashed browser may leave a dangling SingletonLock. Only a current holder
 * of this exact profile (or an unidentifiable lock) prevents offline repair. */
function profileInUse(profile:string):boolean {
  const lock=resolve(profile,'SingletonLock');
  try{
    if(!lstatSync(lock).isSymbolicLink())return true;
    const pid=readlinkSync(lock).match(/-(\d+)$/)?.[1];
    if(!pid)return true;
    try{
      const args=readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0');
      return args.some((arg,index)=>arg===`--user-data-dir=${profile}`||arg==='--user-data-dir'&&args[index+1]===profile);
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;return true;}
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
}

/** Chromium 152/153 can crash on a CDP-controlled download after restoring
 * persisted download metadata. Reproduced with Chrome 153 on Linux. Repair
 * only these records before launch; cookies, visits, logins and files stay.
 * See https://issues.chromium.org/issues/556160935 and MicrosoftEdge/DevTools#461.
 * A private SQLite backup preserves the complete pre-repair database. */
export async function repairPersistentDownloadHistory(profileDirectory:string,version:string,platform:string=process.platform):Promise<{cleared:number;backupPath?:string;skipped?:'profile-in-use'}>{
  if(platform!=='linux'||!affectedDownloadHistoryVersion(version))return {cleared:0};
  const profile=resolve(profileDirectory),history=resolve(profile,'Default','History');
  if(!existsSync(history))return {cleared:0};
  if(lstatSync(history).isSymbolicLink()||!lstatSync(history).isFile())throw Error('Browser download repair requires a regular profile History database.');
  if(profileInUse(profile))return {cleared:0,skipped:'profile-in-use'};
  const db=new DatabaseSync(history);
  let temporaryBackup:string|undefined;
  try{
    db.exec('PRAGMA busy_timeout=1500');
    const names=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>String(row.name)));
    const tables=downloadTables.filter(table=>names.has(table));
    const count=tables.reduce((sum,table)=>sum+Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n),0);
    if(!count)return {cleared:0};
    const directory=resolve(profile,'owtomate-download-recovery');
    mkdirSync(directory,{recursive:true,mode:0o700});
    if(lstatSync(directory).isSymbolicLink())throw Error('Browser download backup directory cannot be a link.');
    chmodSync(directory,0o700);
    const backupPath=resolve(directory,'History.before-download-repair.sqlite');
    temporaryBackup=resolve(directory,`History.${randomUUID()}.tmp.sqlite`);
    await backup(db,temporaryBackup);chmodSync(temporaryBackup,0o600);
    renameSync(temporaryBackup,backupPath);temporaryBackup=undefined;
    db.exec('BEGIN IMMEDIATE');
    try{
      let cleared=0;
      for(const table of tables)cleared+=Number(db.prepare(`DELETE FROM ${table}`).run().changes);
      db.exec('COMMIT');return {cleared,backupPath};
    }catch(error){db.exec('ROLLBACK');throw error;}
  }finally{db.close();if(temporaryBackup)rmSync(temporaryBackup,{force:true});}
}
