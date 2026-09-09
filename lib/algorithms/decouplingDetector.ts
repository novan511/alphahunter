import { Candle, DecouplingSignal, ScanConfig } from '../types';
import { sma } from './indicators';
import { calculateRSData } from './relativeStrength';

export function detectDecoupling(
  assetCandles: Candle[],
  indexCandles: Candle[],
  config: ScanConfig
): DecouplingSignal[] {
  if (assetCandles.length !== indexCandles.length) {
    throw new Error('Asset and index candle arrays must have the same length');
  }

  const signals: DecouplingSignal[] = [];
  const { lookback, indexThreshold, volumeMultiplier, volumePeriod, rsPeriod } = config;

  const closes = assetCandles.map((c) => c.close);
  const indexCloses = indexCandles.map((c) => c.close);

  const assetReturns = closes.map((close, i) => {
    if (i < lookback) return 0;
    return (close - closes[i - lookback]) / closes[i - lookback];
  });

  const indexReturns = indexCloses.map((close, i) => {
    if (i < lookback) return 0;
    return (close - indexCloses[i - lookback]) / indexCloses[i - lookback];
  });

  const volumes = assetCandles.map((c) => c.volume);
  const volumeMAValues = sma(volumes, volumePeriod);

  const rsData = calculateRSData(assetCandles, indexCandles, rsPeriod);

  for (let i = Math.max(lookback, volumePeriod, rsPeriod); i < assetCandles.length; i++) {
    const indexReturn = indexReturns[i];
    const assetReturn = assetReturns[i];
    const vol = assetCandles[i].volume;
    const avgVol = volumeMAValues[i];

    if (isNaN(avgVol) || avgVol === 0) continue;

    const volumeRatio = vol / avgVol;
    const rsZScore = rsData[i].rsZScore;
    const rsMomentum = rsData[i].rsMomentum;

    const isIndexCrashing = indexReturn <= -indexThreshold;
    const isIndexSurging = indexReturn >= indexThreshold;

    const isVolumeConfirmed = volumeRatio >= volumeMultiplier;

    if (isIndexCrashing && assetReturn >= 0 && isVolumeConfirmed && rsMomentum > 0) {
      const strength = Math.min(Math.abs(indexReturn) * 10 + rsZScore + volumeRatio, 10);

      signals.push({
        time: assetCandles[i].time,
        price: assetCandles[i].close,
        type: 'buy',
        strength: Math.round(strength * 100) / 100,
        rsZScore: Math.round(rsZScore * 100) / 100,
        indexReturn: Math.round(indexReturn * 10000) / 100,
        assetReturn: Math.round(assetReturn * 10000) / 100,
        volumeRatio: Math.round(volumeRatio * 100) / 100,
        reason: `Bear decoupling: Index ${indexReturn >= 0 ? '+' : ''}${(indexReturn * 100).toFixed(2)}%, Asset ${assetReturn >= 0 ? '+' : ''}${(assetReturn * 100).toFixed(2)}%, RS Z: ${rsZScore.toFixed(2)}, Vol: ${volumeRatio.toFixed(1)}x`,
      });
    }

    if (isIndexSurging && assetReturn <= 0 && isVolumeConfirmed && rsMomentum < 0) {
      const strength = Math.min(Math.abs(indexReturn) * 10 + Math.abs(rsZScore) + volumeRatio, 10);

      signals.push({
        time: assetCandles[i].time,
        price: assetCandles[i].close,
        type: 'sell',
        strength: Math.round(strength * 100) / 100,
        rsZScore: Math.round(rsZScore * 100) / 100,
        indexReturn: Math.round(indexReturn * 10000) / 100,
        assetReturn: Math.round(assetReturn * 10000) / 100,
        volumeRatio: Math.round(volumeRatio * 100) / 100,
        reason: `Bull decoupling: Index ${indexReturn >= 0 ? '+' : ''}${(indexReturn * 100).toFixed(2)}%, Asset ${assetReturn >= 0 ? '+' : ''}${(assetReturn * 100).toFixed(2)}%, RS Z: ${rsZScore.toFixed(2)}, Vol: ${volumeRatio.toFixed(1)}x`,
      });
    }
  }

  return signals;
}