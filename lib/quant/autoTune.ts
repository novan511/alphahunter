import { QuantRiskConfig } from './types';
import { getMarketProfile, MarketId } from './marketProfiles';

export interface AgentKpi {
  capitalStart: number;
  equity: number;
  pnlPercent: number;
  monthlyTargetLow: number;
  monthlyTargetHigh: number;
  daysElapsed: number;
  paceMonthlyPercent: number;
  status: 'ahead' | 'on_track' | 'behind' | 'critical' | 'fresh';
  openPositions: number;
  totalTrades: number;
  winRate: number;
  marketId?: string;
}

export interface AutoTuneResult {
  risk: QuantRiskConfig;
  reason: string;
  changed: boolean;
  kpi: AgentKpi;
}

/** Legacy global default — each market overrides via getKpiForAgent */
export const PAPER_KPI = {
  capitalStart: 1000,
  monthlyTargetLow: 0.10,
  monthlyTargetHigh: 0.50,
  maxMonthlyTargetHardCap: 0.50,
};

export function getKpiForAgent(agentId: string) {
  const market = (['crypto', 'commodities', 'gold-silver'] as const).includes(agentId as MarketId)
    ? (agentId as MarketId)
    : 'crypto';
  const profile = getMarketProfile(market);
  return {
    capitalStart: profile.baseRisk.initialCapital || 1000,
    monthlyTargetLow: profile.kpi.monthlyTargetLow,
    monthlyTargetHigh: profile.kpi.monthlyTargetHigh,
  };
}

const BOUNDS = {
  riskPerTrade: [0.002, 0.02] as const,
  maxConcurrentPositions: [2, 6] as const,
  maxExposurePct: [0.2, 0.6] as const,
  maxPortfolioDrawdownPct: [0.05, 0.15] as const,
  minSignalStrength: [3.0, 7.0] as const,
  stopLossATR: [1.2, 3.5] as const,
  takeProfitATR: [1.8, 5.0] as const,
  maxHoldBars: [12, 50] as const,
};

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function computeAgentKpi(
  cash: number,
  startedAt: number | null,
  openPositions: number,
  totalTrades: number,
  winRate: number,
  agentId: string = 'crypto'
): AgentKpi {
  const kpiCfg = getKpiForAgent(agentId);
  const capitalStart = kpiCfg.capitalStart;
  const equity = cash;
  const pnlPercent = ((equity - capitalStart) / capitalStart) * 100;
  const days = startedAt ? Math.max(0.01, (Date.now() - startedAt) / 86_400_000) : 0.01;
  const paceMonthlyPercent = (pnlPercent / days) * 30;

  let status: AgentKpi['status'] = 'fresh';
  if (startedAt) {
    const low = kpiCfg.monthlyTargetLow * 100;
    const high = kpiCfg.monthlyTargetHigh * 100;
    if (pnlPercent <= -10 || (paceMonthlyPercent < 0 && days > 7)) status = 'critical';
    else if (paceMonthlyPercent >= high) status = 'ahead';
    else if (paceMonthlyPercent >= low) status = 'on_track';
    else if (days > 3 && paceMonthlyPercent < low) status = 'behind';
    else status = 'fresh';
  }

  return {
    capitalStart,
    equity,
    pnlPercent: Math.round(pnlPercent * 100) / 100,
    monthlyTargetLow: kpiCfg.monthlyTargetLow,
    monthlyTargetHigh: kpiCfg.monthlyTargetHigh,
    daysElapsed: Math.round(days * 10) / 10,
    paceMonthlyPercent: Math.round(paceMonthlyPercent * 100) / 100,
    status,
    openPositions,
    totalTrades,
    winRate: Math.round(winRate * 10) / 10,
    marketId: agentId,
  };
}

/**
 * Autonomous parameter adjuster — market-aware KPI, isolated per agent.
 * Never guarantees returns; only moves risk knobs within hard bounds.
 */
export function autoTuneRisk(
  risk: QuantRiskConfig,
  kpi: AgentKpi,
  recentWinRate: number,
  recentTrades: number,
  agentId: string = 'crypto'
): AutoTuneResult {
  const kpiCfg = getKpiForAgent(agentId);
  const next: QuantRiskConfig = {
    ...risk,
    initialCapital: kpiCfg.capitalStart,
  };
  let reason = 'no_change';

  if (risk.initialCapital !== kpiCfg.capitalStart) {
    reason = `pin_capital_${kpiCfg.capitalStart}_${agentId}`;
  }

  if (recentTrades < 8) {
    next.riskPerTrade = clamp(0.004, ...BOUNDS.riskPerTrade);
    next.maxConcurrentPositions = Math.min(3, next.maxConcurrentPositions);
    next.maxExposurePct = Math.min(0.3, next.maxExposurePct);
    next.minSignalStrength = Math.max(next.minSignalStrength, 4.0);
    if (reason === 'no_change') reason = 'warmup_tight';
    return {
      risk: next,
      reason,
      changed: JSON.stringify(strip(next)) !== JSON.stringify(strip(risk)),
      kpi,
    };
  }

  const win = recentWinRate / 100;

  if (kpi.status === 'critical' || kpi.pnlPercent < -8) {
    next.riskPerTrade = clamp(0.003, ...BOUNDS.riskPerTrade);
    next.maxConcurrentPositions = 2;
    next.maxExposurePct = 0.25;
    next.minSignalStrength = clamp(next.minSignalStrength + 0.5, ...BOUNDS.minSignalStrength);
    next.maxPortfolioDrawdownPct = 0.08;
    next.allowShort = false;
    reason = 'de-risk_critical';
  } else if (kpi.status === 'behind') {
    next.minSignalStrength = clamp(next.minSignalStrength + 0.25, ...BOUNDS.minSignalStrength);
    next.maxConcurrentPositions = clamp(3, ...BOUNDS.maxConcurrentPositions);
    next.riskPerTrade = clamp(0.005, ...BOUNDS.riskPerTrade);
    next.maxExposurePct = 0.35;
    if (win < 0.4) {
      next.stopLossATR = clamp(next.stopLossATR - 0.1, ...BOUNDS.stopLossATR);
      next.takeProfitATR = clamp(next.takeProfitATR + 0.15, ...BOUNDS.takeProfitATR);
    }
    reason = 'catch_up_selective';
  } else if (kpi.status === 'on_track' || kpi.status === 'ahead') {
    if (win >= 0.48 && kpi.paceMonthlyPercent < kpiCfg.monthlyTargetHigh * 100) {
      next.riskPerTrade = clamp(next.riskPerTrade + 0.001, ...BOUNDS.riskPerTrade);
      next.maxConcurrentPositions = clamp(next.maxConcurrentPositions + 1, ...BOUNDS.maxConcurrentPositions);
      next.maxExposurePct = clamp(next.maxExposurePct + 0.05, ...BOUNDS.maxExposurePct);
      reason = 'scale_on_track';
    } else if (kpi.paceMonthlyPercent > kpiCfg.monthlyTargetHigh * 100 * 1.2) {
      next.riskPerTrade = clamp(next.riskPerTrade - 0.001, ...BOUNDS.riskPerTrade);
      next.maxExposurePct = clamp(next.maxExposurePct - 0.05, ...BOUNDS.maxExposurePct);
      reason = 'cool_overheat';
    } else {
      reason = 'hold_on_track';
    }
  } else {
    reason = 'warmup_hold';
  }

  if (kpi.pnlPercent < -12) {
    next.riskPerTrade = BOUNDS.riskPerTrade[0];
    next.maxConcurrentPositions = 2;
    next.maxExposurePct = 0.2;
    reason = 'capital_preserve';
  }

  return {
    risk: next,
    reason,
    changed: JSON.stringify(strip(next)) !== JSON.stringify(strip(risk)),
    kpi,
  };
}

function strip(r: QuantRiskConfig) {
  return {
    riskPerTrade: r.riskPerTrade,
    maxConcurrentPositions: r.maxConcurrentPositions,
    maxExposurePct: r.maxExposurePct,
    maxPortfolioDrawdownPct: r.maxPortfolioDrawdownPct,
    minSignalStrength: r.minSignalStrength,
    stopLossATR: r.stopLossATR,
    takeProfitATR: r.takeProfitATR,
    maxHoldBars: r.maxHoldBars,
    allowShort: r.allowShort,
    interval: r.interval,
    initialCapital: r.initialCapital,
  };
}
