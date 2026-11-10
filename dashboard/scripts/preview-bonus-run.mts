/** Frontend-only preview. No production config, credentials, APIs or worker. */
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export async function bonusRunPreviewServer(port=0){
 const html=`<!doctype html><html lang="en-AU" data-theme="light"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Bonus run · Owtomate admin preview</title></head><body><div id="root"></div><script type="module">
 import React from 'react';import{createRoot}from'react-dom/client';import{BonusRunSimulation}from'/src/components/BonusRunSimulation.tsx';import'/src/index.css';
 const e=React.createElement;
 createRoot(document.getElementById('root')).render(e('main',{style:{maxWidth:1220,margin:'0 auto',padding:'28px clamp(12px,3vw,34px) 48px'}},
 e('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,marginBottom:28,paddingBottom:16,borderBottom:'1px solid var(--border)',color:'var(--text-dim)',fontSize:12}},
 e('span',null,'Owtomate / Admin / Simulate'),e('button',{className:'btn btn-small',onClick:()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark'}},'Switch theme')),
 e(BonusRunSimulation)));
 </script></body></html>`;
 const server=await createServer({configFile:false,root:resolve(import.meta.dirname,'..'),plugins:[react(),{
  name:'bonus-run-preview',configureServer(vite){vite.middlewares.use(async(req,res,next)=>{
   if(req.url?.startsWith('/api/')){res.statusCode=403;res.setHeader('Content-Type','application/json');res.end('{"error":"Preview only"}');return;}
   if(req.url?.split('?')[0]!=='/')return next();
   res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/',html));
  });},
 }],server:{host:'127.0.0.1',port,strictPort:port!==0},logLevel:'error'});
 await server.listen();return server;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const server=await bonusRunPreviewServer(5208);
 console.log('Bonus run admin preview: http://127.0.0.1:5208/ (fictional accounts only)');
 const close=async()=>{await server.close();process.exit(0);};process.once('SIGINT',close);process.once('SIGTERM',close);
}
