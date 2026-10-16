import {
  buildPulseSnapshot,
  analysePulse,
  validatePulseOutput,
  guardPulseDirection,
  macroContextFromSnapshot,
  rulePulseFallback,
  PulseModelOutput,
} from '../lib/quant/marketPulse';
import { collectInputNumbers } from '../lib/quant/marketAnalyst';
import type { FuturesSignal, MacroSnapshot } from '../lib/futuresBook';

function sig(
  group: 'crypto' | 'commodity' | 'equity',
  symbol: string,
  name: string,
  verdict: 'long' | 'short' | 'wait',
  score: number,
  changePct: number,
  price: number
): FuturesSignal {
  return {
    instrument: { rawId: `x:${symbol}`, symbol, name, group, id: symbol, asset: { id: symbol } },
    verdict,
    score,
    changePct,
    price,
    reasons: ['momentum'],
    macroNote: 'Macro: netral.',
  } as unknown as FuturesSignal;
}

const signals: FuturesSignal[] = [
  sig('crypto', 'BTC', 'Bitcoin', 'long', 72, 2.1, 67234.5),
  sig('crypto', 'ETH', 'Ethereum', 'wait', 0, 0.4, 3100),
  sig('commodity', 'XAU', 'Emas', 'short', 55, -1.2, 4200),
  sig('equity', 'NVDA', 'Nvidia', 'long', 63, 1.4, 180),
  sig('equity', 'AAPL', 'Apple', 'long', 58, 0.8, 240),
];

const macro: MacroSnapshot = {
  dxy: 101.9,
  dxyChangePct: -0.15,
  vix: 16.4,
  vixChangePct: null,
  us10y: 5.09,
  fedFunds: 3.88,
  cpiYoY: 2.9,
  asOf: '2026-10-16',
  errors: [],
};

let failures = 0;
function expect(cond: boolean, label: string) {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${label}`);
  } else console.log(`ok: ${label}`);
}

async function main() {
  const snap = buildPulseSnapshot({ signals, macro, tf: '1h', missing: [] });
  const numbers = collectInputNumbers(snap);

  // 1. Grouping + bias across the three markets.
  const crypto = snap.markets.find((m) => m.market === 'crypto')!;
  const commodity = snap.markets.find((m) => m.market === 'commodities')!;
  const equity = snap.markets.find((m) => m.market === 'us_stocks')!;
  expect(crypto.longs === 1 && crypto.bias === 'up', 'crypto terkelompok dan bias up');
  expect(commodity.shorts === 1 && commodity.bias === 'down', 'komoditas bias down');
  expect(equity.longs === 2 && equity.bias === 'up', 'saham US bias up');
  expect(!!snap.macro?.dxy?.includes('101.9'), 'makro dikonversi ke MacroContext');

  // 2. Macro snapshot absent -> null.
  expect(macroContextFromSnapshot({ ...macro, dxy: null, dxyChangePct: null, vix: null, us10y: null, fedFunds: null, cpiYoY: null, asOf: null }) === null, 'tanpa data makro -> null');

  const good: PulseModelOutput = {
    marketRegime: 'Crypto dan saham US naik, komoditas turun — rotasi risk-on.',
    direction: 'prepare_long',
    conviction: 'medium',
    headline: 'Risk-on lintas-pasar; krypto 72 memimpin.',
    crossMarket: ['Crypto bias naik skor 72', 'Komoditas turun', 'Saham US naik'],
    macroRead: 'Data makro tersedia di input.',
    playbook: { long: 'Fokus pasar kuat di 67234.5', short: null, invalidation: 'Jika dolar menguat tajam.' },
    confidence: 65,
    caveats: ['contoh'],
  };

  // 3. Clean output passes.
  expect(validatePulseOutput(JSON.stringify(good), numbers).ok, 'output pulse bersih lolos');

  // 4. Hallucinated number rejected.
  expect(!validatePulseOutput(JSON.stringify({ ...good, headline: 'Naik ke 99999.' }), numbers).ok, 'angka karangan ditolak');

  // 5. Trade instruction rejected.
  expect(!validatePulseOutput(JSON.stringify({ ...good, headline: 'Kamu harus membeli sekarang.' }), numbers).ok, 'perintah beli ditolak');

  // 6. prepare_long against a bearish field is refused.
  const bearish = snap.markets.map((m) => ({ ...m, bias: 'down' as const }));
  expect(guardPulseDirection(good, bearish).direction === 'wait', 'prepare_long melawan pasar turun diturunkan');

  // 7. Low conviction cannot be directional.
  expect(guardPulseDirection({ ...good, conviction: 'low' }, snap.markets).direction === 'wait', 'conviction rendah diturunkan');

  // 8. Fallback passes the same validator.
  const fb = rulePulseFallback(snap);
  expect(fb.source === 'rule_fallback', 'fallback menandai dirinya sendiri');
  expect(
    validatePulseOutput(JSON.stringify({ ...fb, source: undefined, model: undefined, directionReason: undefined }), numbers).ok,
    'fallback lolos validator'
  );

  // 9. E2E: clean model output -> llm source.
  const e2e = await analysePulse(snap, { call: async () => JSON.stringify(good) });
  expect(e2e.source === 'llm', 'pulse pakai sumber llm saat valid');
  expect(e2e.direction === 'prepare_long', 'direction dipertahankan');

  // 10. E2E: malformed snapshot never reaches the model.
  const bad = await analysePulse({ ...snap, markets: [] } as unknown as typeof snap, {
    call: async () => JSON.stringify(good),
  });
  expect(bad.source === 'rule_fallback', 'snapshot buruk tidak memanggil model');

  // 11. Overlong playbook prose is clipped instead of discarding the analysis.
  const verbose = JSON.stringify({
    ...good,
    playbook: { ...good.playbook, long: 'Skenario panjang. '.repeat(30) },
  });
  const clipped = validatePulseOutput(verbose, numbers);
  expect(clipped.ok, 'playbook kepanjangan tidak menolak output');
  expect(
    clipped.ok && (clipped.value.playbook.long ?? '').length <= 200,
    'playbook dipotong sampai batas 200 karakter'
  );
  const verboseE2e = await analysePulse(snap, { call: async () => verbose });
  expect(verboseE2e.source === 'llm', 'analisis AI tetap dipakai saat playbook verbose');

  if (failures > 0) {
    console.error(`PULSE_SMOKE_FAIL (${failures})`);
    process.exit(1);
  }
  console.log('PULSE_SMOKE_OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
