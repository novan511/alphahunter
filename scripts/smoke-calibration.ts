import {
  levelsFor,
  firstTouch,
  LEVEL_CONVENTION,
  ATR_STOP_MULT,
  TARGET_R,
  FOUR_H_BAR_SEC,
  MAX_HOLD_SEC,
} from '../lib/signalLevels';
import { bucketStats, calibrationLines, MIN_SAMPLE } from '../lib/calibration';
import type { Candle } from '../lib/types';

/**
 * Assert-based self-check for the calibration path: where the stop and target
 * sit, which event a candle path is recorded as, and the sample gate that stops
 * a thin bucket from publishing a number. The write path is covered by the
 * migration 015 trigger, not here.
 *
 * `time` is in seconds, like every market data source. Millisecond fixtures
 * would make every check below pass while production scored nothing.
 */

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const H = 3600; // seconds
const bar = (time: number, o: number, h: number, l: number, c: number): Candle => ({
  time, open: o, high: h, low: l, close: c, volume: 0,
});
const near = (a: number | null | undefined, b: number) => a != null && Math.abs(a - b) < 1e-6;

/* ---------------- levels ---------------- */

const long = levelsFor('long', 100, 4);
check('long stop is 1.5 ATR below entry', near(long?.stop, 100 - ATR_STOP_MULT * 4));
check('long target is 2R above entry', near(long?.target, 100 + TARGET_R * ATR_STOP_MULT * 4));
check('long risk is exactly 2R away', near((long!.target - 100) / (100 - long!.stop), TARGET_R));

const short = levelsFor('short', 100, 4);
check('short stop is above entry', (short?.stop ?? 0) > 100);
check('short target is below entry', (short?.target ?? 0) < 100);
check('convention is versioned', long?.convention === LEVEL_CONVENTION);

check('no atr means no levels', levelsFor('long', 100, null) === null);
check('zero atr means no levels', levelsFor('long', 100, 0) === null);
check('no entry means no levels', levelsFor('long', null, 4) === null);
check('short with unusable entry is null', levelsFor('short', 0, 4) === null);
// Entry 5 with risk 1.5*4=6 would put a long stop at -1: unrepresentable, and a
// silently clamped stop would make R a lie.
check('long stop below zero is refused', levelsFor('long', 5, 4) === null);

/* ---------------- first touch ---------------- */

const emit = H; // mid-bar: the bar at time 0 belongs to the pre-entry path
const opts = { nowSec: emit + 8 * H };
const entry = 100;
const stop = 94;
const target = 112;

const stopFirst = firstTouch(
  [bar(0, 100, 101, 90, 95), bar(4 * H, 98, 105, 93, 104)],
  'long', entry, stop, target, emit, opts
);
check('bar that hits the stop is a stop', stopFirst?.outcome === 'stop');
check('exact stop fill is -1R', near(stopFirst?.r, -1));

const targetFirst = firstTouch(
  [bar(0, 100, 120, 99, 118), bar(4 * H, 100, 113, 99, 112)],
  'long', entry, stop, target, emit, opts
);
check('bar that hits the target is a target', targetFirst?.outcome === 'target');
check('target fill is +2R', near(targetFirst?.r, 2));
// The entry bar's own high (120) is above target. Counting it would book a win
// on price action that may have happened before the signal existed.
check('entry bar is not part of the path', targetFirst?.bars === 1);

const both = firstTouch([bar(4 * H, 100, 113, 93, 100)], 'long', entry, stop, target, emit, opts);
check('same-bar stop and target counts as a stop', both?.outcome === 'stop');

const gapStop = firstTouch([bar(4 * H, 90, 95, 88, 92)], 'long', entry, stop, target, emit, opts);
check('gap through the stop fills at the open', near(gapStop?.r, (90 - entry) / (entry - stop)));
check('gap through the stop is worse than -1R', (gapStop?.r ?? 0) < -1);

const gapTarget = firstTouch([bar(4 * H, 115, 116, 110, 115)], 'long', entry, stop, target, emit, opts);
check('gap through the target is not credited above 2R', near(gapTarget?.r, 2));

const undecided = firstTouch(
  [bar(4 * H, 100, 105, 98, 103)],
  'long', entry, stop, target, emit, { nowSec: emit + 24 * H }
);
check('untouched inside the window is not scored yet', undecided === null);
check(
  'no bar after entry is not scored yet',
  firstTouch([bar(0, 100, 120, 90, 100)], 'long', entry, stop, target, emit, opts) === null
);

// A contiguous run of 4h bars through the whole hold window, touching nothing.
// Contiguity matters: a hole is a `lost` path, so a two-bar fixture would prove
// nothing about the time exit.
const flatRun = (): Candle[] => {
  const bars: Candle[] = [];
  for (let t = FOUR_H_BAR_SEC; t < emit + MAX_HOLD_SEC; t += FOUR_H_BAR_SEC) {
    bars.push(bar(t, 100, 105, 98, 103));
  }
  // One bar opening exactly on the deadline, holding a level that would be a
  // stop if it counted. It is outside the window and must never be read.
  bars.push(bar(emit + MAX_HOLD_SEC, 103, 104, 88, 90));
  return bars;
};

const timedOut = firstTouch(flatRun(), 'long', entry, stop, target, emit, {
  nowSec: emit + MAX_HOLD_SEC + H,
});
check('untouched after the hold window is a time exit', timedOut?.outcome === 'open');
check('time exit uses the last bar fully inside the window', near(timedOut?.r, (103 - entry) / (entry - stop)));
check('a bar opening on the deadline cannot cause a stop', timedOut?.outcome === 'open');

const lost = firstTouch(
  [bar(emit + 2 * FOUR_H_BAR_SEC, 100, 105, 98, 101)],
  'long', entry, stop, target, emit, opts
);
check('a path whose start is gone is lost, not scored', lost?.outcome === 'lost');
check('a lost path carries no R', lost?.r === null);

// A hole in the middle: the bar at 8h is missing, and it is exactly the bar that
// would have hit the target. Walking past it would book a win nobody could see.
const gapped = firstTouch(
  [bar(4 * H, 100, 105, 98, 101), bar(12 * H, 100, 113, 99, 112)],
  'long', entry, stop, target, emit, opts
);
check('a missing bar in the middle makes the path lost', gapped?.outcome === 'lost');

// Series stops 8h after entry (delisted pair) with the window long expired.
const truncated = [bar(4 * H, 100, 105, 98, 101), bar(8 * H, 101, 106, 99, 102)];
check(
  'a series that stops before the window closes is lost',
  firstTouch(truncated, 'long', entry, stop, target, emit, {
    nowSec: emit + MAX_HOLD_SEC + H,
  })?.outcome === 'lost'
);
check(
  'the same short tail before the deadline is only undecided',
  firstTouch(truncated, 'long', entry, stop, target, emit, { nowSec: emit + 24 * H }) === null
);

const shortHit = firstTouch([bar(4 * H, 99, 99, 87, 88)], 'short', 100, 106, 88, emit, opts);
check('short target fires on the low', shortHit?.outcome === 'target');
check('short target is +2R', near(shortHit?.r, 2));
const shortStop = firstTouch([bar(4 * H, 100, 107, 99, 106)], 'short', 100, 106, 88, emit, opts);
check('short stop fires on the high', shortStop?.outcome === 'stop');
check('short stop is -1R', near(shortStop?.r, -1));

check('a stop on the wrong side yields nothing', firstTouch(
  [bar(4 * H, 100, 101, 99, 100)], 'long', entry, 101, target, emit, opts
) === null);

/* ---------------- calibration gate ---------------- */

const decided = (signal: string, wins: number, losses: number) => [
  ...Array.from({ length: wins }, () => ({ signal, outcome: 'target', r: 2 })),
  ...Array.from({ length: losses }, () => ({ signal, outcome: 'stop', r: -1 })),
];

const thin = bucketStats(decided('buy', 17, 12));
check('29 decided trades is below the floor', thin[0].n === MIN_SAMPLE - 1 && !thin[0].conclusive);
check('a thin bucket still reports its sample', thin[0].winRate != null);
check(
  'a thin bucket prints words, not a rate',
  calibrationLines(thin)[0].includes('sampel belum cukup')
);
// The number exists in memory (winRate is filled) but must not reach the model's
// context, where it would be quoted as an edge. Match a formatted rate, not the
// word "expectancy" — the line names it precisely to forbid quoting it.
const hasRate = (line: string) => /expectancy [+-]?\d/.test(line) || /\d+%/.test(line);
check('a thin bucket prints no rate at all', !hasRate(calibrationLines(thin)[0]));

const strong = bucketStats(decided('strong_buy', 20, 10));
check('n=30 with a clear edge is conclusive', strong[0].n === 30 && strong[0].conclusive);
check('expectancy is the mean R', near(strong[0].expectancyR, 1));
check('interval is reported alongside', (strong[0].expectancyCi?.lo ?? -1) > 0);
check('a conclusive bucket prints the number', calibrationLines(strong)[0].includes('expectancy'));

// 15 wins / 25 losses over 40: a positive mean whose interval still straddles
// zero. Publishing "+0.13R" here would be noise dressed as a base rate.
const noisy = bucketStats(decided('sell', 15, 25));
check('a positive mean is not enough to be conclusive', noisy[0].n === 40 && !noisy[0].conclusive);
check(
  'a straddling interval says so, and does not blame the sample',
  calibrationLines(noisy)[0].includes('menyentuh nol') &&
    !calibrationLines(noisy)[0].includes('sampel belum cukup')
);
check('a straddling bucket prints no rate either', !hasRate(calibrationLines(noisy)[0]));

const mixed = bucketStats([
  { signal: 'buy', outcome: 'target', r: 2 },
  { signal: 'buy', outcome: 'stop', r: -1.6667 },
  { signal: 'buy', outcome: 'open', r: -0.3 },
  { signal: 'buy', outcome: 'lost', r: null },
  { signal: 'buy', outcome: null, r: null },
]);
check('unresolved rows do not enter the rate', mixed[0].n === 2);
check('time exits are counted apart', mixed[0].open === 1);
check('lost paths are counted apart', mixed[0].lost === 1);
check('pending rows are counted apart', mixed[0].pending === 1);
// Win rate would say 3p-1 = +0.5, but one loss gapped through its stop: gaps and
// time exits are why expectancy must be the mean of stored R.
check('expectancy is not 3p-1', near(mixed[0].expectancyR, (2 - 1.6667) / 2));
check('an empty table yields no buckets', bucketStats([]).length === 0);
// A bucket with only time exits has outcomes but no rate; saying "no results"
// would read as "no data" while five completed trades sit there.
const onlyOpen = bucketStats([{ signal: 'buy', outcome: 'open', r: -0.2 }]);
check('time exits are visible with no decided row', onlyOpen[0].open === 1 && onlyOpen[0].n === 0);
check('the no-rate line still mentions time exits', calibrationLines(onlyOpen)[0].includes('waktu habis'));

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('CALIBRATION_OK');
