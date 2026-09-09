import { ScanConfig } from '../types';
import { MarketRegime } from './marketRegime';

export interface AutonomousParams {
  indexThreshold: number;
  volumeMultiplier: number;
  volumePeriod: number;
  lookback: number;
  rsPeriod: number;
  confidence: number;
  reason: string;
}

const REGIME_PRESETS: Record<MarketRegime, Partial<AutonomousParams>> = {
  strong_trend_up: {
    indexThreshold: 0.025,
    volumeMultiplier: 1.8,
    lookback: 8,
    rsPeriod: 20,
    confidence: 90,
  },
  weak_trend_up: {
    indexThreshold: 0.02,
    volumeMultiplier: 1.5,
    lookback: 6,
    rsPeriod: 20,
    confidence: 70,
  },
  ranging: {
    indexThreshold: 0.015,
    volumeMultiplier: 1.3,
    lookback: 4,
    rsPeriod: 14,
    confidence: 50,
  },
  weak_trend_down: {
    indexThreshold: 0.02,
    volumeMultiplier: 1.5,
    lookback: 6,
    rsPeriod: 20,
    confidence: 70,
  },
  strong_trend_down: {
    indexThreshold: 0.025,
    volumeMultiplier: 1.8,
    lookback: 8,
    rsPeriod: 20,
    confidence: 90,
  },
  volatile: {
    indexThreshold: 0.03,
    volumeMultiplier: 2.0,
    lookback: 4,
    rsPeriod: 14,
    confidence: 80,
  },
};

function adjustForVolatility(
  base: Partial<AutonomousParams>,
  atrPercent: number,
  volatilityPercentile: number
): Partial<AutonomousParams> {
  const adjusted = { ...base };

  if (volatilityPercentile > 75) {
    adjusted.indexThreshold = (adjusted.indexThreshold || 0.02) * 1.3;
    adjusted.volumeMultiplier = (adjusted.volumeMultiplier || 1.5) * 1.2;
  } else if (volatilityPercentile < 25) {
    adjusted.indexThreshold = (adjusted.indexThreshold || 0.02) * 0.7;
    adjusted.volumeMultiplier = (adjusted.volumeMultiplier || 1.5) * 0.8;
  }

  if (atrPercent > 5) {
    adjusted.lookback = Math.max(3, (adjusted.lookback || 6) - 2);
    adjusted.volumeMultiplier = (adjusted.volumeMultiplier || 1.5) * 1.1;
  } else if (atrPercent < 1) {
    adjusted.lookback = Math.min(12, (adjusted.lookback || 6) + 2);
    adjusted.volumeMultiplier = (adjusted.volumeMultiplier || 1.5) * 0.9;
  }

  adjusted.indexThreshold = Math.round((adjusted.indexThreshold || 0.02) * 1000) / 1000;
  adjusted.volumeMultiplier = Math.round((adjusted.volumeMultiplier || 1.5) * 100) / 100;
  adjusted.lookback = Math.round(adjusted.lookback || 6);
  adjusted.rsPeriod = adjusted.rsPeriod || 20;
  adjusted.volumePeriod = adjusted.volumePeriod || 20;

  return adjusted;
}

export function computeAutonomousParams(
  regime: MarketRegime,
  confidence: number,
  atrPercent: number,
  volatilityPercentile: number
): AutonomousParams {
  const preset = REGIME_PRESETS[regime];

  const adjusted = adjustForVolatility(preset, atrPercent, volatilityPercentile);

  const regimeLabels: Record<MarketRegime, string> = {
    strong_trend_up: 'Strong Uptrend',
    weak_trend_up: 'Weak Uptrend',
    ranging: 'Ranging',
    weak_trend_down: 'Weak Downtrend',
    strong_trend_down: 'Strong Downtrend',
    volatile: 'High Volatility',
  };

  const volLabel = volatilityPercentile > 75 ? ' (elevated)' : volatilityPercentile < 25 ? ' (compressed)' : '';

  return {
    indexThreshold: adjusted.indexThreshold || 0.02,
    volumeMultiplier: adjusted.volumeMultiplier || 1.5,
    volumePeriod: adjusted.volumePeriod || 20,
    lookback: adjusted.lookback || 6,
    rsPeriod: adjusted.rsPeriod || 20,
    confidence: adjusted.confidence || 50,
    reason: `Regime: ${regimeLabels[regime]} (${confidence}% conf) | Vol percentile: ${volatilityPercentile}%${volLabel} | ATR%: ${atrPercent.toFixed(2)}%`,
  };
}