/**
 * Performance benchmark for the pairwise strength matrix.
 *
 * Run: npx tsx scripts/bench-correlation.ts
 *
 * Measures the pure compute cost at realistic basket sizes, so we know what
 * happens when a user adds coins rather than guessing.
 */

import { computeMatrix, alignOnTime } from '../lib/algorithms/correlationMatrix';
import { Candle } from '../lib/types';

function rng(seed: number): () => number {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}
function gauss(r: () => number): number {
  const u = Math.max(r(), 1e-9); const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function series(symbols: string[], bars: number, seed: number): Record<string, Candle[]> {
  const r = rng(seed);
  const out: Record<string, Candle[]> = {};
  const common: number[] = [];
  for (let i = 0; i < bars; i++) common.push(gauss(r) * 0.02);
  let t = 1_700_000_000;
  for (const sym of symbols) {
    const r2 = rng(seed + sym.length);
    let price = 100;
    out[sym] = [];
    for (let i = 0; i < bars; i++) {
      const ret = common[i] * (0.6 + r2() * 0.8) + gauss(r2) * 0.008;
      const close = price * Math.exp(ret);
      out[sym].push({
        time: t + i * 14400, open: price,
        high: Math.max(price, close) * 1.003,
        low: Math.min(price, close) * 0.997,
        close, volume: 1000,
      });
      price = close;
    }
  }
  return out;
}

function timeIt(label: string, iterations: number, fn: () => void) {
  // warmup to let the JIT settle
  for (let i = 0; i < 3; i++) fn();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const med = samples[Math.floor(samples.length / 2)];
  const p95 = samples[Math.floor(samples.length * 0.95)];
  const min = samples[0];
  console.log(
    `  ${label.padEnd(34)} med ${med.toFixed(3).padStart(8)} ms   ` +
    `p95 ${p95.toFixed(3).padStart(8)} ms   min ${min.toFixed(3).padStart(8)} ms`,
  );
  return med;
}

const NAMES = ['BTC','ETH','SOL','XRP','SUI','HYPE','BNB','AVAX','LINK','DOGE','ADA','DOT','NEAR','ARB','APT','INJ'];

console.log('\n=== computeMatrix cost by basket size (window=60) ===');
{
  const sizes = [2, 4, 6, 8, 10, 12];
  const medians: Record<number, number> = {};
  for (const n of sizes) {
    const syms = NAMES.slice(0, n);
    const data = series(syms, 400, 7);
    medians[n] = timeIt(`${n} symbols`, 200, () => {
      const m = computeMatrix(data, syms, 60, '4h');
      if (!m) throw new Error('null');
    });
  }
  console.log('\n  scaling:');
  for (const n of sizes) {
    if (n === 2) continue;
    console.log(`    ${n} vs ${sizes[0]}: ${(medians[n] / medians[2]).toFixed(1)}x  (pairs ${(n*(n-1)/2)})`);
  }
}

console.log('\n=== cost by window length (6 symbols) ===');
{
  const syms = NAMES.slice(0, 6);
  const data = series(syms, 700, 11);
  for (const w of [30, 60, 90, 200]) {
    timeIt(`window=${w}`, 150, () => {
      const m = computeMatrix(data, syms, w, '4h');
      if (!m) throw new Error('null');
    });
  }
}

console.log('\n=== cost by candle volume fed in (6 symbols) ===');
{
  const syms = NAMES.slice(0, 6);
  for (const bars of [200, 500, 1000]) {
    const data = series(syms, bars, 13);
    timeIt(`${bars} candles/symbol`, 100, () => {
      const m = computeMatrix(data, syms, 60, '4h');
      if (!m) throw new Error('null');
    });
  }
}

console.log('\n=== alignOnTime alone (6 symbols, 400 candles) ===');
{
  const syms = NAMES.slice(0, 6);
  const data = series(syms, 400, 17);
  timeIt('alignOnTime', 300, () => {
    const a = alignOnTime(data, syms, 60);
    if (!a) throw new Error('null');
  });
}

console.log('\n=== worst case: basket with ragged histories ===');
{
  // Symbols that overlap only partially force the intersection to do real
  // work, which is the expensive path in production.
  const base = series(NAMES.slice(0, 8), 400, 23);
  const ragged: Record<string, Candle[]> = {};
  NAMES.slice(0, 8).forEach((s, i) => {
    ragged[s] = i % 2 === 0 ? base[s].slice(-120) : base[s];
  });
  timeIt('8 symbols, half truncated', 100, () => {
    const m = computeMatrix(ragged, NAMES.slice(0, 8), 60, '4h');
    if (!m) throw new Error('null');
  });
}

console.log('\n=== payload size (6 symbols, window=60) ===');
{
  const syms = NAMES.slice(0, 6);
  const data = series(syms, 400, 29);
  const m = computeMatrix(data, syms, 60, '4h');
  if (m) {
    const bytes = Buffer.byteLength(JSON.stringify(m));
    console.log(`  serialized response: ${bytes} bytes (${(bytes / 1024).toFixed(2)} KB)`);
    console.log(`  matrix cells: ${syms.length ** 2} x 3 matrices (corr, beta, rs)`);
  }
}

console.log('\n=== effective sample size warning ===');
{
  // Autocorrelation makes 60 bars far less than 60 independent observations.
  const syms = ['BTC','ETH','SOL','XRP','SUI','HYPE'];
  const r = rng(31);
  const n = 400;
  const ar1: number[] = [];
  let x = 0;
  for (let i = 0; i < n; i++) { x = 0.95 * x + gauss(r) * 0.006; ar1.push(x); }
  // autocorrelation at lag 1 for AR(1) with rho=0.95 is exactly rho
  let num = 0, d1 = 0, d2 = 0;
  for (let i = 1; i < n; i++) { num += ar1[i] * ar1[i - 1]; d1 += ar1[i] ** 2; d2 += ar1[i - 1] ** 2; }
  const rho1 = num / Math.sqrt(d1 * d2);
  const effN = (60 * (1 - rho1)) / (1 + rho1);
  console.log(`  measured lag-1 autocorrelation: ${rho1.toFixed(3)}`);
  console.log(`  effective independent samples in a 60-bar window: ${effN.toFixed(1)}`);
  console.log(`  -> a 95% CI on a correlation is roughly +/-${(1.96 / Math.sqrt(effN)).toFixed(2)}`);
  console.log('  4h crypto returns are strongly autocorrelated, so treat small');
  console.log('  RS gaps as noise rather than signal.');
}

console.log('');