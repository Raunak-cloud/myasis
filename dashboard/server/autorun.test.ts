import { slotMinutes } from './autorun.js';

/**
 * A whole day, minute by minute, against the timetable.
 *
 * The scheduler's promise is specific: every account gets its runs, no more
 * than the machine's lane count start together, and nobody is starved because
 * the sweep happened to read them last. Those are simulation properties, not
 * things a unit test of one function can show, so this plays the day out.
 */

const WINDOW = 720; // 9am-9pm
const RUNS = 4;
const LANES = 2;

interface DayResult {
  perUser: number[];
  peakConcurrent: number;
  startTimes: Map<number, number[]>;
}

/**
 * @param runLength how long a run occupies a lane, in minutes
 */
function simulate(accounts: number, runLength: number): DayResult {
  const done = new Array(accounts).fill(0);
  const startTimes = new Map<number, number[]>();
  const busyUntil = new Array(accounts).fill(-1);
  let peakConcurrent = 0;

  for (let minute = 0; minute <= WINDOW; minute++) {
    const running = busyUntil.filter((until) => until > minute).length;
    peakConcurrent = Math.max(peakConcurrent, running);

    // The same rule the scheduler uses: whoever is furthest behind goes first.
    const due = Array.from({ length: accounts }, (_, i) => i)
      .filter((i) => done[i] < RUNS && busyUntil[i] <= minute && minute >= slotMinutes(i, done[i], accounts, LANES, RUNS))
      .sort((a, b) => done[a] - done[b] || slotMinutes(a, done[a], accounts, LANES, RUNS) - slotMinutes(b, done[b], accounts, LANES, RUNS));

    let lanesFree = LANES - running;
    for (const i of due) {
      if (lanesFree <= 0) break;
      busyUntil[i] = minute + runLength;
      done[i] += 1;
      lanesFree -= 1;
      if (!startTimes.has(i)) startTimes.set(i, []);
      startTimes.get(i)!.push(minute);
    }
  }
  return { perUser: done, peakConcurrent, startTimes };
}

let bad = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const clock = (m: number) => `${String(9 + Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m) % 60).padStart(2, '0')}`;

// ---- the shape of the timetable itself
console.log(`timetable for 10 accounts, 2 lanes, ${RUNS} runs each:`);
for (let i = 0; i < 10; i++) {
  const times = Array.from({ length: RUNS }, (_, r) => clock(slotMinutes(i, r, 10, LANES, RUNS)));
  console.log(`   account ${String(i).padStart(2)}: ${times.join('  ')}`);
}
console.log('');

const last = slotMinutes(9, RUNS - 1, 10, LANES, RUNS);
check('the final slot is inside the window', last < WINDOW, `${clock(last)}`);

// At most one lane's worth of accounts may share any single slot time.
const at = new Map<number, number>();
for (let i = 0; i < 10; i++) {
  for (let r = 0; r < RUNS; r++) {
    const t = Math.round(slotMinutes(i, r, 10, LANES, RUNS));
    at.set(t, (at.get(t) ?? 0) + 1);
  }
}
check('no more than 2 accounts share a slot', Math.max(...at.values()) <= LANES, `max ${Math.max(...at.values())}`);

// ---- a day where runs finish inside their slot
console.log('');
const brisk = simulate(10, 25);
check(`10 accounts each get all ${RUNS} runs (25-minute runs)`, brisk.perUser.every((n) => n === RUNS), brisk.perUser.join(','));
check('never more than 2 at once', brisk.peakConcurrent <= LANES, `peak ${brisk.peakConcurrent}`);
console.log(`   account 0 started at: ${(brisk.startTimes.get(0) ?? []).map(clock).join(', ')}`);
console.log(`   account 9 started at: ${(brisk.startTimes.get(9) ?? []).map(clock).join(', ')}`);

// ---- a day where runs overrun their slot, which is the realistic risk
console.log('');
const slow = simulate(10, 45);
check('never more than 2 at once when runs overrun', slow.peakConcurrent <= LANES, `peak ${slow.peakConcurrent}`);
check(
  'an overrun costs runs evenly rather than starving anyone',
  Math.max(...slow.perUser) - Math.min(...slow.perUser) <= 1,
  `per account: ${slow.perUser.join(',')}`,
);
console.log(`   total applications that day: ${slow.perUser.reduce((a, b) => a + b, 0)} of ${10 * RUNS}`);

// ---- smaller and larger tenancies
console.log('');
for (const n of [1, 2, 4, 20]) {
  const day = simulate(n, 25);
  const full = day.perUser.every((x) => x === RUNS);
  check(
    `${String(n).padStart(2)} account(s): ${full ? 'all runs delivered' : 'oversubscribed'}`,
    day.peakConcurrent <= LANES,
    `peak ${day.peakConcurrent}, total ${day.perUser.reduce((a, b) => a + b, 0)}/${n * RUNS}`,
  );
}

console.log(`\n${bad} failure(s)`);
process.exit(bad ? 1 : 0);
