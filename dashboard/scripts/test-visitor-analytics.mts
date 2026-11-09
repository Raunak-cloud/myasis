import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {captureVisitSource,sourceLabel,UNKNOWN_SOURCE} from '../src/visitor-source.js';
const source = ts.transpileModule(
  readFileSync(new URL('../src/analytics.ts', import.meta.url), 'utf8'),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
let fixtureNumber = 0;
function fixture(blockStorage = false, automated = false, failFirst: boolean | 'http' | 'null' | 'ignored' = false, sharedStorage = new Map<string, string>(), search = '', referrer = 'https://source.test/') {
  const fixtureId = ++fixtureNumber;
  let clock = 0;
  let nextId = 0;
  let beaconThrows = false;
  let generatedIds = 0;
  const sent: Array<{ path: string; body: any }> = [];
  const intervals: Array<() => void> = [];
  const events = new Map<string, () => void>();
  const storage = {
    getItem: (key: string) => {
      if (blockStorage) throw Error('blocked');
      return sharedStorage.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (blockStorage) throw Error('blocked');
      sharedStorage.set(key, value);
    },
  };
  const document = {
    visibilityState: 'visible',
    referrer,
    addEventListener: (name: string, callback: () => void) =>
      events.set(name, callback),
  };
  const exports: {
    trackPage?: (page: string, identity?: string | null) => void;
  } = {};
  const context = vm.createContext({
    exports,
    require: (name:string) => {assert.equal(name,'./visitor-source');return {captureVisitSource};},
    URLSearchParams,
    Intl,
    Date: class extends Date { static now() { return Date.UTC(2026, 9, 31) + clock; } },
    AbortSignal,
    Math,
    crypto: { randomUUID: () => `fixture-${fixtureId}-${String(++generatedIds).padStart(16, '0')}` },
    localStorage: storage,
    sessionStorage: storage,
    performance: { now: () => clock },
    document,
    window: {
      location: { search,hostname:'owtomate.com' },
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
      if (nextId === 1) {
        if (failFirst === true) throw Error('offline');
        if (failFirst === 'http') return { ok: false, json: async () => ({ error: 'unavailable' }) };
        if (failFirst === 'null') return { ok: true, json: async () => ({ id: null }) };
        if (failFirst === 'ignored') return { ok: true, json: async () => ({ id: null, ignored: true }) };
      }
      return { ok: true, json: async () => ({ id }) };
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
const earlyExit=client.sent.find(row=>row.path==='/api/visit/leave' && row.body.durationMs===1000)!;
assert.equal(earlyExit.body.id,undefined,'exit timing is sent without waiting for an acknowledgement');
assert.equal(earlyExit.body.viewId,client.sent[0].body.viewId,'an early exit identifies the same page view');
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
const retries = recovered.sent.filter(row => row.path === '/api/visit');
assert.equal(retries[0].body.viewId, retries[1].body.viewId, 'a lost response retries the same page-view ID');
assert.equal(retries[1].body.referrer, 'https://source.test/', 'a failed request does not lose acquisition information');
for (const failure of ['http', 'null'] as const) {
  const retry = fixture(false, false, failure);
  retry.track('landing'); await flush();
  retry.setClock(20_000); retry.intervals[0](); await flush();
  assert.equal(retry.sent.filter(row => row.path === '/api/visit').length, 2, `${failure} acknowledgements are retryable`);
}
const ignored = fixture(false, false, 'ignored');
ignored.track('landing'); await flush();
ignored.setClock(20_000); ignored.intervals[0](); await flush();
assert.equal(ignored.sent.filter(row => row.path === '/api/visit').length, 1, 'intentionally excluded addresses do not keep retrying');
const sessions = fixture();
sessions.track('run', 'account-2'); await flush();
const firstSession = sessions.sent[0].body.sessionId;
sessions.setClock(1000); sessions.visibility('hidden');
sessions.setClock(31 * 60_000); sessions.visibility('visible'); await flush();
const afterIdle = sessions.sent.filter(row => row.path === '/api/visit');
assert.equal(afterIdle.length, 2, 'an old tab returning after inactivity opens a new visit');
assert.notEqual(afterIdle[1].body.sessionId, firstSession, 'visits do not merge across long idle periods');
assert.equal(afterIdle[1].body.visitorId, afterIdle[0].body.visitorId, 'a returning visit retains its browser identity');
const shared = new Map<string, string>();
const firstTab = fixture(false, false, false, shared);
firstTab.track('landing'); await flush();
const secondTab = fixture(false, false, false, shared);
secondTab.track('pricing'); await flush();
assert.equal(firstTab.sent[0].body.sessionId, secondTab.sent[0].body.sessionId, 'tabs within one active visit share a session');
assert.notEqual(firstTab.sent[0].body.viewId, secondTab.sent[0].body.viewId, 'separate tabs still record separate page views');
const campaign = fixture(true, false, false, new Map(), '?utm_source=reddit&utm_medium=paid');
campaign.track('landing'); await flush();
assert.equal(campaign.sent[0].body.attribution.source, 'reddit', 'blocked storage does not discard the current campaign');
const acquired=new Map<string,string>();
const adLanding=fixture(false,false,false,acquired,'?utm_source=reddit&utm_medium=paid&utm_campaign=launch');
adLanding.track('landing');await flush();
adLanding.track('pricing');await flush();
assert.equal(adLanding.sent.filter(r=>r.path==='/api/visit').at(-1)!.body.attribution.campaign,'launch','navigation preserves visit acquisition');
const authReturn=fixture(false,false,false,acquired,'','https://accounts.google.com/');
authReturn.track('run','account-2');await flush();
assert.equal(authReturn.sent[0].body.attribution.source,'reddit','authentication reload retains the original source');
const checkoutReturn=fixture(false,false,false,acquired,'','https://checkout.stripe.com/c/pay/private');
checkoutReturn.track('run','account-2');await flush();
assert.equal(checkoutReturn.sent[0].body.attribution.source,'reddit','payment return does not replace acquisition');
checkoutReturn.setClock(1000);checkoutReturn.visibility('hidden');
checkoutReturn.setClock(31*60_000);checkoutReturn.visibility('visible');await flush();
const idleVisit=checkoutReturn.sent.filter(r=>r.path==='/api/visit').at(-1)!.body;
assert.equal(idleVisit.attribution,null,'an idle return is not assigned an earlier campaign');
assert.equal(idleVisit.referrer,'','an idle return does not replay the original document referrer');
const secondArrival=fixture(false,false,false,acquired,'?gclid=secret-click','');
secondArrival.setClock(62*60_000);secondArrival.track('landing');await flush();
assert.equal(secondArrival.sent[0].body.attribution.source,'google','a genuinely new visit captures its new click source');
assert.ok(!JSON.stringify(secondArrival.sent).includes('secret-click'),'click IDs are not stored in analytics');
assert.equal(captureVisitSource('?msclkid=private','','owtomate.com').source,'bing');
assert.equal(captureVisitSource('?fbclid=private','','owtomate.com').source,'meta','a Meta click ID alone does not establish Facebook versus Instagram');
assert.equal(captureVisitSource('','https://checkout.stripe.com/c/pay/private','owtomate.com').referrer,'');
assert.equal(captureVisitSource('','https://accounts.google.com.au/auth','owtomate.com').referrer,'','regional sign-in returns are not acquisition sources');
assert.equal(captureVisitSource('','https://owtomate.com/pricing?token=secret','owtomate.com').referrer,'');
assert.equal(sourceLabel(null,'https://www.google.com/search?q=private'),'google');
assert.equal(sourceLabel(null,'null/'),UNKNOWN_SOURCE);
const sleeper=fixture();sleeper.track('landing');await flush();
sleeper.setClock(1000);sleeper.intervals[0]();
sleeper.setClock(60*60_000);sleeper.intervals[0]();await flush();
assert.equal(sleeper.sent.find(r=>r.path==='/api/visit/leave')!.body.durationMs,21000,'a sleeping computer does not contribute an hour of visible time');
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
