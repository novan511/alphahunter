/**
 * Health check lapisan data: apakah tiap sumber benar-benar mengembalikan candle
 * sekarang? Jalankan saat scan mulai aneh (`[kline-fail]`, `[budget-abort]`).
 *
 * Ini perlu ada karena dua mode kegagalan di sini SENYAP:
 *   - sumber mengembalikan HTTP 400 untuk semua simbol (rentang waktu salah),
 *     sehingga hasilnya cuma "tidak ada data" dan router diam-diam pindah sumber;
 *   - error yang muncul di log berasal dari host cadangan terakhir, bukan dari
 *     penyebab sebenarnya, jadi pesannya menyesatkan.
 *
 * npx tsc scripts/probe-sources.ts --outDir /tmp/srcprobe --module commonjs \
 *   --target es2020 --skipLibCheck --esModuleInterop \
 *   && node --env-file=.env.local /tmp/srcprobe/scripts/probe-sources.js
 */

import { fetchGateCandles } from '../lib/marketData';
import { fetchBinanceKlines } from '../lib/api';
import { fetchKlinesRouted, getUniverse, lookupUniverseEntry } from '../lib/universe';
import { assertFresh } from '../lib/dataHealth';

let failures = 0;

async function timed(label: string, fn: () => Promise<unknown>) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    console.log(`  ok    ${label}  ${Date.now() - t0}ms  ${detail}`);
  } catch (err) {
    const e = err as { message?: string; cause?: unknown };
    const cause = e.cause as { code?: string } | undefined;
    failures++;
    console.log(
      `  FAIL  ${label}  ${Date.now() - t0}ms  ${e.message}${cause ? ` cause=${cause.code}` : ''}`
    );
  }
}

async function main() {
  console.log('Sumber data — apakah candle benar-benar datang?');
  // 20 bar 1h dan 200 bar 4h: rentang yang dipakai scan. Rentang yang salah
  // (mis. ms vs detik) tidak menghasilkan error jaringan, hanya HTTP 400.
  await timed('gate BTC_USDT 1h x20', async () =>
    assertFresh(await fetchGateCandles('BTC_USDT', '1h', 20))
  );
  await timed('gate BTC_USDT 4h x200', async () =>
    assertFresh(await fetchGateCandles('BTC_USDT', '4h', 200))
  );
  await timed('binance BTCUSDT 1h x20', async () =>
    assertFresh(await fetchBinanceKlines('BTCUSDT', '1h', 20))
  );

  await getUniverse().catch(() => null);
  const gateOnly = ['ZEUSUSDT', 'PONSUSDT'].find((s) => lookupUniverseEntry(s)?.source === 'gate');
  if (gateOnly) {
    await timed(`routed ${gateOnly} 1h x20 (gate-only)`, async () =>
      assertFresh(await fetchKlinesRouted(gateOnly, '1h', 20))
    );
  }
  // Simbol yang tidak ada di Binance: harus gagal CEPAT dengan alasan yang
  // jujur (status HTTP-nya), bukan mencoba host cadangan yang diblokir lalu
  // melaporkan ECONNREFUSED setelah beberapa detik.
  const t0 = Date.now();
  try {
    await fetchBinanceKlines('SIMBOLTIDAKADAUSDT', '1h', 20);
    failures++;
    console.log('  FAIL  binance simbol tidak ada malah berhasil');
  } catch (err) {
    const ms = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    const honest = /Binance API error for SIMBOLTIDAKADAUSDT: 4\d\d/.test(msg);
    if (honest && ms < 3000) {
      console.log(`  ok    binance simbol tidak ada  ${ms}ms  ${msg}`);
    } else {
      failures++;
      console.log(`  FAIL  binance simbol tidak ada  ${ms}ms  ${msg} (harus "400" dan cepat)`);
    }
  }

  console.log(failures === 0 ? '\nSOURCES_OK' : `\n${failures} sumber bermasalah`);
  if (failures > 0) process.exit(1);
}

main();
