import type { MultiTimeframeResult } from './algorithms/multiTimeframe';

/**
 * Gerbang confident: sinyal mana yang layak dikirim ke Telegram dan direkam
 * ke ledger. Satu tempat supaya scan-cron dan ujinya membaca angka yang sama.
 *
 * Angka di sini adalah TEBINGAN awal, bukan hasil pengukuran — rekam jejak
 * (ledger + kalibrasi R) yang kelak menilai mereka. Setiap perubahan ambang
 * wajib lewat scripts/smoke-confident-gate.ts agar perubahan semantik muncul
 * sebagai diff yang disengaja, bukan kebetulan.
 */

const THRESHOLDS = {
  // Ambang dasar untuk regime bertren: momentum 4h punya peluang jalan.
  base: {
    strong: { score: 72, agreement: 0.7, conviction: 0.6 },
    normal: { score: 48, agreement: 0.5, conviction: 0.45 },
  },
  // Di ranging, breakout 4h mati di dinding range — bukti momentum yang sama
  // harus lebih bulat sebelum boleh dikirim sebagai peluang.
  ranging: {
    strong: { score: 80, agreement: 0.8, conviction: 0.7 },
    normal: { score: 60, agreement: 0.65, conviction: 0.55 },
  },
} as const;

export function isConfidentSignal(
  r: MultiTimeframeResult,
  regime?: string | null
): boolean {
  const t = regime === 'ranging' ? THRESHOLDS.ranging : THRESHOLDS.base;
  if (r.finalSignal === 'strong_buy' || r.finalSignal === 'strong_sell') {
    return (
      r.confluenceScore >= t.strong.score &&
      r.agreement >= t.strong.agreement &&
      r.conviction >= t.strong.conviction
    );
  }
  if (r.finalSignal === 'buy' || r.finalSignal === 'sell') {
    return (
      r.confluenceScore >= t.normal.score &&
      r.agreement >= t.normal.agreement &&
      r.conviction >= t.normal.conviction
    );
  }
  return false;
}
