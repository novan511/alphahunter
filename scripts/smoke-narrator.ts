import {
  narrate,
  validateModelOutput,
  guardAction,
  ruleNarratorFallback,
  collectNumbers,
  numbersIn,
  NarratorSnapshot,
  NarratorModelOutput,
} from '../lib/quant/marketNarrator';

function snapshot(): NarratorSnapshot {
  return {
    generatedAt: Date.now(),
    indexSymbol: 'BTCUSDT',
    regime: { regime: 'ranging', confidence: 64 },
    summary: { totalScanned: 120, buySignals: 12, sellSignals: 8, neutralSignals: 100 },
    topMovers: [
      { asset: 'SOLUSDT', direction: 'up', confluenceScore: 72, changePct: 4.5 },
      { asset: 'ETHUSDT', direction: 'down', confluenceScore: 30, changePct: -1.2 },
    ],
    sectorShifts: [{ sector: 'Layer 1', direction: 'heating', magnitude: 2 }],
    warnings: [{ severity: 'high', title: 'SOL decoupling', detail: 'confluence 72' }],
    recentHistory: [{ at: '2026-10-16T08:00:00Z', regime: 'ranging', buySignals: 10, sellSignals: 9 }],
  };
}

async function main() {
const snap = snapshot();
const numbers = collectNumbers(snap);

let failures = 0;

// 0. Number scanner: a range hyphen is not a minus sign, but a real negative is.
expect(
  JSON.stringify(numbersIn('66500-67000')) === JSON.stringify([66500, 67000]),
  'tanda hubung rentang tidak dibaca sebagai minus'
);
expect(numbersIn('-0.15%').includes(-0.15), 'angka negatif asli tetap terbaca');
function expect(cond: boolean, label: string) {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${label}`);
  } else {
    console.log(`ok: ${label}`);
  }
}

// 1. A clean output passes all guards and keeps the model's action.
const good: NarratorModelOutput = {
  severity: 'high',
  headline: 'Regime ranging; 12 sinyal naik dari 120 aset.',
  summary: '12 sinyal naik dan 8 turun; SOL naik 4.5%.',
  why: ['SOL naik 4.5%'],
  action: 'scan_now',
  confidence: 70,
  caveats: ['contoh'],
};
const goodCheck = validateModelOutput(JSON.stringify(good), numbers);
expect(goodCheck.ok, 'output bersih lolos validator');
if (goodCheck.ok) {
  expect(goodCheck.value.severity === 'high', 'severity dipertahankan');
}

// 2. Hallucinated number is rejected.
const hallucinated = { ...good, summary: '12 sinyal naik dan 999 turun.' };
expect(!validateModelOutput(JSON.stringify(hallucinated), numbers).ok, 'angka karangan ditolak');

// 3. Trade instruction is rejected.
const instruction = { ...good, headline: 'Kamu harus membeli SOL sekarang.' };
expect(!validateModelOutput(JSON.stringify(instruction), numbers).ok, 'perintah beli ditolak');

// 4. Promise of returns is rejected.
const promise = { ...good, summary: 'Ini dijamin profit 100% aman.' };
expect(!validateModelOutput(JSON.stringify(promise), numbers).ok, 'janji hasil ditolak');

// 5. Bad action enum is rejected.
expect(!validateModelOutput(JSON.stringify({ ...good, action: 'buy' }), numbers).ok, 'action di luar whitelist ditolak');

// 6. scan_now needs high/critical severity.
const lowScan = guardAction('scan_now', 'low', { now: 0, lastActionAt: null, cooldownMs: 1000 });
expect(lowScan.action === 'summarize', 'scan_now diturunkan saat severity rendah');

// 7. scan_now respects cooldown.
const cooled = guardAction('scan_now', 'high', { now: 1000, lastActionAt: 500, cooldownMs: 60_000 });
expect(cooled.action === 'summarize', 'scan_now diturunkan saat cooldown');

const cooledOk = guardAction('scan_now', 'high', { now: 61_000, lastActionAt: 0, cooldownMs: 60_000 });
expect(cooledOk.action === 'scan_now', 'scan_now lolos saat severity tinggi dan cooldown selesai');

// 8. The deterministic fallback is always shaped correctly.
const fallback = ruleNarratorFallback(snap);
expect(fallback.source === 'rule_fallback', 'fallback menandai dirinya sendiri');
expect(fallback.headline.length > 0 && fallback.summary.length > 0, 'fallback punya isi');
const fbCheck = validateModelOutput(JSON.stringify({ ...fallback, source: undefined, model: undefined, actionReason: undefined }), numbers);
expect(fbCheck.ok, 'fallback lolos validator yang sama');

// 9. End-to-end: good model output -> llm source, guarded action.
const e2e = await narrate(snap, {
  now: 0,
  lastActionAt: null,
  cooldownMs: 60_000,
  call: async () => JSON.stringify(good),
});
expect(e2e.source === 'llm', 'narasi pakai sumber llm saat valid');
expect(e2e.action === 'scan_now', 'aksi scan_now dipertahankan di e2e');

// 10. End-to-end: a model that hallucinates falls back cleanly.
const e2eBad = await narrate(snap, { call: async () => JSON.stringify(hallucinated) });
expect(e2eBad.source === 'rule_fallback', 'narasi jatuh ke fallback saat output ditolak');
expect(!!e2eBad.actionReason, 'alasan fallback tercatat');

// 11. End-to-end: malformed snapshot never reaches the model.
const e2eBadSnap = await narrate({ ...snap, generatedAt: 'nope' } as unknown as NarratorSnapshot, {
  call: async () => JSON.stringify(good),
});
expect(e2eBadSnap.source === 'rule_fallback', 'snapshot buruk tidak memanggil model');

if (failures > 0) {
  console.error(`NARRATOR_SMOKE_FAIL (${failures})`);
  process.exit(1);
}
console.log('NARRATOR_SMOKE_OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
