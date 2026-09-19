import { connect, createServer, type Server, type Socket } from 'node:net';
import { parseProxy, RouteSwitch, setProxy } from './route.js';

/**
 * The route switch against a stand-in tunnel, a stand-in proxy and a
 * stand-in website, all on loopback. Nothing real is contacted: the stand-ins
 * answer the reachability probe themselves instead of dialling a job board.
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

const route = new RouteSwitch('test', { kind: 'home', host: '127.0.0.1', port: tunnelPort, auth: null });
const switchPort = await route.port();
await route.check(true);
check('with the home machine on, the home connection is used', route.status().using === 'home' && route.status().exitOnline);
check('and its public address is shown', route.status().exitAddress === '203.0.113.7');

const first = await browse(switchPort);
check('a page loads through the tunnel', first.greeting === 'hello' && throughTunnel === 1);

// The PC goes to sleep with the browser still open.
tunnel.close();
for (const socket of tunnelSockets) socket.destroy();
tunnelSockets.clear();
await new Promise(resolve => setTimeout(resolve, 100));

const second = await browse(switchPort);
check('the next page still loads when the home machine disappears', second.greeting === 'hello');
check('it went out from the server, not the tunnel', throughTunnel === 1 && route.status().using === 'server' && !route.status().exitOnline);
check('the address shown is withdrawn', route.status().exitAddress === null);

// The PC wakes while the browser is still open.
tunnel = startTunnel();
await listen(tunnel, tunnelPort);
await route.check(true);
check('a browser that is open is not moved back to the home address', route.status().using === 'server' && route.status().exitOnline);
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

// ---- a proxy: the same switch, with a username and password (RFC 1929)

let throughProxy = 0;
const proxy = createServer((socket) => {
  socket.on('error', () => {});
  socket.once('data', (hello) => {
    if (!hello.subarray(2).includes(2)) return socket.end(Buffer.from([5, 0xff]));
    socket.write(Buffer.from([5, 2]));
    socket.once('data', (login) => {
      const username = login.subarray(2, 2 + login[1]).toString();
      const password = login.subarray(3 + login[1], 3 + login[1] + login[2 + login[1]]).toString();
      if (username !== 'ncoid' || password !== 'right') return socket.end(Buffer.from([1, 1]));
      socket.write(Buffer.from([1, 0]));
      socket.once('data', (request) => {
        const ok = Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
        if (request[3] === 1) {
          throughProxy++;
          const upstream = connect({ host: '127.0.0.1', port: request.readUInt16BE(8) });
          upstream.on('connect', () => { socket.write(ok); upstream.pipe(socket); socket.pipe(upstream); });
          upstream.on('error', () => socket.destroy());
        } else if (request.includes('api.ipify.org')) {
          socket.write(ok);
          socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n198.51.100.9'));
        } else socket.write(ok);
      });
    });
  });
});
const proxyPort = await listen(proxy);

const viaProxy = new RouteSwitch('test', { kind: 'proxy', host: '127.0.0.1', port: proxyPort, auth: { username: 'ncoid', password: 'right' } });
await viaProxy.check(true);
check('a proxy that accepts its login is used', viaProxy.status().using === 'proxy' && viaProxy.status().exitAddress === '198.51.100.9');
const proxied = await browse(await viaProxy.port());
check('and pages load through it', proxied.greeting === 'hello' && throughProxy === 1);
proxied.socket.destroy();
viaProxy.close();

const wrongLogin = new RouteSwitch('test', { kind: 'proxy', host: '127.0.0.1', port: proxyPort, auth: { username: 'ncoid', password: 'wrong' } });
await wrongLogin.check(true);
check('a proxy that refuses its login is not used', wrongLogin.status().using === 'server' && !wrongLogin.status().exitOnline);
check('and the operator is told why', /username or password/.test(wrongLogin.status().exitProblem ?? ''));
const direct = await browse(await wrongLogin.port());
check('while pages still load, from the server', direct.greeting === 'hello' && throughProxy === 1);
direct.socket.destroy();
wrongLogin.close();
proxy.close();

// ---- reading and guarding the setting

const url = parseProxy('socks5://ncoid:p%40ss@92.71.68.53:7747');
check('a socks5 URL is read, password decoded', typeof url !== 'string' && url.host === '92.71.68.53' && url.port === 7747 && url.password === 'p@ss');
const line = parseProxy('92.71.68.53:7747:ncoid:secret');
check('a provider\'s host:port:user:pass line is read', typeof line !== 'string' && line.username === 'ncoid' && line.password === 'secret');
check('an HTTP proxy is refused', typeof parseProxy('http://u:p@92.71.68.53:7747') === 'string');
check('a proxy without a password is refused', typeof parseProxy('socks5://u@92.71.68.53:7747') === 'string');
check('a proxy on this server is refused', typeof (await setProxy('test', '127.0.0.1:1080:u:p')) === 'string');
check('a proxy on a private network is refused', typeof (await setProxy('test', 'socks5://u:p@10.0.0.5:1080')) === 'string');
check('a mapped private address is refused', typeof (await setProxy('test', 'socks5://u:p@[::ffff:192.168.1.1]:1080')) === 'string');

site.close();
console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
