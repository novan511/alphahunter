import { QuantAssetData, QuantRiskConfig, WalkForwardResult, WalkForwardWindow } from './types';
import { runPortfolioBacktest } from './portfolioBacktest';

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * Anchored-style walk-forward:
 * For each fold, train window is used only to sanity-check stability;
 * performance KPIs emphasize OOS segment.
 */
export function runWalkForward(
  assets: QuantAssetData[],
  risk: QuantRiskConfig,
  options: { oosWindows?: number } = {}
): WalkForwardResult {
  const oosWindows = Math.max(2, Math.min(6, options.oosWindows ?? 3));
  const timelineSet = new Set<number>();
  for (const a of assets) {
    for (const c of a.candles) timelineSet.add(c.time);
  }
  const timeline = Array.from(timelineSet).sort((a, b) => a - b);
  const n = timeline.length;
  if (n < 80) {
    return {
      windows: [],
      oosAggregate: {
        totalTrades: 0,
        avgProfitFactor: 0,
        avgSharpe: 0,
        avgSortino: 0,
        avgMaxDrawdownPercent: 0,
        avgTotalPnLPercent: 0,
        avgExpectancyR: 0,
        windowsWithPositiveEdge: 0,
        windowsTotal: 0,
      },
    };
  }

  const windows: WalkForwardWindow[] = [];
  // Split remaining after initial warmup into oosWindows equal chunks
  const warmup = Math.floor(n * 0.25);
  const rest = n - warmup;
  const chunk = Math.floor(rest / oosWindows);

  for (let w = 0; w < oosWindows; w++) {
    const oosStart = warmup + w * chunk;
    const oosEnd = w === oosWindows - 1 ? n - 1 : warmup + (w + 1) * chunk - 1;
    if (oosEnd - oosStart < 10) continue;

    const isStart = 0;
    const isEnd = Math.max(10, oosStart - 1);

    const inSample =
      isEnd > isStart + 10
        ? runPortfolioBacktest(assets, risk, { startIdx: isStart, endIdx: isEnd })
        : null;
    const outOfSample = runPortfolioBacktest(assets, risk, { startIdx: oosStart, endIdx: oosEnd });

    windows.push({
      label: `W${w + 1}`,
      startIndex: isStart,
      endIndex: oosEnd,
      isStart,
      isEnd,
      oosStart,
      oosEnd,
      inSample,
      outOfSample,
    });
  }

  const oos = windows.map((w) => w.outOfSample).filter(Boolean);
  const pfVals = oos
    .map((r) => r!.profitFactor)
    .filter((v) => Number.isFinite(v) && v > 0);
  const positiveEdge = oos.filter((r) => (r!.totalPnLPercent > 0 && r!.profitFactor >= 1) || (r!.expectancyR > 0)).length;

  return {
    windows,
    oosAggregate: {
      totalTrades: oos.reduce((a, r) => a + r!.totalTrades, 0),
      avgProfitFactor: Math.round(avg(pfVals) * 100) / 100,
      avgSharpe: Math.round(avg(oos.map((r) => r!.sharpeRatio)) * 100) / 100,
      avgSortino: Math.round(avg(oos.map((r) => r!.sortinoRatio)) * 100) / 100,
      avgMaxDrawdownPercent: Math.round(avg(oos.map((r) => r!.maxDrawdownPercent)) * 100) / 100,
      avgTotalPnLPercent: Math.round(avg(oos.map((r) => r!.totalPnLPercent)) * 100) / 100,
      avgExpectancyR: Math.round(avg(oos.map((r) => r!.expectancyR)) * 1000) / 1000,
      windowsWithPositiveEdge: positiveEdge,
      windowsTotal: oos.length,
    },
  };
}
