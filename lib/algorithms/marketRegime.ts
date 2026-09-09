import { Candle } from '../types';
import { sma, standardDeviation, atr, ema } from './indicators';

export type MarketRegime = 'strong_trend_up' | 'weak_trend_up' | 'ranging' | 'weak_trend_down' | 'strong_trend_down' | 'volatile';

export interface RegimeResult {
  regime: MarketRegime;
  confidence: number;
  volatility: number;
  volatilityPercentile: number;
  trendStrength: number;
  adxValue: number;
  atrPercent: number;
}

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

  const smoothTR = sma(tr, period);
  const smoothPlusDM = sma(plusDM, period);
  const smoothMinusDM = sma(minusDM, period);

  const plusDI: number[] = [];
  const minusDI: number[] = [];

  for (let i = 0; i < smoothTR.length; i++) {
    if (smoothTR[i] === 0 || isNaN(smoothTR[i])) {
      plusDI.push(0);
      minusDI.push(0);
    } else {
      plusDI.push((smoothPlusDM[i] / smoothTR[i]) * 100);
      minusDI.push((smoothMinusDM[i] / smoothTR[i]) * 100);
    }
  }

  const dx: number[] = [];
  for (let i = 0; i < plusDI.length; i++) {
    const sum = plusDI[i] + minusDI[i];
    if (sum === 0) {
      dx.push(0);
    } else {
      dx.push((Math.abs(plusDI[i] - minusDI[i]) / sum) * 100);
    }
  }

  return sma(dx, period);
}

function calculateVolatilityPercentile(atrValues: number[], currentATR: number): number {
  const validATR = atrValues.filter((v) => !isNaN(v));
  if (validATR.length === 0) return 50;
  const below = validATR.filter((v) => v <= currentATR).length;
  return Math.round((below / validATR.length) * 100);
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
  const lastADX = adxValues[adxValues.length - 1];

  const volatilityPercentile = calculateVolatilityPercentile(atrValues, lastATR);
  const atrPercent = (lastATR / lastClose) * 100;

  const priceVsSMA = (lastClose - lastSMA) / lastSMA;
  const smaVsEMA = (lastSMA - lastEMA) / lastEMA;

  const trendStrength = Math.abs(priceVsSMA) * 100;
  const adx = isNaN(lastADX) ? 0 : lastADX;

  let regime: MarketRegime;
  let confidence: number;

  if (adx > 25) {
    if (priceVsSMA > 0.01 && smaVsEMA > 0) {
      regime = adx > 40 ? 'strong_trend_up' : 'weak_trend_up';
      confidence = Math.min(adx / 50, 1) * 100;
    } else if (priceVsSMA < -0.01 && smaVsEMA < 0) {
      regime = adx > 40 ? 'strong_trend_down' : 'weak_trend_down';
      confidence = Math.min(adx / 50, 1) * 100;
    } else {
      regime = 'ranging';
      confidence = Math.max(0, (30 - adx) / 30) * 100;
    }
  } else if (volatilityPercentile > 80) {
    regime = 'volatile';
    confidence = Math.min((volatilityPercentile - 80) / 20, 1) * 100;
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
  };
}