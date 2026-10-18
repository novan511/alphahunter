/**
 * Probe: jalankan jalur penilaian kalibrasi pada candle NYATA, sekarang.
 *
 * Ini bukan bagian dari pipeline — ia menjawab satu pertanyaan yang tidak bisa
 * dijawab oleh self-check ber-fixture: "apakah level dan first-touch benar-benar
 * bekerja pada data pasar yang asli?" (Fixture pernah membuat penilaian yang
 * mati terlihat hijau, karena satuan waktu yang salah.)
 *
 * Jalankan: npx tsc scripts/probe-calibration-live.ts --outDir /tmp/probe \
 *   --module commonjs --target es2020 --skipLibCheck --esModuleInterop \
 *   && node /tmp/probe/scripts/probe-calibration-live.js
 */

import { fetchKlinesRouted } from '../lib/universe';
import { atr } from '../lib/algorithms/indicators';
import { levelsFor, firstTouch, MAX_HOLD_SEC } from '../lib/signalLevels';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
/** Dua usia emit: yang masih berjalan, dan yang jendela 7 harinya sudah lewat. */
const AGES: { label: string; bars: number }[] = [
  { label: '~3 hari lalu', bars: 18 },
  { label: '~6,7 hari lalu', bars: 40 },
];

async function main() {
  const nowSec = Math.floor(Date.now() / 1000);

  for (const age of AGES) {
    console.log(`\n=== Sinyal disimulasikan keluar ${age.label} ===`);
    await runAge(age.bars, nowSec);
  }

  console.log(
    '\nCatatan: target/stop = kena duluan, open = keluar waktu di hari ke-7,' +
      ' lost = jalur candle-nya tidak utuh (sengaja tidak dinilai),' +
      ' "belum diputuskan" = belum ada yang tersentuh dan jendelanya belum habis.'
  );
}

async function runAge(barsAgo: number, nowSec: number) {
  for (const symbol of SYMBOLS) {
    const candles = await fetchKlinesRouted(symbol, '4h', 200);
    if (candles.length < 40) {
      console.log(`${symbol}: candle tidak cukup (${candles.length})`);
      continue;
    }

    // Simulasikan sinyal yang keluar beberapa hari lalu, dengan ATR bar itu juga —
    // persis seperti yang disimpan ledger saat emit.
    const idx = candles.length - 1 - barsAgo;
    const entry = candles[idx].close;
    const atrSeries = atr(candles.slice(0, idx + 1), 14);
    const entryAtr = atrSeries[atrSeries.length - 1];
    const emittedSec = candles[idx].time + 60; // di tengah bar, seperti cron asli

    const levels = levelsFor('long', entry, entryAtr);
    if (!levels) {
      console.log(`${symbol}: entry/atr tidak layak (entry=${entry}, atr=${entryAtr})`);
      continue;
    }

    const res = firstTouch(candles, 'long', entry, levels.stop, levels.target, emittedSec, {
      nowSec,
      holdSec: MAX_HOLD_SEC,
    });

    const fmt = (x: number) => (x >= 100 ? x.toFixed(2) : x.toPrecision(4));
    console.log(
      `${symbol.padEnd(9)} entry ${fmt(entry).padStart(10)}  stop ${fmt(levels.stop).padStart(10)}` +
        `  target ${fmt(levels.target).padStart(10)}  atr ${fmt(entryAtr).padStart(9)}` +
        `  →  ${res ? `${res.outcome} ${res.r == null ? '' : `${res.r >= 0 ? '+' : ''}${res.r.toFixed(2)}R`}` : 'belum diputuskan'}` +
        `  (${res ? `${res.bars} bar` : 'masih di dalam jendela'})`
    );
  }
}

main().catch((err) => {
  console.error('probe gagal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
