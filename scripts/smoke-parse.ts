import { parseAssetId } from '../lib/marketData';

const samples = [
  'SOLUSDT (BINANCE)',
  'binance:BTCUSDT',
  'ETH/USDT',
  'BTCUSDT',
  'yahoo:GC=F',
  'hyperliquid:HYPE',
];
for (const s of samples) {
  const a = parseAssetId(s);
  console.log(JSON.stringify({ input: s, id: a.id, source: a.source, symbol: a.symbol }));
}
