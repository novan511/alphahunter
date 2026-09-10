import { QuantRiskConfig, QuantRunResult, PortfolioBacktestResult } from './types';
import { MarketId, getMarketProfile } from './marketProfiles';
import { loadQuantUniverse, resolveUniverseFromQuery } from './catalog';
import { runPortfolioBacktest } from './portfolioBacktest';
import { runWalkForward } from './walkForward';

export interface LabCombo {
  id: string;
  marketId: MarketId;
  presetId: string;
  interval: string;
  risk: QuantRiskConfig;
  label: string;
}

export interface LabRunRow {
  comboId: string;
  marketId: string;
  label: string;
  presetId: string;
  interval: string;
  risk: Partial<QuantRiskConfig>;
  status: 'pending' | 'running' | 'done' | 'failed';
  error?: string;
  metrics: {
    fullPF: number;
    fullSharpe: number;
    fullMaxDD: number;
    fullPnL: number;
    fullTrades: number;
    fullWinRate: number;
    fullExpectancyR: number;
    oosPF: number;
    oosSharpe: number;
    oosMaxDD: number;
    oosPnL: number;
    oosExpectancyR: number;
    oosTrades: number;
    oosPositiveWindows: number;
    oosWindowsTotal: number;
    compositeScore: number;
    credible: boolean;
    /** Full-sample calendar span */
    periodStart?: number;
    periodEnd?: number;
    periodDays?: number;
    /** Dollar PnL on $1000 */
    fullPnLUsd?: number;
    oosPnLUsd?: number;
  } | null;
}

export interface LabBatchRequest {
  marketId: MarketId;
  gridSize?: LabGridSize;
  /** null = default grid for that market + gridSize */
  combos?: Array<{
    interval?: string;
    riskPerTrade?: number;
    minSignalStrength?: number;
    stopLossATR?: number;
    takeProfitATR?: number;
    maxConcurrentPositions?: number;
    maxExposurePct?: number;
    allowShort?: boolean;
  }>;
  walkForward?: boolean;
}

/**
 * Composite score biased toward OOS consistency (KPI-friendly, not max PF lottery).
 * Higher is better. Guards small samples.
 */
export function compositeScore(oos: {
  avgProfitFactor: number;
  avgSharpe: number;
  avgMaxDrawdownPercent: number;
  avgTotalPnLPercent: number;
  avgExpectancyR: number;
  totalTrades: number;
  windowsWithPositiveEdge: number;
  windowsTotal: number;
}): { score: number; credible: boolean } {
  const minTrades = 20;
  const minWindows = 2;
  const credible =
    oos.totalTrades >= minTrades &&
    oos.windowsTotal >= minWindows &&
    oos.windowsWithPositiveEdge / Math.max(1, oos.windowsTotal) >= 0.5;

  const pf = Number.isFinite(oos.avgProfitFactor) ? Math.min(oos.avgProfitFactor, 5) : 0;
  const sharpe = Number.isFinite(oos.avgSharpe) ? Math.max(-3, Math.min(oos.avgSharpe, 5)) : 0;
  const dd = Math.max(0, oos.avgMaxDrawdownPercent);
  const pnl = oos.avgTotalPnLPercent;
  const expR = oos.avgExpectancyR;
  const edgeRatio =
    oos.windowsTotal > 0 ? oos.windowsWithPositiveEdge / oos.windowsTotal : 0;

  // Core: OOS PF + Sharpe − DD, plus expectancy & window consistency
  let score =
    2.0 * pf +
    0.8 * sharpe -
    0.6 * dd +
    0.15 * pnl +
    1.5 * expR +
    1.2 * edgeRatio;

  // Soft penalty for thin samples (still rankable, but not “best”)
  if (oos.totalTrades < minTrades) {
    score *= Math.max(0.35, oos.totalTrades / minTrades);
  }
  if (!credible) {
    score *= 0.75;
  }

  // Never let extreme PF with 1–2 trades dominate
  if (oos.totalTrades < 8) {
    score = Math.min(score, 2.5);
  }

  return { score: Math.round(score * 1000) / 1000, credible };
}

export type LabGridSize = 'quick' | 'standard' | 'full';

export const LAB_GRID_SIZES: Record<LabGridSize, { label: string; maxCombos: number }> = {
  quick: { label: 'Quick (~18)', maxCombos: 18 },
  standard: { label: 'Standard (~36)', maxCombos: 36 },
  full: { label: 'Full (~54)', maxCombos: 54 },
};

export function defaultLabCombos(
  marketId: MarketId,
  gridSize: LabGridSize = 'standard'
): LabCombo[] {
  const profile = getMarketProfile(marketId);
  const base = profile.baseRisk;
  const presetId = profile.defaultPresetId;
  const maxCombos = LAB_GRID_SIZES[gridSize].maxCombos;

  // Broader TF coverage. Yahoo remaps some (4h→1h). Skip 45m (not on Binance/HL).
  const intervals: string[] =
    marketId === 'crypto'
      ? gridSize === 'quick'
        ? ['4h', '1d']
        : gridSize === 'standard'
          ? ['30m', '1h', '4h', '1d']
          : ['15m', '30m', '1h', '4h', '1d']
      : gridSize === 'quick'
        ? ['1d']
        : gridSize === 'standard'
          ? ['1h', '4h', '1d']
          : ['1h', '4h', '1d', '1w'];

  const riskPerTrades =
    marketId === 'crypto' ? [0.003, 0.005, 0.008] : [0.003, 0.004, 0.006];
  const minSignals =
    marketId === 'crypto' ? [3.0, 3.5, 4.0] : [2.6, 3.0, 3.5];
  const slTps: Array<[number, number]> =
    marketId === 'crypto'
      ? [
          [1.5, 2.5],
          [2.0, 3.0],
          [1.5, 3.5],
          [2.5, 2.5],
        ]
      : [
          [1.8, 2.8],
          [2.2, 3.0],
          [1.5, 3.5],
          [2.0, 2.5],
        ];
  const maxPositionsOpts = marketId === 'crypto' ? [3, 4, 5] : [2, 3, 4];

  const combos: LabCombo[] = [];
  let n = 0;

  // Outer: TF × risk × minStr (main axes user cares about)
  // Inner: rotate SL/TP + maxPositions so we cover more without exploding
  for (const interval of intervals) {
    for (const riskPerTrade of riskPerTrades) {
      for (const minSignalStrength of minSignals) {
        if (combos.length >= maxCombos) break;
        const slIdx = n % slTps.length;
        const posIdx = Math.floor(n / slTps.length) % maxPositionsOpts.length;
        const [stopLossATR, takeProfitATR] = slTps[slIdx];
        const maxConcurrentPositions = maxPositionsOpts[posIdx];
        n += 1;
        combos.push({
          id: `${marketId}-${n}`,
          marketId,
          presetId,
          interval,
          risk: {
            ...base,
            interval,
            riskPerTrade,
            minSignalStrength,
            stopLossATR,
            takeProfitATR,
            maxConcurrentPositions,
            allowShort: marketId !== 'crypto' ? true : base.allowShort,
          },
          label: `${interval} · risk ${(riskPerTrade * 100).toFixed(2)}% · minStr ${minSignalStrength} · SL/TP ${stopLossATR}/${takeProfitATR} · maxPos ${maxConcurrentPositions}`,
        });
      }
    }
  }

  // If still under budget, add extra TF × SL/TP slices
  if (combos.length < maxCombos) {
    for (const interval of intervals) {
      for (const [stopLossATR, takeProfitATR] of slTps) {
        if (combos.length >= maxCombos) break;
        n += 1;
        combos.push({
          id: `${marketId}-x${n}`,
          marketId,
          presetId,
          interval,
          risk: {
            ...base,
            interval,
            riskPerTrade: riskPerTrades[n % riskPerTrades.length],
            minSignalStrength: minSignals[n % minSignals.length],
            stopLossATR,
            takeProfitATR,
            maxConcurrentPositions: maxPositionsOpts[n % maxPositionsOpts.length],
            allowShort: marketId !== 'crypto' ? true : base.allowShort,
          },
          label: `${interval} · risk ${((riskPerTrades[n % riskPerTrades.length]) * 100).toFixed(2)}% · minStr ${minSignals[n % minSignals.length]} · SL/TP ${stopLossATR}/${takeProfitATR} · maxPos ${maxPositionsOpts[n % maxPositionsOpts.length]}`,
        });
      }
    }
  }

  return combos.slice(0, maxCombos);
}

function emptyMetrics(): NonNullable<LabRunRow['metrics']> {
  return {
    fullPF: 0,
    fullSharpe: 0,
    fullMaxDD: 0,
    fullPnL: 0,
    fullTrades: 0,
    fullWinRate: 0,
    fullExpectancyR: 0,
    oosPF: 0,
    oosSharpe: 0,
    oosMaxDD: 0,
    oosPnL: 0,
    oosExpectancyR: 0,
    oosTrades: 0,
    oosPositiveWindows: 0,
    oosWindowsTotal: 0,
    compositeScore: 0,
    credible: false,
  };
}

export async function runLabBatch(
  req: LabBatchRequest,
  onProgress?: (done: number, total: number, last: LabRunRow) => void
): Promise<LabRunRow[]> {
  const combos =
    req.combos && req.combos.length > 0
      ? req.combos.map((c, i) => ({
          id: `${req.marketId}-c${i + 1}`,
          marketId: req.marketId,
          presetId: getMarketProfile(req.marketId).defaultPresetId,
          interval: c.interval || getMarketProfile(req.marketId).baseRisk.interval,
          risk: {
            ...getMarketProfile(req.marketId).baseRisk,
            ...c,
            interval: c.interval || getMarketProfile(req.marketId).baseRisk.interval,
          } as QuantRiskConfig,
          label: `${c.interval || getMarketProfile(req.marketId).baseRisk.interval} · risk ${((c.riskPerTrade ?? getMarketProfile(req.marketId).baseRisk.riskPerTrade) * 100).toFixed(2)}% · minStr ${c.minSignalStrength ?? getMarketProfile(req.marketId).baseRisk.minSignalStrength}`,
        }))
      : defaultLabCombos(req.marketId, req.gridSize || 'standard');

  const rows: LabRunRow[] = combos.map((c) => ({
    comboId: c.id,
    marketId: c.marketId,
    label: c.label,
    presetId: c.presetId,
    interval: c.interval,
    risk: {
      riskPerTrade: c.risk.riskPerTrade,
      minSignalStrength: c.risk.minSignalStrength,
      stopLossATR: c.risk.stopLossATR,
      takeProfitATR: c.risk.takeProfitATR,
      maxConcurrentPositions: c.risk.maxConcurrentPositions,
      maxExposurePct: c.risk.maxExposurePct,
      allowShort: c.risk.allowShort,
      interval: c.risk.interval,
    },
    status: 'pending',
    metrics: null,
  }));

  for (let i = 0; i < combos.length; i++) {
    const combo = combos[i];
    rows[i].status = 'running';
    onProgress?.(i, combos.length, rows[i]);

    try {
      const universe = {
        assets: [] as never[],
        benchmark: null,
        interval: combo.interval,
        presetId: combo.presetId,
      };
      // resolve via query-like helper
      const resolved = resolveUniverseFromQuery({
        preset: combo.presetId,
        interval: combo.interval,
      });
      const { assets, benchmarkCandles, errors } = await loadQuantUniverse(
        resolved.assets,
        resolved.benchmark,
        combo.interval,
        combo.interval === '1d' || combo.interval === '1w' ? 800 : 600,
        true
      );
      void universe;
      if (assets.length === 0) {
        throw new Error(errors[0] || 'no market data');
      }

      const full = runPortfolioBacktest(assets, combo.risk);
      const wf = runWalkForward(assets, combo.risk, { oosWindows: 3 });
      const oos = wf.oosAggregate;

      // Calendar span from equity curve (full sample)
      let periodStart: number | undefined;
      let periodEnd: number | undefined;
      let periodDays: number | undefined;
      if (full.equityCurve.length >= 2) {
        periodStart = full.equityCurve[0].time;
        periodEnd = full.equityCurve[full.equityCurve.length - 1].time;
        periodDays = Math.max(1, Math.round((periodEnd - periodStart) / 86400));
      } else if (assets[0]?.candles?.length) {
        const c = assets[0].candles;
        periodStart = c[0].time;
        periodEnd = c[c.length - 1].time;
        periodDays = Math.max(1, Math.round((periodEnd - periodStart) / 86400));
      }

      const capital = combo.risk.initialCapital || 1000;
      const fullPnLUsd = Math.round((full.totalPnLPercent / 100) * capital * 100) / 100;
      const oosPnLUsd = Math.round((oos.avgTotalPnLPercent / 100) * capital * 100) / 100;

      const score = compositeScore({
        avgProfitFactor: oos.avgProfitFactor,
        avgSharpe: oos.avgSharpe,
        avgMaxDrawdownPercent: oos.avgMaxDrawdownPercent,
        avgTotalPnLPercent: oos.avgTotalPnLPercent,
        avgExpectancyR: oos.avgExpectancyR,
        totalTrades: oos.totalTrades,
        windowsWithPositiveEdge: oos.windowsWithPositiveEdge,
        windowsTotal: oos.windowsTotal,
      });

      rows[i].status = 'done';
      rows[i].metrics = {
        fullPF: full.profitFactor,
        fullSharpe: full.sharpeRatio,
        fullMaxDD: full.maxDrawdownPercent,
        fullPnL: full.totalPnLPercent,
        fullTrades: full.totalTrades,
        fullWinRate: full.winRate,
        fullExpectancyR: full.expectancyR,
        oosPF: oos.avgProfitFactor,
        oosSharpe: oos.avgSharpe,
        oosMaxDD: oos.avgMaxDrawdownPercent,
        oosPnL: oos.avgTotalPnLPercent,
        oosExpectancyR: oos.avgExpectancyR,
        oosTrades: oos.totalTrades,
        oosPositiveWindows: oos.windowsWithPositiveEdge,
        oosWindowsTotal: oos.windowsTotal,
        compositeScore: score.score,
        credible: score.credible,
        periodStart,
        periodEnd,
        periodDays,
        fullPnLUsd,
        oosPnLUsd,
      };
    } catch (err) {
      rows[i].status = 'failed';
      rows[i].error = err instanceof Error ? err.message : 'run failed';
      rows[i].metrics = emptyMetrics();
    }

    onProgress?.(i + 1, combos.length, rows[i]);
  }

  return rows;
}

export function rankLabRows(rows: LabRunRow[]): LabRunRow[] {
  return [...rows].sort((a, b) => {
    const ac = a.metrics?.compositeScore ?? -999;
    const bc = b.metrics?.compositeScore ?? -999;
    if (bc !== ac) return bc - ac;
    const ao = a.metrics?.oosPF ?? 0;
    const bo = b.metrics?.oosPF ?? 0;
    return bo - ao;
  });
}

export function bestRowForMarket(rows: LabRunRow[]): LabRunRow | null {
  const done = rows.filter((r) => r.status === 'done' && r.metrics);
  if (!done.length) return null;
  return rankLabRows(done)[0] || null;
}
