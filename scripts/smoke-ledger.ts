import { nearestCandle, alphaOf, SCORE_TOLERANCE_MS } from '../lib/signalLedger';
import type { Candle } from '../lib/types';

/**
 * Assert-based self-check for the ledger's pure scoring math: which candle the
 * score reads, and how alpha is signed. The DB write path is covered by the
 * migration's BEFORE UPDATE trigger.
 */

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const H = 3600_000;
const candle = (time: number, close: number): Candle => ({
  time, open: close, high: close, low: close, close, volume: 0,
});
const approx = (a: number | null, b: number) => a != null && Math.abs(a - b) < 1e-9;

const series = [candle(0, 100), candle(4 * H, 110), candle(8 * H, 90)];

check('tolerance is 6h', SCORE_TOLERANCE_MS === 6 * H);
check('nearest candle exact hit', nearestCandle(series, 4 * H)?.close === 110);
// 13h: nearest is the 8h candle, 5h away — inside the 6h tolerance.
check('nearest candle within tolerance', nearestCandle(series, 13 * H)?.close === 90);
// 15h: nearest is the 8h candle, 7h away — outside tolerance.
check('beyond tolerance is null', nearestCandle(series, 15 * H) === null);
check('picks the closer neighbour', nearestCandle(series, 9 * H)?.close === 90);

// Asset +10%, benchmark +5% → long alpha +5%, short alpha -5%.
check('long alpha = asset - bench', approx(alphaOf('long', 100, 110, 200, 210), 0.05));
check('short alpha flips sign', approx(alphaOf('short', 100, 110, 200, 210), -0.05));
// Asset +5%, benchmark +10% → long alpha -5% (lagging even while rising).
check('long alpha negative when lagging', approx(alphaOf('long', 100, 105, 200, 220), -0.05));
check('zero base is null', alphaOf('long', 0, 110, 200, 210) === null);
check('non-finite target is null', alphaOf('long', 100, NaN, 200, 210) === null);

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('LEDGER_OK');
