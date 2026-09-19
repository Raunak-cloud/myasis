import { connect, createServer, type Server, type Socket } from 'node:net';
import { RouteSwitch } from './route.js';

/**
 * The route switch against a stand-in tunnel and a stand-in website, all on
 * loopback. Nothing real is contacted: the stand-in tunnel answers the
 * reachability probe itself instead of dialling a job board.
 */
let failures = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failures++;
};
const listen = (server: Server, port = 0) => new Promise<number>(resolve => server.listen(port, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
const once = (socket: Socket) => new Promise<Buffer>(resolve => socket.once('data', resolve));

// The website: says hello to whoever connects.
const site = createServer(socket => socket.write('hello'));
const sitePort = await listen(site);

// The home machine's end of the tunnel: a SOCKS5 server that counts what passes through it.
let throughTunnel = 0;
const tunnelSockets = new Set<Socket>();
function startTunnel(): Server {
  return createServer((socket) => {
    tunnelSockets.add(socket);
    socket.on('error', () => {});
    socket.once('data', () => {
      socket.write(Buffer.from([5, 0]));
      socket.once('data', (request) => {
        const ok = Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
        if (request[3] === 1) {
          throughTunnel++;
          const upstream = connect({ host: '127.0.0.1', port: request.readUInt16BE(8) });
          upstream.on('connect', () => { socket.write(ok); upstream.pipe(socket); socket.pipe(upstream); });
          upstream.on('error', () => socket.destroy());
        } else if (request.includes('api.ipify.org')) {
          socket.write(ok);
          socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n203.0.113.7'));
        } else socket.write(ok); // the reachability probe
      });
    });
  });
}
let tunnel = startTunnel();
const tunnelPort = await listen(tunnel);

/** What Chrome does: a SOCKS5 CONNECT to the website through the switch. */
async function browse(switchPort: number): Promise<{ socket: Socket; greeting: string }> {
  const socket = connect({ host: '127.0.0.1', port: switchPort });
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write(Buffer.from([5, 1, 0]));
  await once(socket);
  socket.write(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, sitePort >> 8, sitePort & 0xff]));
  const reply = await once(socket);
  const greeting = reply.length > 10 ? reply.subarray(10).toString() : (await once(socket)).toString();
  return { socket, greeting };
}

const route = new RouteSwitch('test', tunnelPort);
const switchPort = await route.port();
await route.check(true);
check('with the home machine on, the home connection is used', route.status().using === 'home' && route.status().homeOnline);
check('and its public address is shown', route.status().homeAddress === '203.0.113.7');

const first = await browse(switchPort);
check('a page loads through the tunnel', first.greeting === 'hello' && throughTunnel === 1);

// The PC goes to sleep with the browser still open.
tunnel.close();
for (const socket of tunnelSockets) socket.destroy();
tunnelSockets.clear();
await new Promise(resolve => setTimeout(resolve, 100));

const second = await browse(switchPort);
check('the next page still loads when the home machine disappears', second.greeting === 'hello');
check('it went out from the server, not the tunnel', throughTunnel === 1 && route.status().using === 'server' && !route.status().homeOnline);
check('the address shown is withdrawn', route.status().homeAddress === null);

// The PC wakes while the browser is still open.
tunnel = startTunnel();
await listen(tunnel, tunnelPort);
await route.check(true);
check('a browser that is open is not moved back to the home address', route.status().using === 'server' && route.status().homeOnline);
const third = await browse(switchPort);
check('so its pages keep going out from the server', third.greeting === 'hello' && throughTunnel === 1);

for (const { socket } of [first, second, third]) socket.destroy();
await new Promise(resolve => setTimeout(resolve, 100));
await route.check(true);
check('once the browser has closed, the home connection is used again', route.status().using === 'home');
const fourth = await browse(switchPort);
check('and the next browser goes through the tunnel', fourth.greeting === 'hello' && throughTunnel === 2);
fourth.socket.destroy();

route.close();
tunnel.close();
for (const socket of tunnelSockets) socket.destroy();
site.close();
console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
