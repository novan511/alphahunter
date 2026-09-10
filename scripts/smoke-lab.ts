import { compositeScore, defaultLabCombos, rankLabRows } from '../lib/quant/labEngine';

const good = compositeScore({
  avgProfitFactor: 1.4,
  avgSharpe: 1.1,
  avgMaxDrawdownPercent: 5,
  avgTotalPnLPercent: 8,
  avgExpectancyR: 0.25,
  totalTrades: 40,
  windowsWithPositiveEdge: 2,
  windowsTotal: 3,
});
const thin = compositeScore({
  avgProfitFactor: 9,
  avgSharpe: 3,
  avgMaxDrawdownPercent: 1,
  avgTotalPnLPercent: 50,
  avgExpectancyR: 2,
  totalTrades: 3,
  windowsWithPositiveEdge: 1,
  windowsTotal: 3,
});
console.log('good', good);
console.log('thin lottery', thin);
console.log('good > thin?', good.score > thin.score);

const crypto = defaultLabCombos('crypto');
const gold = defaultLabCombos('gold-silver');
console.log('crypto combos', crypto.length, 'gold', gold.length);
console.log('sample', crypto[0].label);

const rows = rankLabRows([
  {
    comboId: 'a',
    marketId: 'crypto',
    label: 'A',
    presetId: 'binance-top',
    interval: '4h',
    risk: {},
    status: 'done',
    metrics: {
      fullPF: 1.2,
      fullSharpe: 0.8,
      fullMaxDD: 6,
      fullPnL: 5,
      fullTrades: 30,
      fullWinRate: 48,
      fullExpectancyR: 0.1,
      oosPF: 1.3,
      oosSharpe: 1.0,
      oosMaxDD: 5,
      oosPnL: 4,
      oosExpectancyR: 0.2,
      oosTrades: 25,
      oosPositiveWindows: 2,
      oosWindowsTotal: 3,
      compositeScore: good.score,
      credible: true,
    },
  },
]);
console.log('rank top', rows[0].label, rows[0].metrics?.compositeScore);
console.log('LAB_OK');
