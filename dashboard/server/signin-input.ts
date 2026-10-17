/** Restricted RFB 3.8/VNC-auth input for the remote sign-in window.
 * Parse the byte stream, not WebSocket frames: either can split/coalesce messages.
 * Unknown protocols/extensions fail closed rather than bypassing the key policy.
 */
const VERSION = Buffer.from('RFB 003.008\n');
const SHIFT = new Set([0xffe1, 0xffe2]);
const CONTROL = new Set([0xffe3, 0xffe4]);
const EDIT_CONTROL = new Set([0x61, 0x63, 0x76, 0x78, 0xff08, 0xffff, 0xff50, 0xff51, 0xff53, 0xff57]);
const EDIT_KEYS = new Set([0xff08, 0xff09, 0xfe20, 0xff0d, 0xff1b, 0xff50, 0xff51, 0xff52, 0xff53, 0xff54, 0xff55, 0xff56, 0xff57, 0xff63, 0xffff, 0xffe5, 0xff8d]);
// Do not negotiate alternate input paths, remote power, clipboard or resizing.
const BLOCK_ENCODINGS = new Set([-258, -316, -309, -308, 0xc0a1e5ce | 0]);
const MAX_MESSAGE = 256 * 1024;

export function signinChromeArgs(startUrl: string): string[] {
  return ['--kiosk', '--noerrdialogs', '--disable-session-crashed-bubble', `--app=${startUrl}`];
}

function keyPacket(key: number, down: boolean): Buffer {
  const packet = Buffer.alloc(8);
  packet[0] = 4;
  packet[1] = down ? 1 : 0;
  packet.writeUInt32BE(key, 4);
  return packet;
}

export class SigninInputFilter {
  private pending: Buffer = Buffer.alloc(0);
  private handshake = 0;
  private controls = new Set<number>();
  private shifts = new Set<number>();
  private pressed = new Set<number>();
  private blockedClick = false;
  private modified = new Set<number>();

  feed(chunk: Buffer): Buffer[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    if (this.pending.length > MAX_MESSAGE) throw new Error('Sign-in input exceeds limit');
    const output: Buffer[] = [];
    while (this.pending.length) {
      // x11vnc is explicitly pinned to 3.8 with password authentication.
      const handshakeLengths = [12, 1, 16, 1];
      if (this.handshake < handshakeLengths.length) {
        const size = handshakeLengths[this.handshake];
        if (this.pending.length < size) break;
        const packet = this.take(size);
        if ((this.handshake === 0 && !packet.equals(VERSION)) || (this.handshake === 1 && packet[0] !== 2) ||
            (this.handshake === 3 && packet[0] > 1)) throw new Error('Unsupported sign-in handshake');
        // Never let a new viewer evict another through the RFB exclusive flag.
        output.push(this.handshake === 3 ? Buffer.from([1]) : packet);
        this.handshake++;
        continue;
      }
      const type = this.pending[0];
      let size: number;
      switch (type) {
        case 0: size = 20; break;
        case 2:
          if (this.pending.length < 4) return output;
          size = 4 + 4 * this.pending.readUInt16BE(2); break;
        case 3: size = 10; break;
        case 4: size = 8; break;
        case 5: size = 6; break;
        case 6:
          if (this.pending.length < 8) return output;
          size = 8 + this.pending.readUInt32BE(4); break;
        case 150: size = 10; break;
        case 248:
          if (this.pending.length < 9) return output;
          if (this.pending[8] > 64) throw new Error('Invalid sign-in fence');
          size = 9 + this.pending[8]; break;
        default: throw new Error('Unsupported sign-in input');
      }
      if (size > MAX_MESSAGE) throw new Error('Sign-in input exceeds limit');
      if (this.pending.length < size) break;
      const packet = this.take(size);
      if (type === 4) output.push(...this.key(packet));
      else if (type === 5) {
        // Only plain left-click and vertical wheel. No context menu, middle-
        // click, back/forward buttons or modified link-opening/drag gestures.
        const mask = packet[1];
        if ((mask & 1) && (this.shifts.size || this.controls.size || this.modified.size)) this.blockedClick = true;
        packet[1] = (mask & 0x18) | (this.blockedClick ? 0 : mask & 1);
        if (!(mask & 1)) this.blockedClick = false;
        output.push(packet);
      } else if (type === 2) {
        const encodings: number[] = [];
        for (let i = 4; i < packet.length; i += 4) {
          const encoding = packet.readInt32BE(i);
          if (!BLOCK_ENCODINGS.has(encoding)) encodings.push(encoding);
        }
        const safe = Buffer.alloc(4 + 4 * encodings.length);
        safe[0] = 2;
        safe.writeUInt16BE(encodings.length, 2);
        encodings.forEach((encoding, i) => safe.writeInt32BE(encoding, 4 + i * 4));
        output.push(safe);
      } else if (type !== 6) output.push(packet); // Clipboard never enters X11.
    }
    return output;
  }

  release(): Buffer[] {
    const packets = [...this.pressed].map(key => keyPacket(key, false));
    this.pressed.clear();
    return packets;
  }

  private take(size: number): Buffer {
    const packet = Buffer.from(this.pending.subarray(0, size));
    this.pending = this.pending.subarray(size);
    return packet;
  }

  private key(packet: Buffer): Buffer[] {
    const key = packet.readUInt32BE(4);
    const down = packet[1] !== 0;
    if (CONTROL.has(key)) {
      if (down) this.controls.add(key); else this.controls.delete(key);
      return [];
    }
    // Alt, Meta, Super, Hyper and ISO level-3 shortcuts never reach Chrome.
    if ((key >= 0xffe7 && key <= 0xffee) || key === 0xfe03) {
      if (down) this.modified.add(key); else this.modified.delete(key);
      return [];
    }
    if (SHIFT.has(key)) {
      if (down) this.shifts.add(key); else this.shifts.delete(key);
      return [];
    }
    if (!down) {
      if (!this.pressed.delete(key)) return [];
      return [keyPacket(key, false)];
    }
    if (this.modified.size) return [];
    // Shift+Enter opens focused links in a new window; Shift+Escape opens
    // Chrome's task manager. Neither is needed to enter sign-in details.
    if (this.shifts.size && [0xff0d, 0xff8d, 0xff1b].includes(key)) return [];
    if (this.controls.size) {
      const lower = key >= 0x41 && key <= 0x5a ? key + 32 : key;
      if (this.shifts.size || !EDIT_CONTROL.has(lower)) return [];
      this.pressed.add(key);
      // Control exists remotely only around a permitted editing action.
      return [keyPacket(0xffe3, true), packet, keyPacket(0xffe3, false)];
    }
    const text = (key >= 0x20 && key <= 0xff) || (key >= 0x01000100 && key <= 0x0110ffff);
    const keypad = key >= 0xffaa && key <= 0xffb9;
    if (!text && !keypad && !SHIFT.has(key) && !EDIT_KEYS.has(key)) return [];
    this.pressed.add(key);
    // Keep modifiers local between messages/connections. A stale Shift must
    // never turn a later viewer's plain click into an open-window gesture.
    if (this.shifts.size) return [keyPacket(0xffe1, true), packet, keyPacket(0xffe1, false)];
    return [packet];
  }
}
