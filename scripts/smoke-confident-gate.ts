/**
 * Kunci semantik gerbang confident (lib/confidentGate.ts).
 *
 * Ambang di gerbang ini menentukan produk — apa yang dikirim ke Telegram dan
 * apa yang direkam ke rekam jejak. Angkanya masih tebangan awal, tapi
 * perubahannya HARUS terlihat: uji ini gagal jika ada yang mengubah ambang
 * tanpa menyadarinya.
 *
 * npx tsx scripts/smoke-confident-gate.ts
 */
import { isConfidentSignal } from '../lib/confidentGate';
import type { MultiTimeframeResult } from '../lib/algorithms/multiTimeframe';

function row(
  finalSignal: MultiTimeframeResult['finalSignal'],
  confluenceScore: number,
  agreement: number,
  conviction: number
): MultiTimeframeResult {
  return { finalSignal, confluenceScore, agreement, conviction } as MultiTimeframeResult;
}

let failures = 0;
function expect(name: string, actual: boolean, want: boolean) {
  if (actual === want) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name} → ${actual}, seharusnya ${want}`);
  }
}

console.log('Gerbang confident — ambang per regime:');

// strong_buy di ambang dasar (regime bertren)
expect('strong 78/0.80/0.65 bertren lolos', isConfidentSignal(row('strong_buy', 78, 0.8, 0.65), 'weak_trend_up'), true);
expect('strong 78/0.80/0.65 ranging gugur (butuh 80)', isConfidentSignal(row('strong_buy', 78, 0.8, 0.65), 'ranging'), false);
expect('strong 72/0.70/0.60 bertren lolos (tepat di ambang)', isConfidentSignal(row('strong_buy', 72, 0.7, 0.6), 'weak_trend_up'), true);
expect('strong 71/0.90/0.90 bertren gugur (skor di bawah)', isConfidentSignal(row('strong_buy', 71, 0.9, 0.9), 'weak_trend_up'), false);
expect('strong 90/0.69/0.90 bertren gugur (agreement di bawah)', isConfidentSignal(row('strong_buy', 90, 0.69, 0.9), 'weak_trend_up'), false);
expect('strong 90/0.90/0.59 bertren gugur (conviction di bawah)', isConfidentSignal(row('strong_buy', 90, 0.9, 0.59), 'weak_trend_up'), false);

// buy biasa
expect('buy 48/0.50/0.45 bertren lolos (tepat di ambang)', isConfidentSignal(row('buy', 48, 0.5, 0.45), 'strong_trend_up'), true);
expect('buy 48/0.50/0.45 ranging gugur (butuh 60)', isConfidentSignal(row('buy', 48, 0.5, 0.45), 'ranging'), false);
expect('buy 60/0.65/0.55 ranging lolos (tepat di ambang)', isConfidentSignal(row('buy', 60, 0.65, 0.55), 'ranging'), true);
expect('buy 59/0.99/0.99 ranging gugur', isConfidentSignal(row('buy', 59, 0.99, 0.99), 'ranging'), false);
expect('buy 47/0.90/0.90 bertren gugur', isConfidentSignal(row('buy', 47, 0.9, 0.9), 'strong_trend_down'), false);

// sinyal tanpa arah dan regime tidak dikenal → pakai ambang dasar
expect('neutral selalu gugur', isConfidentSignal(row('neutral', 99, 1, 1), 'ranging'), false);
expect('regime tidak diketahui pakai ambang dasar', isConfidentSignal(row('buy', 48, 0.5, 0.45)), true);

// simetri sell
expect('strong_sell 78/0.80/0.65 ranging gugur', isConfidentSignal(row('strong_sell', 78, 0.8, 0.65), 'ranging'), false);
expect('sell 60/0.65/0.55 ranging lolos', isConfidentSignal(row('sell', 60, 0.65, 0.55), 'ranging'), true);

console.log(failures === 0 ? '\nGATE_OK' : `\n${failures} uji gagal`);
if (failures > 0) process.exit(1);
