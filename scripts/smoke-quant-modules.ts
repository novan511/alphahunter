import { allocateMetaCapital, metaRiskScale } from '../lib/quant/metaAllocator';
import { detectSpikes } from '../lib/quant/spikeSignal';
import { createBanditState, pickStrategyUCB, updateBandit, banditSummary } from '../lib/quant/strategyBandit';
import { claimSymbol, releaseSymbol, isSymbolFree, resetClaims } from '../lib/quant/conflictGuard';
import { runStressTest } from '../lib/quant/stressTest';
import { evaluateEventFilter } from '../lib/quant/eventFilter';
import { Candle } from '../lib/types';

// Meta
const meta = allocateMetaCapital([
  { agentId: 'crypto', equity: 1010, capitalStart: 1000, pnlPercent: 1, winRate: 50, totalTrades: 12, maxDrawdownPct: 2, running: true },
  { agentId: 'commodities', equity: 980, capitalStart: 1000, pnlPercent: -2, winRate: 30, totalTrades: 10, maxDrawdownPct: 5, running: true },
  { agentId: 'gold-silver', equity: 1000, capitalStart: 1000, pnlPercent: 0, winRate: 40, totalTrades: 3, maxDrawdownPct: 1, running: true },
]);
console.log('meta weights', meta.weights, 'scale crypto', metaRiskScale(meta, 'crypto'));

// Spike
const candles: Candle[] = [];
let px = 100;
for (let i = 0; i < 40; i++) {
  const spike = i === 35;
  px = px * (spike ? 1.03 : 1.001);
  candles.push({
    time: 1700000000 + i * 3600,
    open: px,
    high: px * 1.01,
    low: px * 0.99,
    close: px,
    volume: spike ? 5000 : 100,
  });
}
const spikes = detectSpikes(candles);
console.log('spikes', spikes.length, spikes[spikes.length - 1]?.type);

// Bandit
let b = createBanditState();
const arm = pickStrategyUCB(b);
b = updateBandit(b, arm, 0.5);
console.log('bandit', arm, banditSummary(b));

// Guard
resetClaims();
console.log('claim1', claimSymbol('crypto', 'ETHUSDT', 'long', 5).ok);
console.log('claim2', claimSymbol('gold-silver', 'ETHUSDT', 'long', 4).ok);
releaseSymbol('ETHUSDT');
console.log('free', isSymbolFree('ETHUSDT'));

// Stress
const stress = runStressTest(
  Array.from({ length: 20 }, (_, i) => ({ pnl: i % 3 === 0 ? -5 : 8 })),
  { iterations: 200, scenario: 'all' }
);
console.log('stress mean%', stress.meanReturnPct, 'P(pos)%', stress.probabilityPositive);

// Event
console.log('event', evaluateEventFilter('commodities', new Date('2026-01-05')));

console.log('MODULES_OK');
