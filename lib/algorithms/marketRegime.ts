import { Candle } from '../types';
import { sma, standardDeviation, atr, ema, wilderSmooth, clampRange } from './indicators';

export type MarketRegime = 'strong_trend_up' | 'weak_trend_up' | 'ranging' | 'weak_trend_down' | 'strong_trend_down' | 'volatile';

export interface RegimeResult {
  regime: MarketRegime;
  confidence: number;
  volatility: number;
  volatilityPercentile: number;
  trendStrength: number;
  adxValue: number;
  atrPercent: number;
  /** (SMA - EMA) / EMA, as a percent. Diagnostic only. */
  smaVsEma?: number;
}

/**
 * Wilder's ADX. DM/TR are smoothed with Wilder's RMA (alpha = 1/period), then
 * DX is RMA-smoothed again. Using SMA here produces a different indicator whose
 * level is not comparable to the canonical 20/25/40 thresholds, which made the
 * regime classifier systematically mislabel trends.
 */
function calculateADX(candles: Candle[], period: number = 14): number[] {
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const tr: number[] = [];

  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      plusDM.push(0);
      minusDM.push(0);
      tr.push(candles[i].high - candles[i].low);
      continue;
    }

    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;

    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);

    const prevClose = candles[i - 1].close;
    tr.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - prevClose),
      Math.abs(candles[i].low - prevClose)
    ));
  }

  const smoothTR = wilderSmooth(tr, period);
  const smoothPlusDM = wilderSmooth(plusDM, period);
  const smoothMinusDM = wilderSmooth(minusDM, period);

  // ADX needs `period` smoothed DI readings before its own average is defined,
  // so the DX series must not be smoothed until it has that many finite values.
  // Smoothing a series that starts with NaNs (and propagating them through the
  // recursion) previously pushed the whole ADX to NaN/0 or pinned it at 100.
  const dx: number[] = [];
  for (let i = 0; i < smoothTR.length; i++) {
    const t = smoothTR[i];
    const pdm = smoothPlusDM[i];
    const mdm = smoothMinusDM[i];
    if (isNaN(t) || t === 0 || isNaN(pdm) || isNaN(mdm)) {
      dx.push(NaN);
      continue;
    }
    const plusDI = (pdm / t) * 100;
    const minusDI = (mdm / t) * 100;
    const sum = plusDI + minusDI;
    dx.push(sum === 0 ? 0 : (Math.abs(plusDI - minusDI) / sum) * 100);
  }

  // Seed ADX with the mean of the first `period` finite DX values, then recurse.
  const out: number[] = new Array(dx.length).fill(NaN);
  let sum = 0;
  let count = 0;
  let prev = NaN;
  for (let i = 0; i < dx.length; i++) {
    const v = dx[i];
    if (!Number.isFinite(v)) continue;
    count++;
    if (count < period) continue;
    if (count === period) {
      sum += v;
      prev = sum / period;
    } else {
      prev = (prev * (period - 1) + v) / period;
    }
    out[i] = prev;
  }
  return out;
}

/**
 * Percentile of the current ATR within trailing history only (never the future).
 * Excludes the current bar so the value answers "how unusual is today's
 * volatility relative to what came before it".
 */
function calculateVolatilityPercentile(
  atrValues: number[],
  currentATR: number,
  lookback: number = 120
): number {
  const valid = atrValues.filter((v) => !isNaN(v) && Number.isFinite(v));
  if (valid.length === 0) return 50;
  const window = valid.slice(-lookback);
  if (window.length < 20) return 50;

  // A flat series has zero ATR dispersion, so every window value satisfies
  // `v <= currentATR` and the raw percentile pins to 100 — which then reads as
  // "extreme volatility". With no meaningful spread, report the midpoint.
  const sorted = [...window].sort((a, b) => a - b);
  const spread = sorted[sorted.length - 1] - sorted[0];
  const median = sorted[sorted.length >> 1];
  if (!Number.isFinite(median) || median <= 0 || spread / median < 0.05) {
    return 50;
  }

  const below = window.filter((v) => v <= currentATR).length;
  return Math.round((below / window.length) * 100);
}

export function detectMarketRegime(candles: Candle[], period: number = 20): RegimeResult {
  if (candles.length < period * 2) {
    return {
      regime: 'ranging',
      confidence: 0,
      volatility: 0,
      volatilityPercentile: 50,
      trendStrength: 0,
      adxValue: 0,
      atrPercent: 0,
      smaVsEma: 0,
    };
  }

  const closes = candles.map((c) => c.close);
  const smaValues = sma(closes, period);
  const emaValues = ema(closes, period);
  const atrValues = atr(candles, 14);
  const adxValues = calculateADX(candles, 14);

  const lastSMA = smaValues[smaValues.length - 1];
  const lastEMA = emaValues[emaValues.length - 1];
  const lastClose = closes[closes.length - 1];
  const lastATR = atrValues[atrValues.length - 1];
  const lastADXRaw = adxValues[adxValues.length - 1];

  const volatilityPercentile = calculateVolatilityPercentile(
    atrValues.slice(0, -1),
    lastATR
  );
  const atrPercent = Number.isFinite(lastATR) ? (lastATR / lastClose) * 100 : 0;

  const priceVsSMA = (lastSMA > 0 ? (lastClose - lastSMA) / lastSMA : 0);
  // Trend confirmation uses the EMA's own slope, not SMA-minus-EMA. In a
  // steady trend the EMA legitimately leads the SMA, so `smaVsEMA > 0` is
  // false for exactly the series that trends most cleanly — that mislabelled
  // clean trends as "ranging". Slope direction is the robust test.
  const emaBack = emaValues.length > 6 ? emaValues[emaValues.length - 6] : NaN;
  const emaSlopePct =
    Number.isFinite(emaBack) && emaBack > 0 ? (lastEMA - emaBack) / emaBack : 0;
  const smaVsEma = (lastEMA > 0 ? (lastSMA - lastEMA) / lastEMA : 0);

  // Trend strength should be volatility-normalised: a 2% move means something
  // very different on a coin with 1% ATR than on one with 10% ATR.
  const trendStrength = Number.isFinite(lastATR) && lastATR > 0
    ? Math.abs(priceVsSMA) * (lastClose / lastATR) * 100
    : Math.abs(priceVsSMA) * 100;
  const adx = isNaN(lastADXRaw) ? 0 : lastADXRaw;

  let regime: MarketRegime;
  let confidence: number;

  if (adx > 25) {
    const slopeConfirms = emaSlopePct > 0.0015 ? 1 : emaSlopePct < -0.0015 ? -1 : 0;
    const priceConfirms = priceVsSMA > 0.01 ? 1 : priceVsSMA < -0.01 ? -1 : 0;

    // Require price and EMA slope to point the same way. A disagreement between
    // them means the move is being absorbed, which is a range, not a trend.
    if (priceConfirms !== 0 && slopeConfirms === priceConfirms) {
      regime = adx > 40
        ? (priceConfirms > 0 ? 'strong_trend_up' : 'strong_trend_down')
        : (priceConfirms > 0 ? 'weak_trend_up' : 'weak_trend_down');
      // Confidence blends how extended ADX is with how cleanly the two agree.
      const agreeBonus = Math.min(Math.abs(priceVsSMA) / 0.05, 1);
      confidence = clampRange((adx - 25) / 25, 0, 1) * (0.6 + 0.4 * agreeBonus) * 100;
    } else {
      regime = 'ranging';
      confidence = Math.max(0, (30 - adx) / 30) * 100;
    }
  } else if (volatilityPercentile > 80) {
    regime = 'volatile';
    confidence = clampRange((volatilityPercentile - 80) / 20, 0, 1) * 100;
  } else {
    regime = 'ranging';
    confidence = Math.max(0, (30 - adx) / 30) * 100;
  }

  return {
    regime,
    confidence: Math.round(confidence),
    volatility: Math.round(lastATR * 100) / 100,
    volatilityPercentile,
    trendStrength: Math.round(trendStrength * 100) / 100,
    adxValue: Math.round(adx * 10) / 10,
    atrPercent: Math.round(atrPercent * 100) / 100,
    smaVsEma: Math.round(smaVsEma * 10000) / 100,
  };
}