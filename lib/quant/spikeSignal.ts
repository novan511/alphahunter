import { Candle } from '../types';

export interface SpikeEvent {
  time: number;
  type: 'buy' | 'sell';
  strength: number;
  volumeZ: number;
  momentum: number;
  reason: string;
}

/**
 * Institutional-style volume spike detector (simplified paper §4).
 * No order book — uses volume z-score + price velocity + ATR context.
 */
export function detectSpikes(
  candles: Candle[],
  options: {
    volLookback?: number;
    volZThreshold?: number;
    momThreshold?: number;
    maxStrength?: number;
  } = {}
): SpikeEvent[] {
  const volLookback = options.volLookback ?? 20;
  const volZThreshold = options.volZThreshold ?? 2.0;
  const momThreshold = options.momThreshold ?? 0.008;
  const maxStrength = options.maxStrength ?? 10;
  const events: SpikeEvent[] = [];

  if (candles.length < volLookback + 5) return events;

  for (let i = volLookback + 2; i < candles.length; i++) {
    const volSlice = candles.slice(i - volLookback, i);
    const vols = volSlice.map((c) => c.volume);
    const mean = vols.reduce((a, b) => a + b, 0) / vols.length;
    const variance =
      vols.reduce((a, b) => a + (b - mean) * (b - mean), 0) / vols.length;
    // floor std so flat history still allows a massive spike to register
    const std = Math.max(Math.sqrt(variance), mean * 0.05, 1e-9);
    const vol = candles[i].volume;
    if (mean <= 0) continue;

    const volumeZ = (vol - mean) / std;
    if (volumeZ < volZThreshold) continue;

    const c0 = candles[i].close;
    const c1 = candles[i - 1].close;
    const c2 = candles[i - 2].close;
    if (c1 <= 0 || c2 <= 0) continue;

    const mom1 = (c0 - c1) / c1;
    const mom2 = (c1 - c2) / c2;
    const accel = mom1 - mom2;

    // Long spike: big volume + positive velocity
    if (mom1 >= momThreshold && accel >= -momThreshold * 0.5) {
      const strength = Math.min(3 + volumeZ * 0.8 + Math.abs(mom1) * 50, maxStrength);
      events.push({
        time: candles[i].time,
        type: 'buy',
        strength: Math.round(strength * 100) / 100,
        volumeZ: Math.round(volumeZ * 100) / 100,
        momentum: Math.round(mom1 * 10000) / 100,
        reason: `spike long: volZ ${volumeZ.toFixed(1)} mom ${(mom1 * 100).toFixed(2)}%`,
      });
    }

    // Short spike: big volume + negative velocity
    if (mom1 <= -momThreshold && accel <= momThreshold * 0.5) {
      const strength = Math.min(3 + volumeZ * 0.8 + Math.abs(mom1) * 50, maxStrength);
      events.push({
        time: candles[i].time,
        type: 'sell',
        strength: Math.round(strength * 100) / 100,
        volumeZ: Math.round(volumeZ * 100) / 100,
        momentum: Math.round(mom1 * 10000) / 100,
        reason: `spike short: volZ ${volumeZ.toFixed(1)} mom ${(mom1 * 100).toFixed(2)}%`,
      });
    }
  }

  return events;
}

/** Latest spike if any in the trailing window of candles. */
export function latestSpike(
  candles: Candle[],
  windowBars = 5
): SpikeEvent | null {
  if (candles.length < 25) return null;
  const slice = candles.slice(-windowBars - 1);
  const events = detectSpikes(slice.length > 25 ? candles.slice(-40) : candles);
  if (!events.length) return null;
  return events[events.length - 1];
}
