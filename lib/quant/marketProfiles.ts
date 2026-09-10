import { QuantRiskConfig } from './types';

export type MarketId = 'crypto' | 'commodities' | 'gold-silver';

export interface MarketProfile {
  id: MarketId;
  title: string;
  subtitle: string;
  accent: string;
  defaultPresetId: string;
  allowedPresetIds: string[];
  /** Base risk defaults tuned to asset behavior */
  baseRisk: QuantRiskConfig;
  /** Behavior notes shown in UI */
  behavior: string[];
  /** Volatility scaling for auto-param */
  vol: {
    /** Typical daily ATR% band for “normal” regime */
    normalAtrPct: [number, number];
    /** Scale SL/TP when vol high */
    highVolScale: number;
    lowVolScale: number;
  };
  kpi: {
    monthlyTargetLow: number;
    monthlyTargetHigh: number;
  };
}

export const MARKET_PROFILES: Record<MarketId, MarketProfile> = {
  crypto: {
    id: 'crypto',
    title: 'Quant Crypto',
    subtitle: 'High-vol crypto majors · decoupling vs BTC · faster bars',
    accent: '#3b82f6',
    defaultPresetId: 'binance-top',
    allowedPresetIds: ['binance-top', 'hyperliquid-majors', 'paper-cross-asset', 'multi-asset'],
    baseRisk: {
      initialCapital: 1000,
      riskPerTrade: 0.005,
      stopLossATR: 2.0,
      takeProfitATR: 2.5,
      maxHoldBars: 24,
      feeRate: 0.001,
      slippage: 0.0005,
      maxConcurrentPositions: 4,
      maxExposurePct: 0.4,
      maxPortfolioDrawdownPct: 0.08,
      minSignalStrength: 3.0,
      allowShort: false,
      interval: '4h',
    },
    behavior: [
      'Volatility tinggi, drawdown cepat → risk/trade lebih kecil',
      'Decoupling vs BTC di 1h/4h/1d',
      'Hold lebih pendek; fee/slippage material',
    ],
    vol: { normalAtrPct: [1.5, 4], highVolScale: 1.25, lowVolScale: 0.85 },
    kpi: { monthlyTargetLow: 0.10, monthlyTargetHigh: 0.50 },
  },
  commodities: {
    id: 'commodities',
    title: 'Quant Commodities',
    subtitle: 'Oil, gas, copper, platinum… trend yang lebih lambat',
    accent: '#f59e0b',
    defaultPresetId: 'macro-commodities',
    allowedPresetIds: ['macro-commodities', 'metals-energy', 'paper-cross-asset'],
    baseRisk: {
      initialCapital: 1000,
      riskPerTrade: 0.004,
      stopLossATR: 2.2,
      takeProfitATR: 3.0,
      maxHoldBars: 40,
      feeRate: 0.0005,
      slippage: 0.0008,
      maxConcurrentPositions: 3,
      maxExposurePct: 0.35,
      maxPortfolioDrawdownPct: 0.07,
      minSignalStrength: 2.8,
      allowShort: true,
      interval: '1d',
    },
    behavior: [
      'Move lebih lambat dari crypto → hold bar lebih panjang',
      'Seasonality & shock supply → SL sedikit lebih lebar',
      'Universe kecil, concentratin risk lebih tinggi',
    ],
    vol: { normalAtrPct: [0.8, 2.0], highVolScale: 1.2, lowVolScale: 0.9 },
    kpi: { monthlyTargetLow: 0.08, monthlyTargetHigh: 0.35 },
  },
  'gold-silver': {
    id: 'gold-silver',
    title: 'Quant Gold & Silver',
    subtitle: 'Precious metals · macro hedge · trend-following ringan',
    accent: '#eab308',
    defaultPresetId: 'metals-energy',
    allowedPresetIds: ['metals-energy', 'macro-commodities', 'paper-cross-asset'],
    baseRisk: {
      initialCapital: 1000,
      riskPerTrade: 0.0035,
      stopLossATR: 1.8,
      takeProfitATR: 2.8,
      maxHoldBars: 50,
      feeRate: 0.0004,
      slippage: 0.0006,
      maxConcurrentPositions: 2,
      maxExposurePct: 0.3,
      maxPortfolioDrawdownPct: 0.06,
      minSignalStrength: 2.6,
      allowShort: true,
      interval: '1d',
    },
    behavior: [
      'Vol lebih rendah dari crypto → size lebih kecil, hold lebih lama',
      'Gold/Silver cenderung trend macro multi-minggu',
      'Max 2 posisi agar tidak over-diversify logam berkorelasi',
    ],
    vol: { normalAtrPct: [0.5, 1.5], highVolScale: 1.15, lowVolScale: 0.88 },
    kpi: { monthlyTargetLow: 0.05, monthlyTargetHigh: 0.25 },
  },
};

export function getMarketProfile(id: string): MarketProfile {
  return MARKET_PROFILES[id as MarketId] || MARKET_PROFILES.crypto;
}

/**
 * Scale risk params from recent ATR% vs profile “normal” band.
 * Called when running backtest / paper start so params fit current behavior.
 */
export function adaptRiskToObservedVol(
  risk: QuantRiskConfig,
  profile: MarketProfile,
  recentAtrPctMedian: number
): { risk: QuantRiskConfig; note: string } {
  if (!Number.isFinite(recentAtrPctMedian) || recentAtrPctMedian <= 0) {
    return { risk, note: 'vol: n/a (keep base)' };
  }

  const [lo, hi] = profile.vol.normalAtrPct;
  let scale = 1;
  let regime = 'normal';

  if (recentAtrPctMedian > hi) {
    scale = profile.vol.highVolScale;
    regime = 'high_vol';
  } else if (recentAtrPctMedian < lo) {
    scale = profile.vol.lowVolScale;
    regime = 'low_vol';
  }

  const next: QuantRiskConfig = {
    ...risk,
    stopLossATR: clamp(risk.stopLossATR * scale, 1.2, 3.5),
    takeProfitATR: clamp(risk.takeProfitATR * scale, 1.8, 5),
    minSignalStrength: regime === 'high_vol' ? clamp(risk.minSignalStrength + 0.4, 3, 7) : risk.minSignalStrength,
    maxExposurePct:
      regime === 'high_vol'
        ? clamp(risk.maxExposurePct - 0.05, 0.15, 0.6)
        : risk.maxExposurePct,
    maxConcurrentPositions:
      regime === 'high_vol'
        ? Math.max(2, risk.maxConcurrentPositions - 1)
        : risk.maxConcurrentPositions,
  };

  return {
    risk: next,
    note: `vol_adapt:${regime} atr≈${recentAtrPctMedian.toFixed(2)}% scale=${scale}`,
  };
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Quick ATR% median from a candle series (for auto adapt). */
export function medianAtrPctFromCandles(
  closes: number[],
  highs: number[],
  lows: number[]
): number {
  if (closes.length < 20) return 0;
  const atrs: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    atrs.push((tr / closes[i]) * 100);
  }
  atrs.sort((a, b) => a - b);
  return atrs[Math.floor(atrs.length / 2)] || 0;
}
