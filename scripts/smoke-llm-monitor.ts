import { computeSampleFlags, ruleFallbackReview, buildRiskPayload } from '../lib/quant/llmMonitor';
import type { QuantRunResult } from '../lib/quant/types';

const fake = {
  full: {
    profitFactor: 1.8,
    sharpeRatio: 1.5,
    totalTrades: 12,
    expectancyR: 0.2,
    maxDrawdownPercent: 3,
    totalPnLPercent: 8,
    winRate: 60,
    exposurePctAvg: 0.2,
    alpha: 2,
    haltedByDd: false,
  },
  walkForward: {
    oosAggregate: {
      totalTrades: 8,
      avgProfitFactor: 1.1,
      avgSharpe: 0.4,
      avgMaxDrawdownPercent: 4,
      avgTotalPnLPercent: 1,
      avgExpectancyR: -0.05,
      windowsWithPositiveEdge: 1,
      windowsTotal: 3,
    },
  },
  meta: { assetCount: 10, candleCount: 200, interval: '4h', generatedAt: Date.now() },
} as unknown as QuantRunResult;

const flags = computeSampleFlags(fake);
const payload = buildRiskPayload(fake, 'binance:BTCUSDT');
const text = ruleFallbackReview(payload);
console.log(JSON.stringify(flags, null, 2));
console.log('---');
console.log(text);
if (flags.credibility !== 'insufficient') {
  console.error('expected insufficient');
  process.exit(1);
}
console.log('MONITOR_SMOKE_OK');
