import { generateQuantSignals } from '../lib/quant/signals';
import { parseAssetId, fetchAssetCandles } from '../lib/marketData';

async function main() {
  const gold = parseAssetId('yahoo:GC=F');
  const eth = parseAssetId('binance:ETHUSDT');
  const btc = parseAssetId('binance:BTCUSDT');

  const [gc, e, b] = await Promise.all([
    fetchAssetCandles(gold, '1d', 80),
    fetchAssetCandles(eth, '4h', 80),
    fetchAssetCandles(btc, '4h', 80),
  ]);
  const gs = generateQuantSignals(gold, gc, null, null, '1d');
  const es = generateQuantSignals(eth, e, btc, b, '4h');
  console.log('gold signals', gs.length, 'tail', gs.slice(-3).map((s) => `${s.type}@${s.strength}`));
  console.log('eth signals', es.length, 'tail', es.slice(-3).map((s) => `${s.type}@${s.strength}`));
  console.log('SIGNAL_SMOKE_OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
