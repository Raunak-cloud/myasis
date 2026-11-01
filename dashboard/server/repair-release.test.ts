import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { loadRepairRelease,repairDistHash } from './repair-release.js';

test('release integrity binds the exact account, tested revision, dependencies and expiry', () => {
  const root=mkdtempSync(resolve(tmpdir(),'repair-release-')),id='00000000-0000-4000-8000-000000000001';
  try {
    const dir=resolve(root,id),bot=resolve(dir,'seek-bot'),dist=resolve(bot,'dist'),lock=resolve(root,'lock.json');
    mkdirSync(dist,{recursive:true});writeFileSync(resolve(dist,'main.js'),'export const fixture = true;');writeFileSync(lock,'{}');
    const hash=repairDistHash(dist,false),now=1000;
    const manifest={caseId:id,ownerId:'1',baseSha:'base',distHash:hash,expiresAt:now+60_000,lockHash:createHash('sha256').update('{}').digest('hex')};
    writeFileSync(resolve(dir,'manifest.json'),JSON.stringify(manifest));
    const options={ownerId:'1',email:'raunak.vision@gmail.com',activeAdmin:true,expectedBaseSha:'base',currentBaseSha:'base',expectedDistHash:hash,lockFile:lock,now,root,requireRoot:false};
    assert.equal(loadRepairRelease(id,options),bot);
    for(const patch of [{ownerId:'183'},{activeAdmin:false},{currentBaseSha:'other'},{now:manifest.expiresAt}])
      assert.throws(()=>loadRepairRelease(id,{...options,...patch}));
    writeFileSync(resolve(dist,'main.js'),'tampered');assert.throws(()=>loadRepairRelease(id,options));
    writeFileSync(resolve(dist,'main.js'),'export const fixture = true;');
    writeFileSync(resolve(bot,'.env'),'SECRET');assert.throws(()=>loadRepairRelease(id,options));rmSync(resolve(bot,'.env'));
    if(process.platform!=='win32') { symlinkSync(lock,resolve(dist,'linked.js'));assert.throws(()=>repairDistHash(dist,false)); }
  } finally {rmSync(root,{recursive:true,force:true});}
});
