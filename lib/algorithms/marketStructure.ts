import { Candle } from '../types';
import { atr, rsi } from './indicators';

/**
 * Market structure: swing pivots, support/resistance, structural trend, and the
 * patterns that can actually be defined from OHLC.
 *
 * Two rules here are load-bearing and must not be relaxed:
 *  1. Nothing is a fact unless its geometry is checkable. A pattern whose
 *     boundary has not been broken is always `confirmed: false`, so no caller
 *     can print it as if it happened.
 *  2. Nothing is guessed. If the window does not contain a pattern the result
 *     is an empty list — never a "possible" shape. A hallucinated pattern is
 *     worse than no pattern, because the AI will repeat it with confidence.
 *
 * Pattern geometry starts from the levels in
 * docs/superpowers/specs/2026-10-18-market-structure-patterns-design.md. They
 * are defensible starting points, not truths; `lib/quant` calibration (project
 * B) is what turns them into numbers that earned their thresholds.
 */

/** Bars either side of a fractal pivot. Small = noisy, large = late. */
export const PIVOT_N = 2;
/** Pivot clustering tolerance, as a fraction of ATR. */
export const LEVEL_TOLERANCE_ATR = 0.5;
/** Levels further than this (in ATR) are reported but flagged unusable. */
export const FAR_LEVEL_ATR = 6;
/** Minimum confidence for an *unconfirmed* pattern to be reported at all. */
export const FORMING_FLOOR = 0.6;
/** How far back divergences and trendlines may look. */
export const MAX_PATTERN_BARS = 60;
/** Below this many closed bars, structure is not readable and we say so. */
export const MIN_STRUCTURE_BARS = 40;

export interface Pivot {
  index: number;
  time: number;
  price: number;
  kind: 'high' | 'low';
}

export interface Level {
  price: number;
  kind: 'support' | 'resistance';
  touches: number;
  score: number;
  distanceAtr: number;
  /** Too far from price to be the level that matters right now. */
  far: boolean;
}

export type StructureTrend = 'uptrend' | 'downtrend' | 'range' | 'expanding' | 'contracting';
export type SlopeDirection = 'rising' | 'falling' | 'flat';

export interface TrendRead {
  label: StructureTrend;
  highs: SlopeDirection;
  lows: SlopeDirection;
  detail: string;
}

export type PatternName =
  | 'double_top'
  | 'double_bottom'
  | 'head_shoulders'
  | 'inverse_head_shoulders'
  | 'triangle'
  | 'falling_wedge'
  | 'rising_wedge'
  | 'bull_flag'
  | 'bear_flag'
  | 'bearish_divergence'
  | 'bullish_divergence';

export interface Pattern {
  name: PatternName;
  direction: 'long' | 'short';
  /** True only after a closed candle broke the boundary. */
  confirmed: boolean;
  /** Share of the geometric criteria met, 0..1. NOT a probability. */
  confidence: number;
  /** Boundary whose break is the entry. */
  trigger?: number;
  /** Level that cancels the setup. Never the same number as `trigger`. */
  stop?: number;
  pivots: Pivot[];
  detail: string;
}

export interface StructureAnalysis {
  /** Live price (last candle of the fetched series, which may still be forming). */
  price: number;
  atr: number;
  /** Number of closed bars the read is based on. */
  bars: number;
  pivots: Pivot[];
  support: Level | null;
  resistance: Level | null;
  levels: Level[];
  trend: TrendRead;
  patterns: Pattern[];
  /** Compact text for an LLM prompt. States absence explicitly. */
  summary: string;
}

export interface StructureOptions {
  /** Oscillator used for divergence. Defaults to RSI(14) on close. */
  oscillator?: number[];
  oscillatorName?: string;
}

/* ------------------------------------------------------------------ *
 * Price formatting — crypto prices span 8 orders of magnitude, and a
 * summary that prints 0.00000 is worse than useless in a prompt.
 * ------------------------------------------------------------------ */

export function fmtPrice(v: number): string {
  if (!Number.isFinite(v)) return 'n/a';
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(3);
  if (a >= 0.01) return v.toFixed(5);
  return v.toPrecision(4);
}

function score(criteria: boolean[]): number {
  if (criteria.length === 0) return 0;
  return Math.round((criteria.filter(Boolean).length / criteria.length) * 100) / 100;
}

/* ------------------------------------------------------------------ *
 * Geometry helpers
 * ------------------------------------------------------------------ */

/** Inclusive [from, to] extreme. Returns NaN for an empty range. */
function lowOf(candles: Candle[], from: number, to: number): number {
  let lo = Infinity;
  for (let i = Math.max(0, from); i <= Math.min(to, candles.length - 1); i++) {
    lo = Math.min(lo, candles[i].low);
  }
  return Number.isFinite(lo) ? lo : NaN;
}

function highOf(candles: Candle[], from: number, to: number): number {
  let hi = -Infinity;
  for (let i = Math.max(0, from); i <= Math.min(to, candles.length - 1); i++) {
    hi = Math.max(hi, candles[i].high);
  }
  return Number.isFinite(hi) ? hi : NaN;
}

/** Least-squares line through pivots. Null when there are too few to fit. */
function fitLine(pivots: Pivot[]): { m: number; b: number } | null {
  const n = pivots.length;
  if (n < 3) return null;
  let sx = 0;
  let sy = 0;
  for (const p of pivots) {
    sx += p.index;
    sy += p.price;
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let den = 0;
  for (const p of pivots) {
    num += (p.index - mx) * (p.price - my);
    den += (p.index - mx) ** 2;
  }
  if (!(den > 0)) return null;
  const m = num / den;
  return { m, b: my - m * mx };
}

function oscRange(osc: number[]): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of osc) {
    if (Number.isFinite(v)) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return 0;
  return hi - lo;
}

/* ------------------------------------------------------------------ *
 * Pivots, levels, trend
 * ------------------------------------------------------------------ */

export function findPivots(candles: Candle[], n: number = PIVOT_N): Pivot[] {
  const out: Pivot[] = [];
  for (let i = n; i < candles.length - n; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - n; j <= i + n; j++) {
      if (j === i) continue;
      if (candles[j].high >= c.high) isHigh = false;
      if (candles[j].low <= c.low) isLow = false;
    }
    // Strict on the left side so a flat run never yields two pivots of the
    // same kind; without this, a plateau produces a wall of duplicate levels.
    if (isHigh && candles[i - 1].high < c.high) {
      out.push({ index: i, time: c.time, price: c.high, kind: 'high' });
    } else if (isLow && candles[i - 1].low > c.low) {
      out.push({ index: i, time: c.time, price: c.low, kind: 'low' });
    }
  }
  return out;
}

export function buildLevels(
  pivots: Pivot[],
  price: number,
  atrValue: number,
  bars: number
): Level[] {
  if (pivots.length === 0 || !(atrValue > 0)) return [];
  const tol = LEVEL_TOLERANCE_ATR * atrValue;
  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const clusters: Pivot[][] = [];
  for (const p of sorted) {
    const cur = clusters[clusters.length - 1];
    const last = cur ? cur[cur.length - 1] : null;
    if (cur && last && p.price - last.price <= tol) cur.push(p);
    else clusters.push([p]);
  }
  return clusters
    .map((cl) => {
      const level = cl.reduce((s, p) => s + p.price, 0) / cl.length;
      const lastIdx = cl.reduce((m, p) => Math.max(m, p.index), 0);
      // A level nobody has revisited in months is context, not a price to trade.
      const recency = 1 / (1 + Math.max(0, bars - 1 - lastIdx) / 20);
      const distanceAtr = Math.abs(level - price) / atrValue;
      return {
        price: level,
        kind: (level < price ? 'support' : 'resistance') as Level['kind'],
        touches: cl.length,
        score: Math.round(cl.length * recency * 100) / 100,
        distanceAtr: Math.round(distanceAtr * 100) / 100,
        far: distanceAtr > FAR_LEVEL_ATR,
      };
    })
    .sort((a, b) => b.score - a.score);
}

function nearestLevel(levels: Level[], price: number, kind: Level['kind']): Level | null {
  const candidates = levels.filter((l) => l.kind === kind && !l.far);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, l) => (l.distanceAtr < best.distanceAtr ? l : best));
}

function slopeDirection(values: number[], tol: number): SlopeDirection {
  if (values.length < 2) return 'flat';
  const d = values[values.length - 1] - values[0];
  if (d > tol) return 'rising';
  if (d < -tol) return 'falling';
  return 'flat';
}

export function readStructureTrend(pivots: Pivot[], atrValue: number): TrendRead {
  const highs = pivots
    .filter((p) => p.kind === 'high')
    .slice(-3)
    .map((p) => p.price);
  const lows = pivots
    .filter((p) => p.kind === 'low')
    .slice(-3)
    .map((p) => p.price);
  const tol = 0.35 * atrValue;
  const h = slopeDirection(highs, tol);
  const l = slopeDirection(lows, tol);
  let label: StructureTrend;
  if (h === 'rising' && l === 'rising') label = 'uptrend';
  else if (h === 'falling' && l === 'falling') label = 'downtrend';
  else if (h === 'rising' && l === 'falling') label = 'expanding';
  else if (h === 'falling' && l === 'rising') label = 'contracting';
  else label = 'range';
  return {
    label,
    highs: h,
    lows: l,
    detail: `highs ${h} (${highs.length}), lows ${l} (${lows.length})`,
  };
}

/* ------------------------------------------------------------------ *
 * Patterns. One detector per definition, each returning at most one
 * pattern — the most recent one that qualifies.
 * ------------------------------------------------------------------ */

function doubleTop(
  candles: Candle[],
  highs: Pivot[],
  atrValue: number,
  lastClose: number
): Pattern | null {
  for (let i = highs.length - 1; i >= 1; i--) {
    const p1 = highs[i - 1];
    const p2 = highs[i];
    const gap = p2.index - p1.index;
    if (gap < 5 || gap > 40) continue;
    const diff = Math.abs(p1.price - p2.price);
    // Two peaks that are not comparable in price are two events, not a pattern.
    if (diff > 0.6 * atrValue) continue;
    const trough = lowOf(candles, p1.index + 1, p2.index - 1);
    if (!Number.isFinite(trough)) continue;
    const height = Math.min(p1.price, p2.price) - trough;
    const deep = height >= 0.8 * atrValue;
    const tall = height >= 1.5 * atrValue;
    const tight = diff <= 0.3 * atrValue;
    const confirmed = lastClose < trough;
    const confidence = score([deep, tall, tight]);
    if (!confirmed && confidence < FORMING_FLOOR) return null;
    return {
      name: 'double_top',
      direction: 'short',
      confirmed,
      confidence,
      trigger: trough,
      stop: Math.max(p1.price, p2.price) + 0.25 * atrValue,
      pivots: [p1, p2],
      detail: `dua puncak ${fmtPrice(p1.price)}/${fmtPrice(p2.price)}, lembah ${fmtPrice(trough)}`,
    };
  }
  return null;
}

function doubleBottom(
  candles: Candle[],
  lows: Pivot[],
  atrValue: number,
  lastClose: number
): Pattern | null {
  for (let i = lows.length - 1; i >= 1; i--) {
    const p1 = lows[i - 1];
    const p2 = lows[i];
    const gap = p2.index - p1.index;
    if (gap < 5 || gap > 40) continue;
    const diff = Math.abs(p1.price - p2.price);
    if (diff > 0.6 * atrValue) continue;
    const peak = highOf(candles, p1.index + 1, p2.index - 1);
    if (!Number.isFinite(peak)) continue;
    const height = peak - Math.max(p1.price, p2.price);
    const deep = height >= 0.8 * atrValue;
    const tall = height >= 1.5 * atrValue;
    const tight = diff <= 0.3 * atrValue;
    const confirmed = lastClose > peak;
    const confidence = score([deep, tall, tight]);
    if (!confirmed && confidence < FORMING_FLOOR) return null;
    return {
      name: 'double_bottom',
      direction: 'long',
      confirmed,
      confidence,
      trigger: peak,
      stop: Math.min(p1.price, p2.price) - 0.25 * atrValue,
      pivots: [p1, p2],
      detail: `dua dasar ${fmtPrice(p1.price)}/${fmtPrice(p2.price)}, leher ${fmtPrice(peak)}`,
    };
  }
  return null;
}

function headShoulders(
  candles: Candle[],
  highs: Pivot[],
  atrValue: number,
  lastClose: number
): Pattern | null {
  for (let i = highs.length - 1; i >= 2; i--) {
    const h1 = highs[i - 2];
    const h2 = highs[i - 1];
    const h3 = highs[i];
    if (h2.index - h1.index < 3 || h3.index - h2.index < 3) continue;
    if (h3.index - h1.index > MAX_PATTERN_BARS) continue;
    const headOver = h2.price - Math.max(h1.price, h3.price);
    const headHigher = headOver >= 0.5 * atrValue;
    const shoulderDiff = Math.abs(h1.price - h3.price);
    const shouldersEqual = shoulderDiff <= 0.8 * atrValue;
    if (!headHigher || !shouldersEqual) continue;
    const t1 = lowOf(candles, h1.index + 1, h2.index - 1);
    const t2 = lowOf(candles, h2.index + 1, h3.index - 1);
    if (!Number.isFinite(t1) || !Number.isFinite(t2)) continue;
    const neckline = Math.min(t1, t2);
    const confirmed = lastClose < neckline;
    const confidence = score([
      shoulderDiff <= 0.4 * atrValue,
      headOver >= 1.0 * atrValue,
      t2 < t1, // classic shape has the neckline sloping down
    ]);
    if (!confirmed && confidence < FORMING_FLOOR) return null;
    return {
      name: 'head_shoulders',
      direction: 'short',
      confirmed,
      confidence,
      trigger: neckline,
      stop: h3.price + 0.25 * atrValue,
      pivots: [h1, h2, h3],
      detail: `kepala ${fmtPrice(h2.price)}, bahu ${fmtPrice(h1.price)}/${fmtPrice(h3.price)}, neckline ${fmtPrice(neckline)}`,
    };
  }
  return null;
}

function inverseHeadShoulders(
  candles: Candle[],
  lows: Pivot[],
  atrValue: number,
  lastClose: number
): Pattern | null {
  for (let i = lows.length - 1; i >= 2; i--) {
    const h1 = lows[i - 2];
    const h2 = lows[i - 1];
    const h3 = lows[i];
    if (h2.index - h1.index < 3 || h3.index - h2.index < 3) continue;
    if (h3.index - h1.index > MAX_PATTERN_BARS) continue;
    const headDrop = Math.min(h1.price, h3.price) - h2.price;
    const headLower = headDrop >= 0.5 * atrValue;
    const shoulderDiff = Math.abs(h1.price - h3.price);
    const shouldersEqual = shoulderDiff <= 0.8 * atrValue;
    if (!headLower || !shouldersEqual) continue;
    const p1 = highOf(candles, h1.index + 1, h2.index - 1);
    const p2 = highOf(candles, h2.index + 1, h3.index - 1);
    if (!Number.isFinite(p1) || !Number.isFinite(p2)) continue;
    const neckline = Math.max(p1, p2);
    const confirmed = lastClose > neckline;
    const confidence = score([
      shoulderDiff <= 0.4 * atrValue,
      headDrop >= 1.0 * atrValue,
      p2 > p1, // neckline sloping up
    ]);
    if (!confirmed && confidence < FORMING_FLOOR) return null;
    return {
      name: 'inverse_head_shoulders',
      direction: 'long',
      confirmed,
      confidence,
      trigger: neckline,
      stop: h3.price - 0.25 * atrValue,
      pivots: [h1, h2, h3],
      detail: `kepala ${fmtPrice(h2.price)}, bahu ${fmtPrice(h1.price)}/${fmtPrice(h3.price)}, neckline ${fmtPrice(neckline)}`,
    };
  }
  return null;
}

/**
 * Triangle and wedge. A triangle has no direction until it breaks, so an
 * unbroken triangle is deliberately NOT reported — its direction would be a
 * guess. Wedges carry their own bias and may be reported while forming.
 */
function trendlinePattern(
  candles: Candle[],
  pivots: Pivot[],
  atrValue: number,
  lastClose: number
): Pattern | null {
  const lastIdx = candles.length - 1;
  const from = Math.max(0, lastIdx - MAX_PATTERN_BARS);
  const highs = pivots.filter((p) => p.kind === 'high' && p.index >= from).slice(-4);
  const lows = pivots.filter((p) => p.kind === 'low' && p.index >= from).slice(-4);
  if (highs.length < 3 || lows.length < 3) return null;
  const uh = fitLine(highs);
  const ul = fitLine(lows);
  if (!uh || !ul) return null;
  const widthStart = uh.m * highs[0].index + uh.b - (ul.m * lows[0].index + ul.b);
  const widthEnd = uh.m * lastIdx + uh.b - (ul.m * lastIdx + ul.b);
  if (!(widthStart > 0) || !(widthEnd > 0)) return null;
  const shrink = 1 - widthEnd / widthStart;
  const converging = shrink >= 0.4;
  const slopeTol = 0.05 * atrValue;
  const steep = Math.abs(uh.m) >= 0.1 * atrValue && Math.abs(ul.m) >= 0.1 * atrValue;
  const upperNow = uh.m * lastIdx + uh.b;
  const lowerNow = ul.m * lastIdx + ul.b;

  if (uh.m < -slopeTol && ul.m > slopeTol) {
    if (!converging) return null;
    const brokeUp = lastClose > upperNow;
    const brokeDown = lastClose < lowerNow;
    if (!brokeUp && !brokeDown) return null; // undecided direction = not reported
    return {
      name: 'triangle',
      direction: brokeUp ? 'long' : 'short',
      confirmed: true,
      confidence: score([converging, steep, highs.length >= 3 && lows.length >= 3]),
      trigger: brokeUp ? upperNow : lowerNow,
      stop: brokeUp ? lowerNow - 0.25 * atrValue : upperNow + 0.25 * atrValue,
      pivots: [...highs, ...lows],
      detail: `segitiga menyempit ${Math.round(shrink * 100)}%, tembus ${brokeUp ? 'atas' : 'bawah'}`,
    };
  }

  const falling = uh.m < -slopeTol && ul.m < -slopeTol;
  const rising = uh.m > slopeTol && ul.m > slopeTol;
  if (!falling && !rising) return null;
  if (!converging) return null;
  const direction: Pattern['direction'] = falling ? 'long' : 'short';
  const trigger = falling ? upperNow : lowerNow;
  const stop = falling ? lowerNow - 0.25 * atrValue : upperNow + 0.25 * atrValue;
  const confirmed = falling ? lastClose > trigger : lastClose < trigger;
  const confidence = score([converging, steep, shrink >= 0.55]);
  if (!confirmed && confidence < FORMING_FLOOR) return null;
  return {
    name: falling ? 'falling_wedge' : 'rising_wedge',
    direction,
    confirmed,
    confidence,
    trigger,
    stop,
    pivots: [...highs, ...lows],
    detail: `${falling ? 'falling' : 'rising'} wedge menyempit ${Math.round(shrink * 100)}%`,
  };
}

/** Impulse then a shallow pause. The pause is the trade; the impulse is context. */
function flagPattern(candles: Candle[], atrValue: number, lastClose: number): Pattern | null {
  const last = candles.length - 1;
  const lookFrom = Math.max(0, last - 25);
  let best: { i0: number; i1: number; move: number } | null = null;
  for (let i0 = lookFrom; i0 <= last - 4; i0++) {
    for (let len = 4; len <= 10; len++) {
      const i1 = i0 + len;
      if (i1 > last) break;
      const move = candles[i1].close - candles[i0].close;
      if (!best || Math.abs(move) > Math.abs(best.move)) best = { i0, i1, move };
    }
  }
  if (!best) return null;
  const impulse = Math.abs(best.move);
  const strong = impulse >= 3 * atrValue;
  const barsAfter = last - best.i1;
  const pauseOk = barsAfter >= 3 && barsAfter <= 15;
  if (!strong || !pauseOk) return null;
  const up = best.move > 0;
  const edge = up
    ? lowOf(candles, best.i1 + 1, last)
    : highOf(candles, best.i1 + 1, last);
  if (!Number.isFinite(edge)) return null;
  const base = candles[best.i1].close;
  const retrace = (up ? base - edge : edge - base) / impulse;
  const shallow = retrace <= 0.5;
  if (!shallow) return null;
  const trigger = up
    ? highOf(candles, best.i0, best.i1)
    : lowOf(candles, best.i0, best.i1);
  if (!Number.isFinite(trigger)) return null;
  const stop = up ? edge - 0.25 * atrValue : edge + 0.25 * atrValue;
  const confirmed = up ? lastClose > trigger : lastClose < trigger;
  const confidence = score([retrace <= 0.35, impulse >= 4 * atrValue, barsAfter >= 3 && barsAfter <= 10]);
  if (!confirmed && confidence < FORMING_FLOOR) return null;
  return {
    name: up ? 'bull_flag' : 'bear_flag',
    direction: up ? 'long' : 'short',
    confirmed,
    confidence,
    trigger,
    stop,
    pivots: [],
    detail: `impuls ${fmtPrice(impulse)} (${Math.round((impulse / atrValue) * 10) / 10} ATR), retrace ${Math.round(retrace * 100)}% dalam ${barsAfter} bar`,
  };
}

/**
 * Regular divergence only (price extreme up, oscillator extreme down). Hidden
 * divergence is deliberately out of scope for now. `osc` is injected so a
 * caller that has the relative-strength series can pass it instead of RSI.
 */
function divergence(
  candles: Candle[],
  pivots: Pivot[],
  atrValue: number,
  osc: number[],
  oscName: string,
  side: 'high' | 'low',
  lastClose: number
): Pattern | null {
  const points = pivots.filter((p) => p.kind === side);
  if (points.length < 2) return null;
  const range = oscRange(osc);
  if (!(range > 0)) return null;
  for (let i = points.length - 1; i >= 1; i--) {
    const p1 = points[i - 1];
    const p2 = points[i];
    const gap = p2.index - p1.index;
    if (gap < 5 || gap > MAX_PATTERN_BARS) continue;
    const o1 = osc[p1.index];
    const o2 = osc[p2.index];
    if (!Number.isFinite(o1) || !Number.isFinite(o2)) continue;

    if (side === 'high') {
      const priceHigher = p2.price - p1.price;
      const oscLower = o1 - o2;
      if (!(priceHigher > 0)) continue;
      if (oscLower < 0.2 * range) continue;
      const trigger = lowOf(candles, p1.index + 1, p2.index - 1);
      if (!Number.isFinite(trigger)) continue;
      const confirmed = lastClose < trigger;
      const confidence = score([priceHigher >= 0.5 * atrValue, oscLower >= 0.35 * range, gap >= 8]);
      if (!confirmed && confidence < FORMING_FLOOR) return null;
      return {
        name: 'bearish_divergence',
        direction: 'short',
        confirmed,
        confidence,
        trigger,
        stop: p2.price + 0.25 * atrValue,
        pivots: [p1, p2],
        detail: `harga high lebih tinggi tapi ${oscName} lebih rendah`,
      };
    }

    const priceLower = p1.price - p2.price;
    const oscHigher = o2 - o1;
    if (!(priceLower > 0)) continue;
    if (oscHigher < 0.2 * range) continue;
    const trigger = highOf(candles, p1.index + 1, p2.index - 1);
    if (!Number.isFinite(trigger)) continue;
    const confirmed = lastClose > trigger;
    const confidence = score([priceLower >= 0.5 * atrValue, oscHigher >= 0.35 * range, gap >= 8]);
    if (!confirmed && confidence < FORMING_FLOOR) return null;
    return {
      name: 'bullish_divergence',
      direction: 'long',
      confirmed,
      confidence,
      trigger,
      stop: p2.price - 0.25 * atrValue,
      pivots: [p1, p2],
      detail: `harga low lebih rendah tapi ${oscName} lebih tinggi`,
    };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * Read structure from a fetched candle series. The last candle is dropped
 * because it may still be forming — pivots and closes must come from bars that
 * actually finished, otherwise the same call returns different answers seconds
 * apart. Returns null when there is not enough history to say anything.
 */
export function analyzeStructure(
  candles: Candle[],
  opts: StructureOptions = {}
): StructureAnalysis | null {
  const closed = candles.slice(0, -1);
  const bars = closed.length;
  if (bars < MIN_STRUCTURE_BARS) return null;

  const atrSeries = atr(closed, 14);
  const atrValue = atrSeries[bars - 1];
  if (!Number.isFinite(atrValue) || atrValue <= 0) return null;

  const pivots = findPivots(closed);
  if (pivots.length < 4) return null;

  const price = candles[candles.length - 1].close;
  const lastClose = closed[bars - 1].close;
  const levels = buildLevels(pivots, price, atrValue, bars);
  const trend = readStructureTrend(pivots, atrValue);

  const oscillator = opts.oscillator ?? rsi(closed.map((c) => c.close), 14);
  const oscillatorName = opts.oscillatorName ?? 'RSI(14)';
  const highs = pivots.filter((p) => p.kind === 'high');
  const lows = pivots.filter((p) => p.kind === 'low');

  const patterns: Pattern[] = [];
  const found = [
    doubleTop(closed, highs, atrValue, lastClose),
    doubleBottom(closed, lows, atrValue, lastClose),
    headShoulders(closed, highs, atrValue, lastClose),
    inverseHeadShoulders(closed, lows, atrValue, lastClose),
    trendlinePattern(closed, pivots, atrValue, lastClose),
    flagPattern(closed, atrValue, lastClose),
    divergence(closed, highs, atrValue, oscillator, oscillatorName, 'high', lastClose),
    divergence(closed, lows, atrValue, oscillator, oscillatorName, 'low', lastClose),
  ];
  for (const p of found) if (p) patterns.push(p);

  return {
    price,
    atr: atrValue,
    bars,
    pivots,
    support: nearestLevel(levels, price, 'support'),
    resistance: nearestLevel(levels, price, 'resistance'),
    levels,
    trend,
    patterns,
    summary: buildSummary({
      price,
      atr: atrValue,
      bars,
      support: nearestLevel(levels, price, 'support'),
      resistance: nearestLevel(levels, price, 'resistance'),
      trend,
      patterns,
    }),
  };
}

/**
 * Compact multi-line summary for an LLM prompt. Absence is stated in words on
 * purpose: a model that sees an empty section invents one, a model that reads
 * "tidak ada pola" does not.
 */
export function buildSummary(a: {
  price: number;
  atr: number;
  bars: number;
  support: Level | null;
  resistance: Level | null;
  trend: TrendRead;
  patterns: Pattern[];
}): string {
  const lv = (l: Level | null) =>
    l ? `${fmtPrice(l.price)} (${l.distanceAtr} ATR, ${l.touches}x sentuh)` : 'tidak ada level dekat';
  const lines = [
    `Harga ${fmtPrice(a.price)} | ATR ${fmtPrice(a.atr)} | ${a.bars} bar tutup`,
    `Support terdekat: ${lv(a.support)} | Resistance terdekat: ${lv(a.resistance)}`,
    `Struktur pivot: ${a.trend.label} (${a.trend.detail})`,
  ];
  if (a.patterns.length === 0) {
    lines.push('Pola terdefinisi: TIDAK ADA pada jendela data ini — jangan mengarang pola');
  } else {
    for (const p of a.patterns) {
      const state = p.confirmed ? 'terkonfirmasi' : 'BELUM terkonfirmasi';
      const levels = [
        p.trigger != null ? `trigger ${fmtPrice(p.trigger)}` : null,
        p.stop != null ? `stop ${fmtPrice(p.stop)}` : null,
      ]
        .filter(Boolean)
        .join(', ');
      lines.push(
        `Pola: ${p.name} ${state} (conf ${p.confidence}${levels ? `, ${levels}` : ''}) — ${p.detail}`
      );
    }
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * Self-check. There is no test runner in this repo, so the assertions that
 * keep the geometry honest live here and are reachable from
 * GET /api/structure-check. Replace with a real runner when one exists.
 * ------------------------------------------------------------------ */

export interface SelfCheckResult {
  ok: boolean;
  checks: { name: string; pass: boolean; detail: string }[];
}

function bar(index: number, prevPoint: number, point: number): Candle {
  return {
    time: 1_700_000_000_000 + index * 3_600_000,
    open: prevPoint,
    high: point + 0.2,
    low: point - 0.2,
    close: point,
    volume: 1000,
  };
}

function series(points: number[]): Candle[] {
  return points.map((p, i) => bar(i, i === 0 ? p : points[i - 1], p));
}

function ramp(from: number, to: number, steps: number): number[] {
  const out: number[] = [];
  for (let i = 1; i <= steps; i++) out.push(from + ((to - from) * i) / steps);
  return out;
}

/** 10 flat + dip + rally to a double top + collapse through the neckline. */
function doubleTopSeries(): Candle[] {
  const pts: number[] = new Array(10).fill(100);
  pts.push(...ramp(100, 96, 3));
  pts.push(...ramp(96, 100, 3));
  pts.push(...ramp(100, 120, 6));
  pts.push(...ramp(120, 108, 5));
  pts.push(...ramp(108, 120, 6));
  pts.push(...ramp(120, 95, 8));
  return series(pts);
}

/** Higher highs and higher lows on every leg: structure, but no reversal shape. */
function uptrendSeries(): Candle[] {
  const pts: number[] = new Array(6).fill(96);
  pts.push(...ramp(96, 110, 6));
  pts.push(...ramp(110, 105, 3));
  pts.push(...ramp(105, 125, 6));
  pts.push(...ramp(125, 120, 3));
  pts.push(...ramp(120, 140, 8));
  pts.push(...ramp(140, 136, 3));
  pts.push(...ramp(136, 150, 6));
  return series(pts);
}

export function selfCheckMarketStructure(): SelfCheckResult {
  const checks: { name: string; pass: boolean; detail: string }[] = [];
  const add = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });

  // Pivot detection on a hand-checkable series: peaks at 3 and 7, trough at 5.
  const tiny = series([1, 2, 3, 2, 1, 2, 3, 2, 1]);
  const tinyPivots = findPivots(tiny);
  add(
    'findPivots: 3 pivot pada deret buatan',
    tinyPivots.length === 3 &&
      tinyPivots[0].kind === 'high' &&
      tinyPivots[1].kind === 'low' &&
      tinyPivots[2].kind === 'high',
    `dapat ${tinyPivots.length} pivot: ${tinyPivots.map((p) => p.kind).join(',')}`
  );

  // RSI sanity: monotone rise pins it high, flat pins it at 50.
  const rise = rsi(new Array(60).fill(0).map((_, i) => 100 + i), 14);
  add('rsi: deret naik > 90', rise[rise.length - 1] > 90, `rsi=${rise[rise.length - 1]?.toFixed(1)}`);
  const flat = rsi(new Array(60).fill(100), 14);
  add('rsi: deret datar = 50', Math.abs(flat[flat.length - 1] - 50) < 0.01, `rsi=${flat[flat.length - 1]}`);

  // Too little history must be refused, not guessed.
  add(
    'analyzeStructure: menolak < 40 bar',
    analyzeStructure(series(new Array(30).fill(100))) === null,
    'hasil null'
  );

  // The real test: a constructed double top must be found and confirmed.
  const dt = analyzeStructure(doubleTopSeries());
  const dtp = dt?.patterns.find((p) => p.name === 'double_top') ?? null;
  add(
    'double_top: terdeteksi & terkonfirmasi',
    !!dtp && dtp.confirmed && dtp.confidence === 1,
    dtp ? `confirmed=${dtp.confirmed} conf=${dtp.confidence}` : 'tidak terdeteksi'
  );
  add(
    'double_top: trigger != stop, trigger di lembah',
    !!dtp && !!dtp.trigger && !!dtp.stop && Math.abs(dtp.trigger - 107.8) < 0.6 && dtp.stop > dtp.trigger,
    dtp ? `trigger=${dtp.trigger?.toFixed(2)} stop=${dtp.stop?.toFixed(2)}` : 'n/a'
  );
  // After the collapse price sits below every pivot, so resistance must exist
  // and support legitimately may not. A support ABOVE price would be the bug.
  add(
    'double_top: level di sisi harga yang benar',
    !!dt &&
      dt.levels.length >= 3 &&
      !!dt.resistance &&
      dt.resistance.price > dt.price &&
      (dt.support === null || dt.support.price < dt.price),
    dt
      ? `levels=${dt.levels.length} res=${dt.resistance?.price.toFixed(1) ?? 'null'} sup=${dt.support?.price.toFixed(1) ?? 'null'} px=${dt.price.toFixed(1)}`
      : 'n/a'
  );

  // False positives: a clean staircase up is an uptrend, not a reversal.
  const up = analyzeStructure(uptrendSeries());
  add(
    'uptrend: struktur terbaca uptrend',
    up?.trend.label === 'uptrend',
    up ? `${up.trend.label} (${up.trend.detail})` : 'null'
  );
  const reversals = ['double_top', 'double_bottom', 'head_shoulders', 'inverse_head_shoulders'];
  const bad = up ? up.patterns.filter((p) => reversals.includes(p.name)) : [];
  add(
    'uptrend: tidak ada pola reversal palsu',
    bad.length === 0,
    bad.length === 0 ? 'bersih' : `muncul: ${bad.map((p) => p.name).join(',')}`
  );

  // Divergence must go quiet when the oscillator is unusable rather than fire.
  const nan = new Array(doubleTopSeries().length - 1).fill(NaN);
  const noise = analyzeStructure(doubleTopSeries(), { oscillator: nan, oscillatorName: 'test' });
  const divs = noise ? noise.patterns.filter((p) => p.name.includes('divergence')) : [];
  add(
    'divergence: tidak menyala tanpa oscillator',
    divs.length === 0,
    divs.length === 0 ? 'bersih' : `muncul ${divs.length}`
  );

  return { ok: checks.every((c) => c.pass), checks };
}
