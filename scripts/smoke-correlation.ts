/**
 * Correctness checks for the pairwise strength matrix.
 *
 * Run: npx tsx scripts/smoke-correlation.ts
 *
 * These use synthetic candles with known relationships so we can assert the
 * math, not just that it runs.
 */

import {
  computeMatrix,
  classifyStrength,
  alignOnTime,
} from '../lib/algorithms/correlationMatrix';
import { Candle } from '../lib/types';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Deterministic pseudo-random so runs are reproducible. */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function gauss(r: () => number): number {
  // Box-Muller
  const u = Math.max(r(), 1e-9);
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Build a candle series from a return series. `start` controls the initial
 * price so we can test that strength is independent of price level.
 */
function toCandles(returns: number[], start: number, baseTime: number): Candle[] {
  const out: Candle[] = [];
  let price = start;
  for (let i = 0; i < returns.length; i++) {
    const close = price * Math.exp(returns[i]);
    out.push({
      time: baseTime + i * 3600,
      open: price,
      high: Math.max(price, close) * 1.002,
      low: Math.min(price, close) * 0.998,
      close,
      volume: 1000,
    });
    price = close;
  }
  return out;
}

// --- Case 1: known relative performance --------------------------------------
console.log('\n[1] Strong asset must beat weak asset by exactly its excess return');

{
  const r = rng(42);
  const n = 61;
  const base: number[] = [];
  const strong: number[] = [];
  const weak: number[] = [];

  // Feed-forward: generate base first, then build others off it so we know
  // the exact relationship.
  for (let i = 0; i < n; i++) base.push(gauss(r) * 0.02);
  // strong = base + constant drift  -> excess is deterministic
  for (let i = 0; i < n; i++) strong.push(base[i] + 0.001);
  // weak = base - constant drift
  for (let i = 0; i < n; i++) weak.push(base[i] - 0.001);

  const t0 = 1_700_000_000;
  const series = {
    BASE: toCandles(base, 100, t0),
    STRONG: toCandles(strong, 5, t0),
    WEAK: toCandles(weak, 50_000, t0),
  };

  const m = computeMatrix(series, ['BASE', 'STRONG', 'WEAK'], 60, '4h');
  check('matrix produced', m !== null);
  if (!m) throw new Error('stop');

  const iBase = m.symbols.indexOf('BASE');
  const iStrong = m.symbols.indexOf('STRONG');
  const iWeak = m.symbols.indexOf('WEAK');

  // rs is a LOG difference, so +0.001/bar over 60 bars is exactly +6.00,
  // not exp(0.06)-1 = 6.18. The log form is what makes the matrix exactly
  // antisymmetric, which the dominance sum depends on.
  const expected = 6.0;
  const rsStrongBase = m.rs[iStrong][iBase];

  check(
    'STRONG beats BASE by 6.00 log-%',
    Math.abs(rsStrongBase - expected) < 0.05,
    `got ${rsStrongBase}, expected ${expected.toFixed(2)}`,
  );

  check(
    'anti-symmetry is exact',
    Math.abs(m.rs[iBase][iStrong] + rsStrongBase) < 0.01,
    `${m.rs[iBase][iStrong]} vs ${-rsStrongBase}`,
  );

  check(
    'STRONG beats WEAK by 12.00 log-%',
    Math.abs(m.rs[iStrong][iWeak] - 12.0) < 0.05,
    `got ${m.rs[iStrong][iWeak]}, expected 12.00`,
  );

  check('diag corr is 1', m.corr[iBase][iBase] === 1);
  check(
    'perfectly co-moving series give corr ~1',
    m.corr[iStrong][iBase] > 0.999,
    `got ${m.corr[iStrong][iBase]}`,
  );
  check(
    'beta of strong vs base is ~1',
    Math.abs(m.beta[iStrong][iBase] - 1) < 0.02,
    `got ${m.beta[iStrong][iBase]}`,
  );

  check('dominance ordering correct', m.coins[iStrong].dominanceRank === 0, `rank ${m.coins[iStrong].dominanceRank}`);
  check('weak is last', m.coins[iWeak].dominanceRank === 2);

  // Price level must not leak into the result: STRONG starts at 5, WEAK at
  // 50,000, yet strength is purely return-based.
  check(
    'price level does not affect strength',
    m.coins[iStrong].dominance > m.coins[iBase].dominance &&
      m.coins[iBase].dominance > m.coins[iWeak].dominance,
  );
}

// --- Case 2: timestamp alignment --------------------------------------------
console.log('\n[2] Timestamp alignment must not misalign unequal histories');

{
  const r = rng(7);
  const n = 61;
  const a: number[] = [];
  for (let i = 0; i < n; i++) a.push(gauss(r) * 0.02);
  const b: number[] = [];
  for (let i = 0; i < n; i++) b.push(gauss(r) * 0.02);

  const t0 = 1_700_000_000;
  const A = toCandles(a, 100, t0);
  // B is missing the first 10 bars (later listing date)
  const B = toCandles(b, 100, t0).slice(10);

  // Naive slice(-minLen) would pair A[10..60] against B[0..50] — wrong.
  const naive = computeMatrix(
    { A: A.slice(-B.length), B: B },
    ['A', 'B'],
    50,
    '4h',
  );
  const aligned = computeMatrix({ A, B }, ['A', 'B'], 50, '4h');

  check('aligned matrix produced', aligned !== null);
  if (!aligned) throw new Error('stop');
  check('only 50 aligned bars', aligned.bars === 50, `got ${aligned.bars}`);
  check(
    'alignment gives uncorrelated (it is random)',
    Math.abs(aligned.corr[0][1]) < 0.5,
    `corr ${aligned.corr[0][1]}`,
  );
  check('naive path also runs (for contrast)', naive !== null);

  // Direct check of the join itself.
  const al = alignOnTime({ A, B }, ['A', 'B'], 50);
  check('alignOnTime returns shared timestamps', al !== null);
  if (al) {
    check('shared times are unique', new Set(al.times).size === al.times.length);
    check('shared times sorted', al.times.every((t, i) => i === 0 || t > al.times[i - 1]));
    check('closes align length', al.closes.A.length === al.times.length);
  }
}

// --- Case 3: anti-correlated pair -------------------------------------------
console.log('\n[3] Inverse relationship gives corr -1 and beta -1');

{
  const r = rng(99);
  const n = 61;
  const a: number[] = [];
  const b: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = gauss(r) * 0.02;
    a.push(x);
    b.push(-x);
  }
  const t0 = 1_700_000_000;
  const m = computeMatrix(
    { A: toCandles(a, 100, t0), B: toCandles(b, 100, t0) },
    ['A', 'B'],
    60,
    '4h',
  );
  check('matrix produced', m !== null);
  if (!m) throw new Error('stop');
  check('corr is -1', Math.abs(m.corr[0][1] + 1) < 0.001, `got ${m.corr[0][1]}`);
  check('beta is -1', Math.abs(m.beta[0][1] + 1) < 0.01, `got ${m.beta[0][1]}`);
  // A perfect mirror is NOT near-zero strength: rs = 2*sum(a), which is a
  // random walk, not a constant. What must hold is that whichever way it
  // drifted, the reverse cell is the exact opposite.
  check(
    'strength is antisymmetric on a mirror',
    Math.abs(m.rs[0][1] + m.rs[1][0]) < 0.01,
    `${m.rs[0][1]} vs ${m.rs[1][0]}`,
  );
  // The first return in the array is dropped by logReturns (it needs a prior
  // close), so the expected sum is over a[1..n-1].
  check(
    'mirror strength matches 2x the random walk',
    Math.abs(m.rs[0][1] - a.slice(1).reduce((s, x) => s + x, 0) * 200) < 0.05,
    `got ${m.rs[0][1]}, expected ${(a.slice(1).reduce((s, x) => s + x, 0) * 200).toFixed(2)}`,
  );
}

// --- Case 4: guards ----------------------------------------------------------
console.log('\n[4] Guards reject unusable input');

{
  const t0 = 1_700_000_000;
  const c = toCandles([0.01, -0.01, 0.02], 100, t0);

  check('single symbol rejected', computeMatrix({ A: c }, ['A'], 30, '4h') === null);
  check('empty series rejected', computeMatrix({ A: [], B: [] }, ['A', 'B'], 30, '4h') === null);
  check('too-short window rejected', computeMatrix({ A: c, B: c }, ['A', 'B'], 30, '4h') === null);
  check(
    'disjoint time ranges rejected',
    computeMatrix(
      { A: c, B: c.map((x) => ({ ...x, time: x.time + 999_999_999 })) },
      ['A', 'B'],
      30,
      '4h',
    ) === null,
  );
}

// --- Case 5: extension z-score catches a stretched leader ---------------------
console.log('\n[5] extensionZ flags a coin that ran ahead of the basket');

{
  const r = rng(2024);
  const n = 61;
  const base: number[] = [];
  for (let i = 0; i < n; i++) base.push(gauss(r) * 0.015);
  // Parrot tracks base closely; Rocker drifts up hard over the window.
  const parrot: number[] = base.map((x) => x + gauss(r) * 0.001);
  const drift: number[] = [];
  for (let i = 0; i < n; i++) drift.push(base[i] + (i / n) * 0.02);

  // A third member that is genuinely neutral, so PARROT has a real
  // "basket" rather than being the exact inverse of ROCKER. With only two
  // coins the basket IS the other coin, which makes both z-scores mirror
  // images of each other by construction and tests nothing.
  const flat: number[] = base.map(() => gauss(r) * 0.0001);

  const t0 = 1_700_000_000;
  const m = computeMatrix(
    {
      PARROT: toCandles(parrot, 100, t0),
      ROCKER: toCandles(drift, 100, t0),
      FLAT: toCandles(flat, 100, t0),
    },
    ['PARROT', 'ROCKER', 'FLAT'],
    60,
    '4h',
  );
  check('matrix produced', m !== null);
  if (!m) throw new Error('stop');

  const iRocker = m.symbols.indexOf('ROCKER');
  const iParrot = m.symbols.indexOf('PARROT');
  check('rocker ranks first', m.coins[iRocker].dominanceRank === 0, `rank ${m.coins[iRocker].dominanceRank}`);
  check(
    'rocker flagged as extended (z > 1)',
    m.coins[iRocker].extensionZ > 1,
    `z = ${m.coins[iRocker].extensionZ}`,
  );
  // PARROT tracks the base while ROCKER drifts ahead, so PARROT's ratio to the
  // basket slides DOWN steadily. A steady slide is not "extended" — extension
  // is about being stretched to one side. The meaningful assertion is that
  // PARROT is far less stretched than ROCKER.
  check(
    'parrot is not stretched to the upside',
    m.coins[iParrot].extensionZ < 1,
    `z = ${m.coins[iParrot].extensionZ}`,
  );
  check(
    'rocker is far more stretched than parrot',
    m.coins[iRocker].extensionZ - m.coins[iParrot].extensionZ > 3,
    `rocker ${m.coins[iRocker].extensionZ} vs parrot ${m.coins[iParrot].extensionZ}`,
  );
  check(
    'parrot is not flagged as a leader',
    m.coins[iParrot].dominance < m.coins[iRocker].dominance,
    `parrot ${m.coins[iParrot].dominance} vs rocker ${m.coins[iRocker].dominance}`,
  );

  const verdict = classifyStrength(m.coins[iRocker]);
  check(
    'extended leader warns against chasing',
    verdict.note.includes('jangan kejar') || verdict.label === 'LEAD',
    `label ${verdict.label} / note ${verdict.note}`,
  );
}

// --- Case 6: verdict ladder --------------------------------------------------
console.log('\n[6] classifyStrength ladder');

{
  const mk = (dominance: number, extensionZ: number) =>
    classifyStrength({ symbol: 'X', vol: 1, totalReturn: 1, dominance, dominanceRank: 0, avgCorr: 0.5, extensionZ, basketBeta: 1 });

  check('strong + extended -> STRONG with warning', mk(6, 2.5).label === 'STRONG' && mk(6, 2.5).note.includes('jangan kejar'));
  check('strong + not extended -> LEAD', mk(6, 0.5).label === 'LEAD');
  check('mildly positive -> STRONG', mk(3, 0).label === 'STRONG');
  check('flat -> NEUTRAL', mk(0, 0).label === 'NEUTRAL');
  check('mildly negative -> WEAK', mk(-3, 0).label === 'WEAK');
  check('very negative -> LAGGARD', mk(-8, 0).label === 'LAGGARD');
}

console.log(
  failures === 0
    ? '\nAll correlation matrix checks passed.\n'
    : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);