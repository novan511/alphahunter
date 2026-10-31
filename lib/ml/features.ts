import { Candle } from '../types';
import { sma, standardDeviation, atr, rollingReturn } from '../algorithms/indicators';

export interface FeatureVector {
  time: number;
  close: number;
  features: number[];
}

/**
 * Build the exact same feature vector used by the Python training script.
 * Column order must match ml/train/train_model.py feature_cols:
 *   0: rs_zscore
 *   1: rs_momentum
 *   2: asset_return_6
 *   3: volume_ratio
 *   4: atr_pct
 *   5: btc_regime_20
 *   6: btc_regime_60
 *   7: btc_bull_filter
 *   8: mom_5
 *   9: mom_20
 *   10: mom_60
 *   11: close_over_sma20
 *   12: rs_over_rs_ma
 *   13: atr_regime
 */
export function buildFeatures(
  assetCandles: Candle[],
  indexCandles: Candle[],
): FeatureVector[] {
  const n = Math.min(assetCandles.length, indexCandles.length);
  const asset = assetCandles.slice(-n);
  const index_ = indexCandles.slice(-n);

  const closes = asset.map((c) => c.close);
  const volumes = asset.map((c) => c.volume);
  const indexCloses = index_.map((c) => c.close);

  // ---- RS line: asset / index ----
  const rsLine = closes.map((c, i) => (indexCloses[i] !== 0 ? c / indexCloses[i] : 1));

  // ---- RS MA (20) and std (20) ----
  const rsMA = sma(rsLine, 20);
  const rsStd = standardDeviation(rsLine, 20);

  // ---- RS Z-score ----
  const rsZScore = rsLine.map((rs, i) => {
    if (Number.isNaN(rsMA[i]) || Number.isNaN(rsStd[i]) || rsStd[i] === 0) return 0;
    return (rs - rsMA[i]) / rsStd[i];
  });

  // ---- RS momentum ----
  const rsMomentum = [0];
  for (let i = 1; i < n; i++) rsMomentum.push(rsLine[i] - rsLine[i - 1]);

  // ---- Asset return lookback 6 ----
  const lookback = 6;
  const assetReturn6: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i < lookback) assetReturn6.push(0);
    else assetReturn6.push((closes[i] - closes[i - lookback]) / closes[i - lookback]);
  }

  // ---- Volume ratio vs prior-window MA (exclude current bar) ----
  const volPeriod = 20;
  const volumeRatio: number[] = [];
  for (let i = 0; i < n; i++) {
    const priorMA = i >= volPeriod ? sum(volumes.slice(i - volPeriod, i)) / volPeriod : NaN;
    if (Number.isNaN(priorMA) || priorMA === 0) volumeRatio.push(1);
    else volumeRatio.push(volumes[i] / priorMA);
  }

  // ---- ATR% ----
  const atrSeries = atr(asset, 14);
  const atrPct = atrSeries.map((a, i) => {
    if (Number.isNaN(a) || closes[i] <= 0) return 0;
    return (a / closes[i]) * 100;
  });

  // ---- BTC regime: 20-bar return of index ----
  const btcRegime20: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i < 20) btcRegime20.push(0);
    else btcRegime20.push((indexCloses[i] - indexCloses[i - 20]) / indexCloses[i - 20]);
  }

  // ---- BTC regime: 60-bar return of index ----
  const btcRegime60: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i < 60) btcRegime60.push(0);
    else btcRegime60.push((indexCloses[i] - indexCloses[i - 60]) / indexCloses[i - 60]);
  }

  // ---- BTC bull filter: 1 if 20-bar return > 0 ----
  const btcBullFilter = btcRegime20.map((r) => (r > 0 ? 1 : 0));

  // ---- Momentum lookbacks ----
  const mom5 = rollingReturn(closes, 5);
  const mom20 = rollingReturn(closes, 20);
  const mom60 = rollingReturn(closes, 60);

  // ---- Close / SMA20 ----
  const smaClose = sma(closes, 20);
  const closeOverSMA20 = closes.map((c, i) => {
    if (Number.isNaN(smaClose[i]) || smaClose[i] <= 0) return 0;
    return c / smaClose[i] - 1;
  });

  // ---- RS over RS MA: 1 if RS line above its own SMA ----
  const rsOverRsMa = rsLine.map((rs, i) => {
    if (Number.isNaN(rsMA[i])) return 0;
    return rs > rsMA[i] ? 1 : 0;
  });

  // ---- ATR regime: 1 if ATR% above its own 20-bar MA ----
  const atrMa = sma(atrPct, 20);
  const atrRegime = atrPct.map((a, i) => {
    if (Number.isNaN(atrMa[i])) return 0;
    return a > atrMa[i] ? 1 : 0;
  });

  const out: FeatureVector[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      time: asset[i].time,
      close: closes[i],
      features: [
        rsZScore[i],
        rsMomentum[i],
        assetReturn6[i],
        volumeRatio[i],
        atrPct[i],
        btcRegime20[i],
        btcRegime60[i],
        btcBullFilter[i],
        mom5[i],
        mom20[i],
        mom60[i],
        closeOverSMA20[i],
        rsOverRsMa[i],
        atrRegime[i],
      ],
    });
  }

  return out;
}

function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}
