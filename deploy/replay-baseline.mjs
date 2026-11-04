import {execFileSync} from 'node:child_process';
import {mkdirSync,realpathSync,symlinkSync} from 'node:fs';
import {dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

/** An explicitly identified production revision can establish the reading of
 * copied historical forms. The candidate still replays every copied page and
 * must pass all field, label and security comparisons against that reading.
 * Original account records are never accepted or rewritten. */
export function prepareReplayBaseline({root,corpus,baseline,release},run=(command,args,options)=>execFileSync(command,args,options)) {
 if(!/^[a-f0-9]{40}$/.test(baseline??'')||!/^[a-f0-9]{40}$/.test(release??'')||baseline===release)throw Error('Use distinct full production and release revisions.');
 root=realpathSync(root);corpus=realpathSync(corpus);
 const within=relative(join(root,'output'),corpus).replaceAll('\\','/');
 if(!/^deploy-smoke\.[^/]+\/corpus$/.test(within))throw Error('Production comparison requires the fresh deployment replay copy.');
 const gitOptions={cwd:root,encoding:'utf8'};
 if(run('git',['rev-parse','HEAD'],gitOptions).trim()!==release)throw Error('The checked release changed.');
 run('git',['merge-base','--is-ancestor',baseline,release],gitOptions);
 const working=join(dirname(corpus),'production-baseline');
 mkdirSync(working,{mode:0o700});
 const archive=run('git',['archive',baseline],{cwd:root,maxBuffer:128*1024*1024,encoding:undefined});
 run('tar',['-x','-C',working],{input:Buffer.isBuffer(archive)?archive:Buffer.from(archive,'binary'),maxBuffer:128*1024*1024});
 const bot=join(working,'seek-bot');
 symlinkSync(join(root,'seek-bot','node_modules'),join(bot,'node_modules'),process.platform==='win32'?'junction':'dir');
 const options={cwd:bot,encoding:'utf8',maxBuffer:16*1024*1024,env:{...process.env,CELERIS_API_KEY:'replay-only'}};
 run(process.execPath,['node_modules/typescript/bin/tsc'],options);
 const output=run(process.execPath,['dist/form-replay.js',corpus,'--accept'],options);
 const summary=output.match(/Replayed (\d+)\/(\d+): (\d+) regression\(s\), (\d+) change\(s\)/);
 if(!summary||Number(summary[1])<1||summary[1]!==summary[2])throw Error('The production revision did not read every copied page.');
 return {baseline,release,pages:Number(summary[1]),historicalRegressions:Number(summary[3]),historicalChanges:Number(summary[4])};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [corpus,baseline,release]=process.argv.slice(2);
 const result=prepareReplayBaseline({root:resolve(dirname(fileURLToPath(import.meta.url)),'..'),corpus,baseline,release});
 console.log('Production replay comparison: '+JSON.stringify(result));
}
