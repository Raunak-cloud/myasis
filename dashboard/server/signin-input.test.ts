import assert from 'node:assert/strict';
import test from 'node:test';
import { SigninInputFilter, signinChromeArgs } from './signin-input.js';

const key = (symbol: number, down = true) => {
  const packet = Buffer.alloc(8); packet[0] = 4; packet[1] = Number(down); packet.writeUInt32BE(symbol, 4); return packet;
};
const pointer = (mask: number) => Buffer.from([5, mask, 0, 100, 0, 100]);
const handshake = Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([2]), Buffer.alloc(16), Buffer.from([1])]);
function ready() { const filter = new SigninInputFilter(); filter.feed(handshake); return filter; }

test('sign-in Chrome has neither a tab strip nor an editable address bar', () => {
  assert.deepEqual(signinChromeArgs('https://login.example/'), ['--kiosk', '--noerrdialogs', '--disable-session-crashed-bubble', '--app=https://login.example/']);
});
test('fragmented/coalesced handshake and messages retain their boundaries', () => {
  const source = Buffer.concat([handshake, key(65), key(65, false), pointer(1), pointer(0)]);
  for (let split = 1; split <= source.length; split++) {
    const filter = new SigninInputFilter(); const output: Buffer[] = [];
    for (let start = 0; start < source.length; start += split) output.push(...filter.feed(source.subarray(start, start + split)));
    assert.deepEqual(Buffer.concat(output), source);
  }
});
test('browser address, tab, window, developer tools, fullscreen, menus and file shortcuts never reach Chrome', () => {
  for (const modifier of [0xffe3, 0xffe4, 0xffe9, 0xffea, 0xffeb, 0xffec, 0xffe7, 0xffe8, 0xffed, 0xffee]) {
    for (const symbol of [0x6c, 0x74, 0x6e, 0x6f, 0x70, 0x73, 0x75, 0x77, 0x31, 0xff0d, 0xff09, 0xffc1]) {
      const filter = ready();
      assert.equal(Buffer.concat(filter.feed(Buffer.concat([key(modifier), key(symbol), key(symbol, false), key(modifier, false)]))).length, 0);
    }
  }
  const filter = ready();
  for (const symbol of [0xff67, 0xffbe, 0xffc7, 0xffc8, 0xffc9, 0xfe13, 0x1008ff26, 0x1008ff30]) {
    assert.equal(filter.feed(Buffer.concat([key(symbol), key(symbol, false)])).length, 0);
  }
});
test('credentials, capitals, Unicode, OTP and navigation/editing remain usable', () => {
  const filter = ready();
  assert.deepEqual(filter.feed(key(0xffe1)), []);
  assert.deepEqual(filter.feed(key(0x41)), [key(0xffe1), key(0x41), key(0xffe1, false)]);
  assert.deepEqual(filter.feed(key(0x41, false)), [key(0x41, false)]);
  assert.deepEqual(filter.feed(key(0xffe1, false)), []);
  const packets = [0x40, 0x32, 0x21, 0x01000928, 0xff09, 0xff08, 0xff51, 0xff0d].flatMap(symbol => [key(symbol), key(symbol, false)]);
  assert.deepEqual(Buffer.concat(filter.feed(Buffer.concat(packets))), Buffer.concat(packets));
  assert.deepEqual(filter.feed(key(0xffe3)), []);
  assert.deepEqual(filter.feed(key(0x61)), [key(0xffe3), key(0x61), key(0xffe3, false)]);
  assert.deepEqual(filter.feed(key(0x61, false)), [key(0x61, false)]);
  assert.deepEqual(filter.feed(key(0xffe3, false)), []);
  assert.deepEqual(filter.feed(key(0x76)), [key(0x76)], 'Control must not remain pressed');
});
test('right/middle click, modified clicks and browser mouse buttons are suppressed; scrolling and plain click work', () => {
  const filter = ready();
  for (const mask of [2, 4, 32, 64, 128]) assert.equal(filter.feed(pointer(mask))[0][1], 0);
  for (const mask of [0, 1, 8, 16]) assert.equal(filter.feed(pointer(mask))[0][1], mask);
  for (const modifier of [0xffe1, 0xffe2, 0xffe3, 0xffe9, 0xffeb]) {
    filter.feed(key(modifier));
    assert.equal(filter.feed(pointer(1))[0][1], 0);
    filter.feed(key(modifier, false));
    assert.equal(filter.feed(pointer(1))[0][1], 0, 'do not start a drag when modifier is released');
    filter.feed(pointer(0));
    assert.equal(filter.feed(pointer(1))[0][1], 1);
    filter.feed(pointer(0));
  }
});
test('input extensions and clipboard cannot bypass restrictions', () => {
  const filter = ready(); const encodings = [0, -239, -258, -316, -309, -308, 0xc0a1e5ce | 0];
  const packet = Buffer.alloc(4 + encodings.length * 4); packet[0] = 2; packet.writeUInt16BE(encodings.length, 2);
  encodings.forEach((encoding, i) => packet.writeInt32BE(encoding, 4 + i * 4));
  const safe = filter.feed(packet)[0];
  assert.equal(safe.readUInt16BE(2), 2); assert.equal(safe.readInt32BE(8), -239);
  const clipboard = Buffer.from([6, 0, 0, 0, 0, 0, 0, 1, 65]);
  assert.deepEqual(filter.feed(clipboard), []);
  assert.throws(() => ready().feed(Buffer.from([255, 0, 0, 1])), /Unsupported/);
  assert.throws(() => ready().feed(Buffer.from([253])), /Unsupported/);
  assert.throws(() => ready().feed(Buffer.from([6, 0, 0, 0, 127, 255, 255, 255])), /limit/);
  assert.throws(() => new SigninInputFilter().feed(Buffer.from('RFB 003.003\n')), /handshake/);
  const badAuth = new SigninInputFilter(); badAuth.feed(Buffer.from('RFB 003.008\n'));
  assert.throws(() => badAuth.feed(Buffer.from([1])), /handshake/);
});
test('Shift+Enter and Shift+Escape are blocked but Shift+Tab still works', () => {
  const filter = ready(); filter.feed(key(0xffe1));
  for (const symbol of [0xff0d, 0xff8d, 0xff1b]) assert.deepEqual(filter.feed(Buffer.concat([key(symbol), key(symbol, false)])), []);
  assert.deepEqual(filter.feed(key(0xff09)), [key(0xffe1), key(0xff09), key(0xffe1, false)]);
});
test('disconnect releases remote keys; modifiers are never left down between events', () => {
  const filter = ready(); filter.feed(Buffer.concat([key(0xffe1), key(65)]));
  assert.deepEqual(filter.release(), [key(65, false)]);
  assert.deepEqual(filter.release(), []);
});
