/**
 * Self-check untuk pairCorrelation (dipakai guard korelasi arena).
 * Run: npx tsx scripts/smoke-paircorr.ts
 */
import { pairCorrelation } from '../lib/algorithms/correlationMatrix';
import { Candle } from '../lib/types';

const mk = (n: number, seed: number, gap = false): Candle[] =>
  Array.from({ length: n }, (_, i) => ({
    time: i * 3600_000 + (gap && i > 50 ? 60_000 : 0),
    open: 100, high: 100, low: 100,
    close: 100 * Math.sin((i + seed) / 7) + 100 + i * 0.01,
  })).filter((c, i) => !(gap && i === 30)) as Candle[];

const a = mk(300, 0);
const same = mk(300, 0);
const indep = mk(300, 11);

const cSame = pairCorrelation(a, same);
const cIndep = pairCorrelation(a, indep);
const cGap = pairCorrelation(a, mk(300, 0, true));
const cNull = pairCorrelation(a, []);

console.log({ cSame, cIndep, cGap, cNull });
if (cSame === null || Math.abs(cSame) < 0.99) throw new Error('series identik harus corr ≈1');
if (cIndep === null || Math.abs(cIndep) > 0.3) throw new Error('series beda fase harus rendah corr');
if (cGap !== null) throw new Error('bar tidak sinkron harus null (guard tidak jalan di data rusak)');
if (cNull !== null) throw new Error('data kosong harus null');
console.log('SMOKE-PAIRCORR OK');
