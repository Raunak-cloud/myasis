import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// These modules hold account authority or process-wide identity. A live repair
// must use the original instances, including their AsyncLocalStorage scopes.
export const REPAIR_SHARED_MODULES = ['config','application-model','application-allowance','application-reservations',
  'application-workers','browser-deadline','tool-run','cost-ledger','run-health','browser',
  'private-auth-fields','agent/attempt-diagnostics','agent/celeris'] as const;
export function bridgeRepairRuntime(bot: string, originalBot: string): void {
  for (const name of REPAIR_SHARED_MODULES) {
    const target=resolve(bot,'dist',name+'.js'), original=resolve(originalBot,'dist',name+'.js');
    if (!lstatSync(target).isFile() || !lstatSync(original).isFile()) throw Error('Shared repair runtime is incomplete.');
    writeFileSync(target,`export * from ${JSON.stringify(pathToFileURL(original).href)};\n`,{mode:0o644});
  }
}

export const REPAIR_RELEASE_ROOT = '/opt/owtomate-repair-releases';
export const repairId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
export function repairPilotEnabled(): boolean {
  try {
    const file='/etc/owtomate-repair-pilot.json',stat=lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid!==0 || (stat.mode&0o022)) return false;
    const config=JSON.parse(readFileSync(file,'utf8'));
    return config.enabled===true && config.ownerId==='1' && config.ownerEmail==='raunak.vision@gmail.com' && config.recoveryMode==='in-run';
  } catch { return false; }
}

/** Same deterministic digest is used when publishing and before spawning. */
export function repairDistHash(directory: string, requireRoot = true): string {
  const hash = createHash('sha256');
  let count = 0, bytes = 0;
  const walk = (path: string) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || requireRoot && (stat.uid !== 0 || (stat.mode & 0o022))) throw Error('Repair artifact is mutable or contains links.');
    if (stat.isDirectory()) { for (const name of readdirSync(path).sort()) walk(resolve(path,name)); }
    else if (stat.isFile()) {
      count++; bytes += stat.size;
      if (count > 1500 || bytes > 30_000_000) throw Error('Repair artifact is too large.');
      hash.update(relative(directory,path).split(sep).join('/')).update('\0').update(readFileSync(path)).update('\0');
    } else throw Error('Repair artifact contains a non-file entry.');
  };
  walk(directory);
  if (!count) throw Error('Repair artifact is empty.');
  return hash.digest('hex');
}

export function loadRepairRelease(caseId: string, options: { ownerId: string; email: string; activeAdmin: boolean; expectedBaseSha: string;
  expectedDistHash: string; currentBaseSha: string; lockFile: string; now?: number; root?: string; requireRoot?: boolean }): string {
  if (!repairId(caseId) || options.ownerId !== '1' || options.email.toLowerCase() !== 'raunak.vision@gmail.com' || options.activeAdmin !== true) throw Error('Repair release is unavailable for this account.');
  const root = options.root ?? REPAIR_RELEASE_ROOT, required = options.requireRoot ?? true;
  const directory = resolve(root,caseId), child = relative(root,directory);
  if (!child || isAbsolute(child) || child.startsWith('..') || realpathSync(directory) !== directory) throw Error('Invalid repair release directory.');
  for (const path of [root,directory,resolve(directory,'seek-bot')]) {
    const parent = lstatSync(path);
    if (!parent.isDirectory() || parent.isSymbolicLink() || required && (parent.uid !== 0 || (parent.mode & 0o022))) throw Error('Repair release directory is mutable.');
  }
  const manifestPath = resolve(directory,'manifest.json'), stat = lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || required && (stat.uid !== 0 || (stat.mode & 0o022))) throw Error('Repair manifest is not immutable.');
  const manifest = JSON.parse(readFileSync(manifestPath,'utf8'));
  const now = options.now ?? Date.now();
  if (manifest.caseId !== caseId || manifest.ownerId !== '1' || manifest.baseSha !== options.expectedBaseSha
    || manifest.baseSha !== options.currentBaseSha || manifest.distHash !== options.expectedDistHash
    || !Number.isFinite(manifest.expiresAt) || manifest.expiresAt <= now || manifest.expiresAt > now + 24*60*60*1000
    || manifest.lockHash !== createHash('sha256').update(readFileSync(options.lockFile)).digest('hex')) throw Error('Repair release is stale or mismatched.');
  const bot = resolve(directory,'seek-bot');
  if (required && realpathSync(resolve(bot,'node_modules')) !== resolve(options.lockFile,'../node_modules')) throw Error('Repair dependencies are not the production dependencies.');
  if (existsSync(resolve(bot,'.env')) || repairDistHash(resolve(bot,'dist'),required) !== manifest.distHash) throw Error('Repair release failed integrity validation.');
  return bot;
}
