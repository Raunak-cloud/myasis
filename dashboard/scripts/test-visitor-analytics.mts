import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source = ts.transpileModule(
  readFileSync(new URL('../src/analytics.ts', import.meta.url), 'utf8'),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
function fixture(blockStorage = false, automated = false, failFirst = false) {
  let clock = 0;
  let nextId = 0;
  let beaconThrows = false;
  const sent: Array<{ path: string; body: any }> = [];
  const intervals: Array<() => void> = [];
  const events = new Map<string, () => void>();
  const storage = {
    getItem: () => {
      if (blockStorage) throw Error('blocked');
      return null;
    },
    setItem: () => {
      if (blockStorage) throw Error('blocked');
    },
  };
  const document = {
    visibilityState: 'visible',
    referrer: 'https://source.test/',
    addEventListener: (name: string, callback: () => void) =>
      events.set(name, callback),
  };
  const exports: {
    trackPage?: (page: string, identity?: string | null) => void;
  } = {};
  const context = vm.createContext({
    exports,
    URLSearchParams,
    Intl,
    Date,
    Math,
    crypto: { randomUUID: () => 'fixture-visitor-id' },
    localStorage: storage,
    sessionStorage: storage,
    performance: { now: () => clock },
    document,
    window: {
      location: { search: '' },
      screen: { width: 1280, height: 800 },
      setInterval: (callback: () => void) => intervals.push(callback),
      addEventListener: (name: string, callback: () => void) =>
        events.set(name, callback),
    },
    navigator: {
      webdriver: automated,
      language: 'en-AU',
      sendBeacon: (path: string, body: string) => {
        if (beaconThrows) throw Error('queue full');
        sent.push({ path, body: JSON.parse(body) });
        return true;
      },
    },
    fetch: async (path: string, init: { body: string }) => {
      sent.push({ path, body: JSON.parse(init.body) });
      const id = String(++nextId);
      if (failFirst && nextId === 1) throw Error('offline');
      return { json: async () => ({ id }) };
    },
  });
  vm.runInContext(source, context);
  return {
    track: exports.trackPage!,
    sent,
    intervals,
    setClock: (value: number) => (clock = value),
    visibility: (value: string) => {
      document.visibilityState = value;
      events.get('visibilitychange')!();
    },
    event: (name: string) => events.get(name)!(),
    beaconThrows: () => (beaconThrows = true),
  };
}
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const client = fixture();
client.track('landing');
client.track('landing');
assert.equal(client.sent.length, 1, 'same page and identity are idempotent');
client.setClock(1000);
client.track('landing', 'account-2');
await flush();
assert.equal(
  client.sent.filter((row) => row.path === '/api/visit').length,
  2,
  'sign-in on same page rotates identity',
);
assert.ok(
  client.sent.some(
    (row) => row.path === '/api/visit/leave' && row.body.durationMs === 1000,
  ),
  'navigation before ID arrives still closes the original row',
);
assert.equal(
  client.sent[0].body.userId,
  undefined,
  'client does not supply trusted account identity',
);
client.setClock(6000);
client.visibility('hidden');
assert.equal(client.sent.at(-1)!.body.durationMs, 5000);
const beforeHidden = client.sent.length;
client.setClock(16000);
client.intervals[0]();
assert.equal(
  client.sent.length,
  beforeHidden,
  'background tabs never renew presence',
);
client.visibility('visible');
assert.equal(client.sent.at(-1)!.path, '/api/visit/pulse');
assert.equal(
  client.sent.at(-1)!.body.durationMs,
  5000,
  'background time is excluded',
);
client.setClock(26000);
client.intervals[0]();
assert.equal(client.sent.at(-1)!.body.durationMs, 15000);
client.event('pagehide');
assert.equal(client.sent.at(-1)!.path, '/api/visit/leave');
client.setClock(36000);
client.event('pageshow');
assert.equal(
  client.sent.at(-1)!.path,
  '/api/visit/pulse',
  'back/forward restore renews presence',
);
assert.equal(client.sent.at(-1)!.body.durationMs, 15000);
client.beaconThrows();
client.setClock(37000);
client.intervals[0]();
assert.equal(
  client.sent.at(-1)!.path,
  '/api/visit/pulse',
  'throwing sendBeacon falls back to fetch',
);
const pulses = client.sent.filter(
  (row) => row.body.sequence && row.body.id === '2',
);
assert.deepEqual(
  pulses.map((row) => row.body.sequence),
  pulses.map((_, i) => i + 1),
  'presence sequence is monotonic per page',
);
client.setClock(7 * 60 * 60 * 1000);
client.intervals[0]();
await flush();
assert.equal(
  client.sent.filter((row) => row.path === '/api/visit').length,
  3,
  'long-lived tabs renew their row before the write window expires',
);
const privateClient = fixture(true);
privateClient.track('landing');
await flush();
privateClient.intervals[0]();
assert.equal(
  privateClient.sent[0].body.visitorId,
  privateClient.sent[1].body.visitorId,
  'blocked storage retains a stable page-load ID',
);
const recovered = fixture(false, false, true);
recovered.track('landing');
await flush();
recovered.setClock(20_000);
recovered.intervals[0]();
await flush();
assert.equal(recovered.sent.filter(row => row.path === '/api/visit').length, 2, 'failed initial creation retries on the next heartbeat');
const robot = fixture(false, true);
robot.track('landing');
assert.equal(
  robot.sent.length,
  0,
  'automation is not recorded as visitor traffic',
);
console.log(
  'PASS analytics: visible-only duration, heartbeats, late creation, identity changes, ordered presence, back/forward restoration, blocked storage, beacon fallback and automation exclusion',
);
