/**
 * Pairwise Relative Strength Matrix.
 *
 * Purpose: answer "which coin is stronger than which, and therefore where
 * should money go / come out" — not "do these move together".
 *
 * Why returns, not prices
 * -----------------------
 * Correlation of *price levels* between crypto assets is almost always > 0.95
 * (they all go up over time), which carries no information. Everything here is
 * computed on log returns:
 *
 *   r_i[t] = ln(close_i[t] / close_i[t-1])
 *
 * and the strength of A over B is the change in their ratio:
 *
 *   rs(A, B) = sum(r_A) - sum(r_B)
 *
 * So rs(A, B) = +0.06 means "A out-earned B by 0.06 in log space over the
 * window" (~+6.2% compounded).
 *
 * Why the log difference and not exp()-1
 * -------------------------------------
 * Relative performance is *not* naturally anti-symmetric. exp(x)-1 and
 * exp(-x)-1 are different numbers: +6.18% versus -5.82% for the same
 * underlying move. If we report those as the two directions of one cell,
 * summing them into a dominance score biases the result. The log difference
 * is exactly antisymmetric, rs(B, A) = -rs(A, B), so one number per cell
 * describes both directions and `dominance` sums cleanly.
 *
 * Timestamp alignment
 * -------------------
 * Series are intersected on bar timestamps before anything is computed. Other
 * modules in this codebase slice to `min(len)` and assume index parity, which
 * silently corrupts ratios when series have different listing dates or
 * trading hours. We join on time instead.
 */

import { Candle } from '../types';

export interface CoinProfile {
  symbol: string;
  /** Stdev of log returns over the window, in percent. */
  vol: number;
  /** Total move over the window, in percent. */
  totalReturn: number;
  /**
   * Average strength of this coin against every other coin in the basket,
   * in percent. Positive = this coin beat the basket on average.
   */
  dominance: number;
  /** Rank by dominance, 0 = strongest. */
  dominanceRank: number;
  /** Average correlation with the rest of the basket. */
  avgCorr: number;
  /**
   * How stretched this coin is versus the equal-weight basket of the others,
   * in standard deviations of its own log-ratio history. High = the move is
   * already extended. Knowing a coin is strong is not the same as it being a
   * good entry — this is the guard against buying the top.
   */
  extensionZ: number;
  /** Beta against the equal-weight basket of the other coins. */
  basketBeta: number;
}

export interface CorrMatrix {
  symbols: string[];
  /** corr[i][j], symmetric. Diagonal is 1. */
  corr: number[][];
  /** beta[i][j] = beta of i against j. Not symmetric. */
  beta: number[][];
  /**
   * rs[i][j] = strength of i over j, percent of log-return. Exactly
   * antisymmetric: rs[j][i] = -rs[i][j].
   */
  rs: number[][];
  coins: CoinProfile[];
  /** Mean of all off-diagonal pairwise correlations. */
  basketCorr: number;
  window: number;
  bars: number;
  interval: string;
  generatedAt: number;
}

/**
 * Intersect series on bar timestamps so every asset shares an identical,
 * gap-free time axis. Returns the shared timestamps plus close prices.
 */
export function alignOnTime(
  series: Record<string, Candle[]>,
  symbols: string[],
  requiredBars: number,
): { times: number[]; closes: Record<string, number[]> } | null {
  const sets: Array<Set<number>> = [];
  for (const sym of symbols) {
    const candles = series[sym];
    if (!candles || candles.length === 0) return null;
    sets.push(new Set(candles.map((c) => c.time)));
  }

  // A bar only survives if EVERY asset has it. This is what prevents
  // "A traded, B didn't" gaps from being read as zero returns.
  const shared: number[] = [];
  for (const t of Array.from(sets[0])) {
    let inAll = true;
    for (let i = 1; i < sets.length; i++) {
      if (!sets[i].has(t)) { inAll = false; break; }
    }
    if (inAll) shared.push(t);
  }

  shared.sort((a, b) => a - b);
  if (shared.length < requiredBars + 1) return null;

  const times = shared.slice(-(requiredBars + 1));

  const closes: Record<string, number[]> = {};
  for (const sym of symbols) {
    const byTime = new Map(series[sym].map((c) => [c.time, c.close]));
    closes[sym] = times.map((t) => byTime.get(t) as number);
  }

  return { times, closes };
}

function logReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    if (!(prev > 0) || !(closes[i] > 0)) return [];
    out.push(Math.log(closes[i] / prev));
  }
  return out;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let acc = 0;
  for (const x of xs) acc += (x - m) * (x - m);
  return acc / xs.length;
}

function stdev(xs: number[]): number {
  return Math.sqrt(variance(xs));
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const ma = mean(a);
  const mb = mean(b);
  let cov = 0; let va = 0; let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va <= 0 || vb <= 0) return 0;
  return Math.max(-1, Math.min(1, cov / Math.sqrt(va * vb)));
}

function betaOf(asset: number[], market: number[]): number {
  const n = Math.min(asset.length, market.length);
  if (n < 3) return 0;
  const ma = mean(asset);
  const mm = mean(market);
  let cov = 0;
  let vm = 0;
  for (let i = 0; i < n; i++) {
    cov += (asset[i] - ma) * (market[i] - mm);
    vm += (market[i] - mm) * (market[i] - mm);
  }
  if (vm <= 0) return 0;
  return cov / vm;
}

function round2(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

/**
 * Compute the pairwise matrix plus per-coin strength profiles.
 *
 * `window` is the number of return bars measured, not candles fetched:
 * 30 bars of 4h is ~5 days; 30 bars of 1d is ~1 month.
 */
export function computeMatrix(
  series: Record<string, Candle[]>,
  symbols: string[],
  window: number,
  interval: string,
): CorrMatrix | null {
  if (symbols.length < 2) return null;

  const aligned = alignOnTime(series, symbols, window);
  if (!aligned) return null;

  const { closes } = aligned;
  const n = symbols.length;

  const returns: number[][] = [];
  for (const sym of symbols) {
    const r = logReturns(closes[sym]);
    if (r.length < window) return null;
    returns.push(r.slice(-window));
  }

  const corr: number[][] = [];
  const beta: number[][] = [];
  const rs: number[][] = [];

  for (let i = 0; i < n; i++) {
    corr.push(new Array(n).fill(0));
    beta.push(new Array(n).fill(0));
    rs.push(new Array(n).fill(0));
    corr[i][i] = 1;
    beta[i][i] = 1;
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const c = pearson(returns[i], returns[j]);
      corr[i][j] = c;
      corr[j][i] = c;

      beta[i][j] = betaOf(returns[i], returns[j]);
      beta[j][i] = betaOf(returns[j], returns[i]);

      // Strength of i over j, in log space. Exactly antisymmetric.
      const sumI = returns[i].reduce((s, x) => s + x, 0);
      const sumJ = returns[j].reduce((s, x) => s + x, 0);
      const val = (sumI - sumJ) * 100;
      rs[i][j] = round2(val);
      rs[j][i] = round2(-val);
    }
  }

  const coins: CoinProfile[] = [];
  for (let i = 0; i < n; i++) {
    const ret = returns[i];
    let domSum = 0;
    let corrSum = 0;
    let others = 0;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      domSum += rs[i][j];
      corrSum += corr[i][j];
      others++;
    }

    coins.push({
      symbol: symbols[i],
      vol: round2(stdev(ret) * 100),
      totalReturn: round2((Math.exp(ret.reduce((s, x) => s + x, 0)) - 1) * 100),
      dominance: round2(others > 0 ? domSum / others : 0),
      dominanceRank: 0,
      avgCorr: round2(others > 0 ? corrSum / others : 0),
      extensionZ: 0,
      basketBeta: 0,
    });
  }

  const byDom = [...coins].sort((a, b) => b.dominance - a.dominance);
  byDom.forEach((c, idx) => { c.dominanceRank = idx; });

  // Extension: how far this coin has run from the basket on its own history.
  // Built from log-ratio series, so a coin that rose with the basket scores
  // near 0 even if its absolute return was large.
  for (let i = 0; i < n; i++) {
    const otherIdx: number[] = [];
    for (let j = 0; j < n; j++) if (j !== i) otherIdx.push(j);
    if (otherIdx.length === 0) continue;

    const basketReturns: number[] = [];
    for (let k = 0; k < window; k++) {
      let s = 0;
      for (const j of otherIdx) s += returns[j][k];
      basketReturns.push(s / otherIdx.length);
    }

    const ratioSeries: number[] = [];
    let acc = 0;
    for (let k = 0; k < window; k++) {
      acc += returns[i][k] - basketReturns[k];
      ratioSeries.push(acc);
    }

    const last = ratioSeries[ratioSeries.length - 1];
    const sd = stdev(ratioSeries);
    coins[i].extensionZ = sd > 0 ? round2((last - mean(ratioSeries)) / sd) : 0;
    coins[i].basketBeta = round2(betaOf(returns[i], basketReturns));
  }

  let basketCorrSum = 0;
  let pairs = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) { basketCorrSum += corr[i][j]; pairs++; }
  }

  return {
    symbols: [...symbols],
    corr: corr.map((row) => row.map(round2)),
    beta: beta.map((row) => row.map(round2)),
    rs: rs.map((row) => row.map(round2)),
    coins,
    basketCorr: round2(pairs > 0 ? basketCorrSum / pairs : 0),
    window,
    bars: window,
    interval,
    generatedAt: Date.now(),
  };
}

export interface StrengthVerdict {
  label: 'LEAD' | 'STRONG' | 'NEUTRAL' | 'WEAK' | 'LAGGARD';
  tone: string;
  note: string;
}

/**
 * Turn a dominance score into an actionable read. Two-stage: dominance says
 * which coin is winning, extensionZ says whether that win is still buyable.
 *
 * A coin can be the strongest in the basket and still be a bad entry — this
 * is the distinction that stops you from buying the top of a rotation.
 */
export function classifyStrength(profile: CoinProfile): StrengthVerdict {
  const d = profile.dominance;
  const ext = profile.extensionZ;

  if (d >= 5) {
    if (ext >= 2) {
      return { label: 'STRONG', tone: '#f59e0b', note: 'Unggul, tapi sudah panjang — jangan kejar' };
    }
    return { label: 'LEAD', tone: '#10b981', note: 'Pemimpin basket, belum overextended' };
  }

  if (d >= 1.5) {
    return { label: 'STRONG', tone: '#34d399', note: 'Di atas basket' };
  }

  if (d > -1.5) {
    return { label: 'NEUTRAL', tone: '#9ca3af', note: 'Sejalan dengan basket' };
  }

  if (d > -5) {
    return { label: 'WEAK', tone: '#f87171', note: 'Di bawah basket' };
  }

  return { label: 'LAGGARD', tone: '#ef4444', note: 'Paling lemah — kandidat keluar' };
}