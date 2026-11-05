/** Root-only setup. Read credentials from stdin, never a CLI argument or log. */
import { existsSync,readFileSync,writeFileSync,renameSync,chownSync,chmodSync,statSync } from 'node:fs';
import {randomUUID} from 'node:crypto';
import { externalIndexUrl } from '../server/job-index/config.js';
if(process.getuid?.()!==0)throw Error('Run this protected connection setup as the server operator.');
try {
let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>16000)throw Error('Connection input exceeds its size limit.');}
const incoming=JSON.parse(input) as {indexUrl?:unknown;braveKey?:unknown};
const path='/etc/owtomate-job-index.json';const previous=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{};
const indexUrl=externalIndexUrl(typeof incoming.indexUrl==='string'?incoming.indexUrl:previous.indexUrl);
if(incoming.braveKey!==undefined&&typeof incoming.braveKey!=='string')throw Error('Search credential must be a string.');
const config={...previous,indexUrl,...(incoming.braveKey!==undefined?{braveKey:incoming.braveKey}:{})};
const pending=`/etc/.owtomate-job-index-${randomUUID()}.json`;
writeFileSync(pending,JSON.stringify(config),{mode:0o600,flag:'wx'});chownSync(pending,0,statSync(new URL('../../seek-bot',import.meta.url)).gid);chmodSync(pending,0o640);renameSync(pending,path);
console.log('External job-database connection saved. Credentials were not printed.');
}catch{console.error('Connection was not saved. Check the protected JSON input and direct Neon TLS URL.');process.exitCode=1;}
