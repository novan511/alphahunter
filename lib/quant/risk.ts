import { QuantRiskConfig } from './types';

/** Conservative defaults: low risk, portfolio-constrained, spot-friendly. */
export const DEFAULT_QUANT_RISK: QuantRiskConfig = {
  initialCapital: 1000,
  riskPerTrade: 0.005,
  stopLossATR: 2.0,
  takeProfitATR: 2.5,
  maxHoldBars: 36,
  feeRate: 0.001,
  slippage: 0.0005,
  maxConcurrentPositions: 4,
  maxExposurePct: 0.4,
  maxPortfolioDrawdownPct: 0.08,
  minSignalStrength: 4.0,
  allowShort: false,
  interval: '4h',
};

export const QUANT_UNIVERSE: string[] = [
  'ETHUSDT',
  'SOLUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'ADAUSDT',
  'AVAXUSDT',
  'LINKUSDT',
  'DOTUSDT',
  'NEARUSDT',
  'ATOMUSDT',
  'LTCUSDT',
  'UNIUSDT',
  'AAVEUSDT',
  'INJUSDT',
  'SUIUSDT',
  'APTUSDT',
  'ARBUSDT',
  'OPUSDT',
  'FILUSDT',
  'TONUSDT',
];

export function parseRiskFromQuery(query: Record<string, string | string[] | undefined>): QuantRiskConfig {
  const get = (key: string): string | undefined => {
    const v = query[key];
    return Array.isArray(v) ? v[0] : v;
  };
  const num = (key: string, fallback: number): number => {
    const raw = get(key);
    if (raw === undefined || raw === '') return fallback;
    const parsed = parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const bool = (key: string, fallback: boolean): boolean => {
    const raw = get(key);
    if (raw === undefined || raw === '') return fallback;
    return raw === 'true' || raw === '1';
  };

  return {
    initialCapital: num('initialCapital', DEFAULT_QUANT_RISK.initialCapital),
    riskPerTrade: num('riskPerTrade', DEFAULT_QUANT_RISK.riskPerTrade),
    stopLossATR: num('stopLossATR', DEFAULT_QUANT_RISK.stopLossATR),
    takeProfitATR: num('takeProfitATR', DEFAULT_QUANT_RISK.takeProfitATR),
    maxHoldBars: num('maxHoldBars', DEFAULT_QUANT_RISK.maxHoldBars),
    feeRate: num('feeRate', DEFAULT_QUANT_RISK.feeRate),
    slippage: num('slippage', DEFAULT_QUANT_RISK.slippage),
    maxConcurrentPositions: num('maxConcurrentPositions', DEFAULT_QUANT_RISK.maxConcurrentPositions),
    maxExposurePct: num('maxExposurePct', DEFAULT_QUANT_RISK.maxExposurePct),
    maxPortfolioDrawdownPct: num('maxPortfolioDrawdownPct', DEFAULT_QUANT_RISK.maxPortfolioDrawdownPct),
    minSignalStrength: num('minSignalStrength', DEFAULT_QUANT_RISK.minSignalStrength),
    allowShort: bool('allowShort', DEFAULT_QUANT_RISK.allowShort),
    interval: get('interval') || DEFAULT_QUANT_RISK.interval,
  };
}
