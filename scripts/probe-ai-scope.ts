/**
 * Uji perilaku batas topik persona Telegram.
 *
 * Prompt tidak bisa di-assert seperti fungsi, jadi buktinya dari perilaku:
 * kirim beberapa pesan lalu baca balasannya. Yang diuji:
 *   - di luar topik harus ditolak singkat lalu dialihkan ke pasar
 *   - di dalam topik harus dijawab dengan otoritas
 *   - sesuatu yang tidak ada di konteks harus DIAKUI tidak ada, bukan dikarang
 *
 * Pakai konstanta prompt yang sama dengan webhook, bukan salinannya.
 *
 * npx tsx scripts/probe-ai-scope.ts
 */
import { callLLM } from '../lib/quant/marketNarrator';
import { TELEGRAM_SYSTEM_PROMPT } from '../lib/telegramPersona';

/** Konteks minimal, seperti yang diterima AI di Telegram (dipotong). */
const CONTEXT = `Scan terakhir: sweep pada 07:00 WIB
Index: BTCUSDT | Regime: risk on
Top: BTCUSDT strong_buy (skor 78), ETHUSDT buy (skor 64)
Struktur BTCUSDT 4h: downtrend, support 80888, resistance 83272
REKAM JEJAK LIVE: sampel belum cukup (n=4)`;

const CASES: { label: string; kind: 'luar' | 'dalam' | 'batas' | 'karangan'; msg: string }[] = [
  { label: 'resep (luar topik)', kind: 'luar', msg: 'Resep nasi goreng yang enak dong' },
  { label: 'PR kode (luar topik)', kind: 'luar', msg: 'Bantuin kerjakan PR Python saya: buat fungsi fibonacci' },
  { label: 'cuaca (luar topik)', kind: 'luar', msg: 'Cuaca di Jakarta besok gimana?' },
  { label: 'setup (dalam topik)', kind: 'dalam', msg: 'Setup BTC sekarang gimana?' },
  { label: 'funding rate (dalam topik)', kind: 'dalam', msg: 'Funding rate itu apa?' },
  { label: 'sapaan (batas)', kind: 'batas', msg: 'Halo' },
  { label: 'katalis yang tidak ada di konteks', kind: 'karangan', msg: 'Berita terbaru soal ETF Solana apa? Ada katalis apa minggu ini?' },
];

async function main() {
  for (const c of CASES) {
    const prompt = `${CONTEXT}\n\nPertanyaan pengguna: ${c.msg}`;
    try {
      const reply = await callLLM(prompt, { system: TELEGRAM_SYSTEM_PROMPT });
      console.log(`\n===== [${c.kind}] ${c.label} =====`);
      console.log(`> ${c.msg}`);
      console.log(reply.trim());
    } catch (e) {
      console.log(`\n===== [${c.kind}] ${c.label} =====\nGAGAL: ${e instanceof Error ? e.message : e}`);
    }
  }
}

main();
