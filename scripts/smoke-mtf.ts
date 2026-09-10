import { buildMultiTfSnapshot } from '../lib/quant/paperMultiTf';
import { parseAssetId } from '../lib/marketData';

async function main() {
  const gold = parseAssetId('yahoo:GC=F');
  const eth = parseAssetId('binance:ETHUSDT');
  const btc = parseAssetId('binance:BTCUSDT');
  const t0 = Date.now();
  const snap = await buildMultiTfSnapshot([gold, eth], btc, '1d');
  console.log('ms', Date.now() - t0);
  console.log('assets', Object.keys(snap.latest));
  console.log(
    'hist bars',
    Object.fromEntries(Object.entries(snap.history).map(([k, v]) => [k, v.length]))
  );
  console.log(
    'signals',
    snap.signals.length,
    snap.signals.slice(0, 8).map((s) => `${s.symbol} ${s.type}@${s.strength}`)
  );
  console.log('MTF_OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
