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

export function zScore(data: number[], period: number): number[] {
  const ma = sma(data, period);
  const std = standardDeviation(data, period);
  return data.map((val, i) => {
    if (isNaN(ma[i]) || isNaN(std[i]) || std[i] === 0) return 0;
    return (val - ma[i]) / std[i];
  });
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
  if (downsideReturns.length === 0) return avg > 0 ? 10 : 0;
  const downsideStd = Math.sqrt(
    downsideReturns.reduce((a, b) => a + Math.pow(b - riskFreeRate, 2), 0) /
      downsideReturns.length
  );
  if (downsideStd === 0) return 0;
  return (avg - riskFreeRate) / downsideStd;
}