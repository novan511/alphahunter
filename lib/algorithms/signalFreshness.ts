import { Candle, DecouplingSignal } from '../types';

export const DEFAULT_MAX_SIGNAL_AGE_BARS = 8;

const INTERVAL_SECONDS: Record<string, number> = {
  '1m': 60,
  '3m': 180,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '2h': 7200,
  '4h': 14400,
  '6h': 21600,
  '8h': 28800,
  '12h': 43200,
  '1d': 86400,
  '3d': 259200,
  '1w': 604800,
  '1mo': 2592000,
};

export function intervalToSeconds(interval: string): number {
  return INTERVAL_SECONDS[interval] || 3600;
}

export function intervalSecondsToBars(seconds: number, interval: string): number {
  const bar = intervalToSeconds(interval);
  return Math.max(1, Math.round(seconds / bar));
}

export function signalAgeBars(
  signal: DecouplingSignal,
  candles: Candle[],
  interval: string
): number | null {
  if (candles.length === 0) return null;

  const lastIndex = candles.length - 1;
  const lastTime = candles[lastIndex].time;

  for (let i = lastIndex; i >= 0; i--) {
    if (candles[i].time === signal.time) {
      return lastIndex - i;
    }
  }

  const barSec = intervalToSeconds(interval);
  const age = Math.round((lastTime - signal.time) / barSec);
  return age >= 0 ? age : null;
}

/**
 * Returns the most recent signal that is still fresh (age <= maxBarsAge).
 * Stale historical signals are ignored so rankings are not inflated by basi setups.
 */
export function getFreshLatestSignal(
  signals: DecouplingSignal[],
  candles: Candle[],
  interval: string,
  maxBarsAge: number = DEFAULT_MAX_SIGNAL_AGE_BARS
): { signal: DecouplingSignal | null; ageBars: number | null } {
  if (signals.length === 0 || candles.length === 0) {
    return { signal: null, ageBars: null };
  }

  for (let i = signals.length - 1; i >= 0; i--) {
    const age = signalAgeBars(signals[i], candles, interval);
    if (age !== null && age >= 0 && age <= maxBarsAge) {
      return { signal: signals[i], ageBars: age };
    }
  }

  return { signal: null, ageBars: null };
}
