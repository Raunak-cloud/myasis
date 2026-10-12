/** Local-only viewer fixture. No database, account, worker, or employer is contacted. */
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { WebSocketServer, WebSocket } from 'ws';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const frame = readFileSync(new URL('../public/demo/myasis-live-run-poster.jpg', import.meta.url)).toString('base64');
const clients = new Set<WebSocket>();
const wss = new WebSocketServer({ noServer: true });
const send = (ws: WebSocket, payload: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(payload));
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { LiveActionViewer } from '/src/components/LiveActionViewer.tsx';
import '/src/index.css';
const e = React.createElement;
function Preview() {
  const [open, setOpen] = React.useState(true);
  return e(React.Fragment, null, e('div', {style:{position:'fixed',top:0,left:0,zIndex:90,display:'flex',gap:8,background:'var(--surface)'}},
    ...['blank','page','disconnect','broken-image'].map(state => e('button', {className:'btn btn-small', key:state, onClick:()=>fetch('/fixture/'+state,{method:'POST'})}, state)),
    e('button', {className:'btn btn-small', onClick:()=>setOpen(true)}, 'Open viewer'),
    e('span', null, 'Local preview · simulated run')),
    open && e(LiveActionViewer, {onClose:()=>setOpen(false), activity:'Reviewing jobs · 12 listings reviewed'}));
}
createRoot(document.getElementById('root')).render(e(Preview));
`;
const server = await createServer({
  configFile: false, root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 5199, strictPort: true },
  plugins: [react(), {
    name: 'live-action-fixture',
    resolveId(id) { if (id === '/live-action-fixture.tsx') return '\0live-action-fixture.tsx'; },
    load(id) { if (id === '\0live-action-fixture.tsx') return entry; },
    configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        if (req.url === '/') {
          void vite.transformIndexHtml('/', '<!doctype html><html data-theme="light"><title>Live action local preview</title><div id="root"></div><script type="module" src="/live-action-fixture.tsx"></script></html>').then(html => {
            res.setHeader('Content-Type', 'text/html'); res.end(html);
          });
          return;
        }
        if (req.method === 'POST' && req.url?.startsWith('/fixture/')) {
          for (const client of clients) {
            if (req.url === '/fixture/disconnect') client.close();
            else {
              send(client, { type: 'attached', target: { url: req.url === '/fixture/blank' ? 'about:blank' : 'https://example.test/job' } });
              send(client, { type: 'ready' });
              send(client, { type: 'frame', data: req.url === '/fixture/broken-image' ? 'invalid' : frame });
            }
          }
          res.end('ok'); return;
        }
        next();
      });
    },
  }],
});
server.httpServer!.on('upgrade', (req, socket, head) => {
  if (req.url?.startsWith('/ws/screencast')) wss.handleUpgrade(req, socket, head, client => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    send(client, { type: 'attached', target: { url: 'about:blank' } });
    send(client, { type: 'ready' });
    send(client, { type: 'frame', data: frame });
  });
});
await server.listen();
console.log('Local Live action fixture: http://127.0.0.1:5199 (simulated stream only)');
