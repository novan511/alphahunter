import { runPortfolioBacktest } from '../lib/quant/portfolioBacktest';
import { runWalkForward } from '../lib/quant/walkForward';
import { DEFAULT_QUANT_RISK } from '../lib/quant/risk';

function makeCandles(n: number, base: number, drift: number) {
  const out: { time: number; open: number; high: number; low: number; close: number; volume: number }[] = [];
  let t = 1700000000;
  let px = base;
  for (let i = 0; i < n; i++) {
    const noise = (Math.sin(i / 7) + Math.cos(i / 13)) * 0.01;
    px = px * (1 + drift + noise * 0.02);
    const high = px * 1.01;
    const low = px * 0.99;
    out.push({ time: t, open: px, high, low, close: px, volume: 1000 + Math.abs(noise) * 5000 });
    t += 14400;
  }
  return out;
}

const candles = makeCandles(200, 100, 0.001);
const signals = [
  {
    time: candles[40].time,
    price: candles[40].close,
    type: 'buy' as const,
    strength: 6,
    rsZScore: 2,
    indexReturn: -2,
    assetReturn: 1,
    volumeRatio: 2,
    reason: 'test',
  },
  {
    time: candles[80].time,
    price: candles[80].close,
    type: 'buy' as const,
    strength: 5,
    rsZScore: 1.5,
    indexReturn: -1.5,
    assetReturn: 0.8,
    volumeRatio: 1.8,
    reason: 'test',
  },
];

const assets = [
  { symbol: 'AAAUSDT', candles, signals },
  { symbol: 'BBBUSDT', candles: makeCandles(200, 50, 0.0015), signals: [] },
];

const risk = { ...DEFAULT_QUANT_RISK, maxPortfolioDrawdownPct: 0.5 };
const full = runPortfolioBacktest(assets, risk);
const wf = runWalkForward(assets, risk, { oosWindows: 2 });

console.log(
  JSON.stringify(
    {
      trades: full.totalTrades,
      pf: full.profitFactor,
      sharpe: full.sharpeRatio,
      pnl: full.totalPnLPercent,
      dd: full.maxDrawdownPercent,
      wfWindows: wf.windows.length,
      oosPf: wf.oosAggregate.avgProfitFactor,
    },
    null,
    2
  )
);

if (full.totalTrades < 1) {
  console.error('SMOKE_FAIL: expected at least 1 trade');
  process.exit(1);
}
console.log('SMOKE_OK');
