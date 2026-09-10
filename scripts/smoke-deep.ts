import { fetchBinanceKlines } from '../lib/api';
import { fetchYahooChart } from '../lib/yahoo';

async function main() {
  const t0 = Date.now();
  const btc1d = await fetchBinanceKlines('BTCUSDT', '1d', 1500, { deep: true });
  const gc = await fetchYahooChart('GC=F', '1d', '10y', { deep: true });
  console.log(
    'btc1d bars',
    btc1d.length,
    'span_days',
    Math.round((btc1d[btc1d.length - 1].time - btc1d[0].time) / 86400)
  );
  console.log(
    'gc bars',
    gc.length,
    'span_days',
    Math.round((gc[gc.length - 1].time - gc[0].time) / 86400)
  );
  console.log('ms', Date.now() - t0);
  console.log('DEEP_OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
