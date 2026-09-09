import { Candle, RSDataPoint } from '../types';
import { sma, standardDeviation } from './indicators';

export function calculateRSLine(assetCandles: Candle[], indexCandles: Candle[]): number[] {
  if (assetCandles.length !== indexCandles.length) {
    throw new Error('Asset and index candle arrays must have the same length');
  }

  return assetCandles.map((asset, i) => {
    if (indexCandles[i].close === 0) return 1;
    return asset.close / indexCandles[i].close;
  });
}

export function calculateRSData(
  assetCandles: Candle[],
  indexCandles: Candle[],
  rsPeriod: number
): RSDataPoint[] {
  const rsLine = calculateRSLine(assetCandles, indexCandles);
  const rsMASeries = sma(rsLine, rsPeriod);
  const rsStdSeries = standardDeviation(rsLine, rsPeriod);

  const result: RSDataPoint[] = [];

  for (let i = 0; i < rsLine.length; i++) {
    const rs = rsLine[i];
    const rsMA = rsMASeries[i];
    const rsStd = rsStdSeries[i];

    const rsUpperBand = isNaN(rsMA) || isNaN(rsStd) ? rs : rsMA + 2 * rsStd;
    const rsLowerBand = isNaN(rsMA) || isNaN(rsStd) ? rs : rsMA - 2 * rsStd;

    let rsZScore = 0;
    if (!isNaN(rsStd) && rsStd > 0 && !isNaN(rsMA)) {
      rsZScore = (rs - rsMA) / rsStd;
    }

    const rsMomentum = i > 0 ? rs - rsLine[i - 1] : 0;

    result.push({
      time: assetCandles[i].time,
      rs,
      rsMA,
      rsUpperBand,
      rsLowerBand,
      rsZScore,
      rsMomentum,
    });
  }

  return result;
}