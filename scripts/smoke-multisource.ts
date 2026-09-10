import { fetchAssetCandles, parseAssetId } from '../lib/marketData';
import { getPresetById } from '../lib/marketData/presets';
import { generateQuantSignals } from '../lib/quant/signals';
import { runPortfolioBacktest } from '../lib/quant/portfolioBacktest';
import { DEFAULT_QUANT_RISK } from '../lib/quant/risk';

async function main() {
  const hl = parseAssetId('hyperliquid:HYPE');
  const gold = parseAssetId('yahoo:GC=F');
  const oil = parseAssetId('yahoo:CL=F');
  const btc = parseAssetId('binance:BTCUSDT');

  console.log('parse', { hl, gold, oil, btc });
  console.log('presets', ['binance-top', 'hyperliquid-majors', 'macro-commodities', 'multi-asset'].map((id) => getPresetById(id)?.name));

  const [hypeC, goldC, oilC, btcC] = await Promise.all([
    fetchAssetCandles(hl, '1d', 120),
    fetchAssetCandles(gold, '1d', 120),
    fetchAssetCandles(oil, '1d', 120),
    fetchAssetCandles(btc, '1d', 120),
  ]);

  console.log('bars', {
    hype: hypeC.length,
    gold: goldC.length,
    oil: oilC.length,
    btc: btcC.length,
  });
  console.log('last closes', {
    hype: hypeC[hypeC.length - 1]?.close,
    gold: goldC[goldC.length - 1]?.close,
    oil: oilC[oilC.length - 1]?.close,
    btc: btcC[btcC.length - 1]?.close,
  });

  const assets = [
    { symbol: hl.id, candles: hypeC, signals: generateQuantSignals(hl, hypeC, btc, btcC, '1d') },
    { symbol: gold.id, candles: goldC, signals: generateQuantSignals(gold, goldC, null, null, '1d') },
    { symbol: oil.id, candles: oilC, signals: generateQuantSignals(oil, oilC, null, null, '1d') },
  ];

  const risk = { ...DEFAULT_QUANT_RISK, interval: '1d', maxHoldBars: 20 };
  const result = runPortfolioBacktest(assets, risk);
  console.log('portfolio', {
    trades: result.totalTrades,
    pnl: result.totalPnLPercent,
    pf: result.profitFactor,
    signals: assets.map((a) => ({ id: a.symbol, n: a.signals.length })),
  });
  console.log('MULTI_SOURCE_SMOKE_OK');
}

main().catch((err) => {
  console.error('MULTI_SOURCE_SMOKE_FAIL', err);
  process.exit(1);
});
