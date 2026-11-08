import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {affectedDownloadHistoryVersion,repairPersistentDownloadHistory} from './browser-download-history.js';
const roots:string[]=[];after(()=>{for(const root of roots)rmSync(root,{recursive:true,force:true});});
const version='Google Chrome 153.0.8010.36';
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'chrome-download-repair-'));roots.push(root);mkdirSync(join(root,'Default'));
  const history=join(root,'Default','History'),db=new DatabaseSync(history);
  db.exec(`CREATE TABLE downloads(id INTEGER PRIMARY KEY,start_time INTEGER);CREATE TABLE downloads_url_chains(id INTEGER,url TEXT);CREATE TABLE downloads_slices(download_id INTEGER,received_bytes INTEGER);
    CREATE TABLE urls(id INTEGER PRIMARY KEY,url TEXT);CREATE TABLE visits(id INTEGER PRIMARY KEY,url INTEGER);CREATE TABLE unrelated(value TEXT);
    INSERT INTO downloads VALUES(1,13437529534818891);INSERT INTO downloads_url_chains VALUES(1,'https://fixture.invalid/private-download');INSERT INTO downloads_slices VALUES(1,100);
    INSERT INTO urls VALUES(1,'https://fixture.invalid/application');INSERT INTO visits VALUES(1,1);INSERT INTO unrelated VALUES('retained');`);db.close();
  writeFileSync(join(root,'Default','Cookies'),'private login bytes');writeFileSync(join(root,'Fixture.docx'),'actual document bytes');
  return {root,history};
}
function count(file:string,table:string){const db=new DatabaseSync(file,{readOnly:true});try{return Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);}finally{db.close();}}
test('affected browser versions are narrowly selected',()=>{
  assert.equal(affectedDownloadHistoryVersion(version),true);assert.equal(affectedDownloadHistoryVersion('Chromium 152.0.1'),true);
  for(const value of ['Google Chrome 151.0.1','Google Chrome 154.0.1','unknown',''])assert.equal(affectedDownloadHistoryVersion(value),false);
});
test('repair backs up exact history, changes download records only and preserves private data and files',async()=>{
  const {root,history}=fixture(),result=await repairPersistentDownloadHistory(root,version,'linux');assert.equal(result.cleared,3);assert.ok(result.backupPath);
  for(const table of ['downloads','downloads_url_chains','downloads_slices']){assert.equal(count(history,table),0);assert.equal(count(result.backupPath!,table),1);}
  for(const table of ['urls','visits','unrelated'])assert.equal(count(history,table),1);
  const backup=new DatabaseSync(result.backupPath!,{readOnly:true});try{assert.equal(backup.prepare('SELECT CAST(start_time AS TEXT) AS stamp FROM downloads').get()!.stamp,'13437529534818891');}finally{backup.close();}
  assert.equal(readFileSync(join(root,'Default','Cookies'),'utf8'),'private login bytes');assert.equal(readFileSync(join(root,'Fixture.docx'),'utf8'),'actual document bytes');
  if(process.platform!=='win32'){assert.equal(statSync(result.backupPath!).mode&0o777,0o600);assert.equal(statSync(join(root,'owtomate-download-recovery')).mode&0o777,0o700);}
  assert.deepEqual(await repairPersistentDownloadHistory(root,version,'linux'),{cleared:0});
});
test('unaffected platforms and versions do not modify existing records',async()=>{
  const {root,history}=fixture();assert.deepEqual(await repairPersistentDownloadHistory(root,version,'win32'),{cleared:0});
  assert.deepEqual(await repairPersistentDownloadHistory(root,'Google Chrome 154.0.1','linux'),{cleared:0});assert.equal(count(history,'downloads'),1);
});
test('fresh profiles stay untouched and an occupied or unknown lock prevents offline mutation',async()=>{
  const root=mkdtempSync(join(tmpdir(),'chrome-fresh-'));roots.push(root);assert.deepEqual(await repairPersistentDownloadHistory(root,version,'linux'),{cleared:0});assert.equal(existsSync(join(root,'Default','History')),false);
  const busy=fixture();writeFileSync(join(busy.root,'SingletonLock'),'unknown owner');
  assert.deepEqual(await repairPersistentDownloadHistory(busy.root,version,'linux'),{cleared:0,skipped:'profile-in-use'});assert.equal(count(busy.history,'downloads'),1);
});
test('a failed deletion rolls back every download table while leaving a usable backup',async()=>{
  const {root,history}=fixture(),db=new DatabaseSync(history);db.exec("CREATE TRIGGER refuse_download_delete BEFORE DELETE ON downloads BEGIN SELECT RAISE(ABORT,'fixture refusal'); END;");db.close();
  await assert.rejects(repairPersistentDownloadHistory(root,version,'linux'),/fixture refusal/);
  for(const table of ['downloads','downloads_url_chains','downloads_slices','urls','visits'])assert.equal(count(history,table),1);
  assert.equal(count(join(root,'owtomate-download-recovery','History.before-download-repair.sqlite'),'downloads'),1);
});
