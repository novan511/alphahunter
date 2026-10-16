import {
  analyse,
  validateAnalystOutput,
  guardDirection,
  macroGuard,
  ruleAnalystFallback,
  collectInputNumbers,
  AnalystSnapshot,
  AnalystModelOutput,
} from '../lib/quant/marketAnalyst';

function snapshot(macro: AnalystSnapshot['macro']): AnalystSnapshot {
  return {
    generatedAt: Date.now(),
    indexSymbol: 'BTCUSDT',
    market: 'crypto',
    macro,
    regime: { regime: 'accumulation', confidence: 72 },
    timeframes: [
      { tf: '1w', trend: 'up', structure: 'higher_highs', keyLevel: 64000, rsi: 61 },
      { tf: '1d', trend: 'up', structure: 'higher_highs', keyLevel: 66500, rsi: 58 },
      { tf: '4h', trend: 'up', structure: 'consolidation', keyLevel: 67200, rsi: 55 },
      { tf: '1h', trend: 'range', structure: 'consolidation', keyLevel: 67000, rsi: 52 },
    ],
    crossAsset: [{ asset: 'ETHUSDT', direction: 'up', changePct: 2.1 }],
    liquidity: { longs: 62, shorts: 38 },
    warnings: [{ severity: 'low', title: 'Funding netral', detail: 'funding 0.01%' }],
  };
}

const macro = {
  asOf: '2026-10-16',
  fedFundRate: '4.25-4.50% (hold)',
  dxy: '104.2',
  vix: '14.2',
  upcomingEvents: ['CPI AS Rabu'],
};

const good: AnalystModelOutput = {
  direction: 'prepare_long',
  conviction: 'medium',
  headline: 'Bias HTF naik, confidence 72.',
  thesis: '1w dan 1d uptrend; RSI 61.',
  topDown: ['1w uptrend, support 64000', '1d uptrend, support 66500'],
  macroRead: 'Fed hold 4.25-4.50%, DXY 104.2.',
  playbook: { long: 'Konfirmasi di atas 67200.', short: null, invalidation: 'Batalkan di bawah 66500.' },
  confidence: 65,
  caveats: ['CPI bisa mengubah sentimen'],
};

let failures = 0;
function expect(cond: boolean, label: string) {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${label}`);
  } else console.log(`ok: ${label}`);
}

async function main() {
  const snap = snapshot(macro);
  const numbers = collectInputNumbers(snap);

  // 1. Clean directional output passes.
  const goodCheck = validateAnalystOutput(JSON.stringify(good), numbers);
  expect(goodCheck.ok, 'output analyst bersih lolos validator');

  // 2. Hallucinated number rejected.
  const hallucinated = { ...good, thesis: '1w dan 1d uptrend; RSI 61, target 99999.' };
  expect(!validateAnalystOutput(JSON.stringify(hallucinated), numbers).ok, 'angka karangan ditolak');

  // 3. Promise of returns rejected.
  const promise = { ...good, thesis: 'Ini dijamin profit 100% aman.' };
  expect(!validateAnalystOutput(JSON.stringify(promise), numbers).ok, 'janji hasil ditolak');

  // 4. Bad direction enum rejected.
  expect(!validateAnalystOutput(JSON.stringify({ ...good, direction: 'bullish' }), numbers).ok, 'direction di luar enum ditolak');

  // 5. Direction may not fight the higher timeframe.
  const fightHTF = guardDirection({ ...good, direction: 'prepare_short' }, snap.timeframes);
  expect(fightHTF.direction === 'wait', 'prepare_short melawan HTF naik diturunkan ke wait');

  // 6. Low conviction cannot be directional.
  const lowConv = guardDirection({ ...good, conviction: 'low' }, snap.timeframes);
  expect(lowConv.direction === 'wait', 'conviction rendah diturunkan ke wait');

  // 7. No macro input => must declare unavailable, may not name events.
  expect(macroGuard('Data makro tidak tersedia.', null).ok, 'pernyataan tidak-tersedia diterima');
  expect(!macroGuard('Fed akan menaikkan suku bunga.', null).ok, 'klaim makro tanpa data ditolak');
  expect(macroGuard('Fed hold 4.25-4.50%, DXY 104.2.', macro).ok, 'baca makro dari input diterima');

  // 8. Rule fallback is shaped correctly.
  const fb = ruleAnalystFallback(snapshot(null));
  expect(fb.source === 'rule_fallback', 'fallback menandai dirinya sendiri');
  const fbCheck = validateAnalystOutput(
    JSON.stringify({ ...fb, source: undefined, model: undefined, directionReason: undefined }),
    collectInputNumbers(snapshot(null))
  );
  expect(fbCheck.ok, 'fallback lolos validator yang sama');

  // 9. End-to-end: clean model output -> llm source.
  const e2e = await analyse(snapshot(macro), { call: async () => JSON.stringify(good) });
  expect(e2e.source === 'llm', 'analisis pakai sumber llm saat valid');
  expect(e2e.direction === 'prepare_long', 'direction dipertahankan di e2e');

  // 10. End-to-end: hallucinating model falls back cleanly.
  const e2eBad = await analyse(snapshot(macro), { call: async () => JSON.stringify(hallucinated) });
  expect(e2eBad.source === 'rule_fallback', 'analisis jatuh ke fallback saat output ditolak');
  expect(!!e2eBad.directionReason, 'alasan fallback tercatat');

  if (failures > 0) {
    console.error(`ANALYST_SMOKE_FAIL (${failures})`);
    process.exit(1);
  }
  console.log('ANALYST_SMOKE_OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
