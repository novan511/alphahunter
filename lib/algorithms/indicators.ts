import { Candle } from '../types';

export function sma(data: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(NaN);
    } else {
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += data[i - j];
      }
      result.push(sum / period);
    }
  }
  return result;
}

export function ema(data: number[], period: number): number[] {
  const result: number[] = [];
  const multiplier = 2 / (period + 1);

  for (let i = 0; i < data.length; i++) {
    if (i === 0) {
      result.push(data[0]);
    } else {
      result.push((data[i] - result[i - 1]) * multiplier + result[i - 1]);
    }
  }
  return result;
}

export function standardDeviation(data: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(NaN);
    } else {
      const slice = data.slice(i - period + 1, i + 1);
      const mean = slice.reduce((a, b) => a + b, 0) / period;
      const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
      result.push(Math.sqrt(variance));
    }
  }
  return result;
}

/**
 * Wilder's smoothing (RMA) — the smoothing used by ADX/ATR/RSI in Wilder's
 * original definition. Recursive with alpha = 1/period, so it has less lag than
 * an SMA of the same length. Required for thresholds like ADX>25 to mean
 * anything; an SMA-smoothed ADX is a different indicator with different
 * noise/lag characteristics and must not be compared to canonical levels.
 */
export function wilderSmooth(data: number[], period: number): number[] {
  const result: number[] = [];
  let sum = 0;
  let count = 0;
  for (let i = 0; i < data.length; i++) {
    const v = Number.isFinite(data[i]) ? data[i] : 0;
    if (!Number.isFinite(data[i])) {
      result.push(NaN);
      continue;
    }
    sum += v;
    count++;
    if (count < period) {
      result.push(NaN);
    } else if (count === period) {
      // Wilder seeds with a simple average of the first `period` observations.
      result.push(sum / period);
    } else {
      const prev = result[i - 1];
      result.push(isNaN(prev) ? sum / period : (prev * (period - 1) + v) / period);
    }
  }
  return result;
}

export function zScore(data: number[], period: number): number[] {
  const ma = sma(data, period);
  const std = standardDeviation(data, period);
  return data.map((val, i) => {
    if (isNaN(ma[i]) || isNaN(std[i]) || std[i] === 0) return 0;
    return (val - ma[i]) / std[i];
  });
}

export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function clampRange(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Two-sided normal CDF (Abramowitz & Stegun 7.1.26 on erf). Used to convert a
 * z-score into an actual tail probability so thresholds can be expressed in
 * p-values instead of arbitrary numbers.
 */
export function normalCdf(z: number): number {
  if (!Number.isFinite(z)) return 0.5;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

/** Two-sided p-value for a z-score. z=1.96 -> ~0.05, z=2.58 -> ~0.01. */
export function zScorePValue(z: number): number {
  return clampRange(2 * (1 - normalCdf(Math.abs(z))), 0, 1);
}

/**
 * Fraction of `sample` values at or below `value`, in [0,1].
 * Used to rank a coin against its peers instead of in isolation — a z=+2.0
 * asset is only interesting relative to how the rest of the universe is
 * distributed.
 */
export function percentileRank(value: number, sample: number[]): number {
  const valid = sample.filter((v) => Number.isFinite(v));
  if (valid.length === 0) return 0.5;
  let below = 0;
  for (const v of valid) if (v < value) below++;
  return below / valid.length;
}

/** O(n log n) median of a finite-only copy. */
export function median(values: number[]): number {
  const valid = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (valid.length === 0) return 0;
  const mid = valid.length >> 1;
  return valid.length % 2 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2;
}

export function atr(candles: Candle[], period: number): number[] {
  const result: number[] = [];
  const trueRanges: number[] = [];

  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      trueRanges.push(candles[i].high - candles[i].low);
    } else {
      const prevClose = candles[i - 1].close;
      const tr = Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - prevClose),
        Math.abs(candles[i].low - prevClose)
      );
      trueRanges.push(tr);
    }
  }

  for (let i = 0; i < trueRanges.length; i++) {
    if (i < period - 1) {
      result.push(NaN);
    } else if (i === period - 1) {
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += trueRanges[j];
      }
      result.push(sum / period);
    } else {
      result.push((result[i - 1] * (period - 1) + trueRanges[i]) / period);
    }
  }

  return result;
}

export function volumeMA(candles: Candle[], period: number): number[] {
  return sma(
    candles.map((c) => c.volume),
    period
  );
}

export function rollingReturn(closes: number[], period: number): number[] {
  return closes.map((close, i) => {
    if (i < period) return 0;
    return (close - closes[i - period]) / closes[i - period];
  });
}

export function returns(closes: number[]): number[] {
  const result: number[] = [0];
  for (let i = 1; i < closes.length; i++) {
    result.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  return result;
}

export function cumulativeReturn(returns: number[]): number[] {
  const result: number[] = [1];
  for (let i = 0; i < returns.length; i++) {
    result.push(result[result.length - 1] * (1 + returns[i]));
  }
  return result.slice(1);
}

export function maxDrawdown(cumReturns: number[]): { maxDD: number; maxDDIndex: number } {
  let peak = cumReturns[0];
  let maxDD = 0;
  let maxDDIndex = 0;

  for (let i = 0; i < cumReturns.length; i++) {
    if (cumReturns[i] > peak) {
      peak = cumReturns[i];
    }
    const dd = (peak - cumReturns[i]) / peak;
    if (dd > maxDD) {
      maxDD = dd;
      maxDDIndex = i;
    }
  }

  return { maxDD, maxDDIndex };
}

export function sharpeRatio(returns: number[], riskFreeRate: number = 0): number {
  if (returns.length === 0) return 0;
  const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
  const std = Math.sqrt(
    returns.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / returns.length
  );
  if (std === 0) return 0;
  return (avg - riskFreeRate) / std;
}

export function sortinoRatio(returns: number[], riskFreeRate: number = 0): number {
  if (returns.length === 0) return 0;
  const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
  const downsideReturns = returns.filter((r) => r < riskFreeRate);
  // No downside observations means the ratio is undefined (division by zero),
  // not "infinite". Returning a hardcoded 10 fabricates a metric — report the
  // average return instead so the caller sees an obviously non-comparable value.
  if (downsideReturns.length === 0) return avg;
  const downsideStd = Math.sqrt(
    downsideReturns.reduce((a, b) => a + Math.pow(b - riskFreeRate, 2), 0) /
      downsideReturns.length
  );
  if (downsideStd === 0) return 0;
  return (avg - riskFreeRate) / downsideStd;
}