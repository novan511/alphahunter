import { parseFredLatest, buildLiquidityNote } from '../lib/quant/macroData';

let failures = 0;
function expect(cond: boolean, label: string) {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${label}`);
  } else console.log(`ok: ${label}`);
}

// 1. FRED CSV parsing takes the latest non-empty value.
const csv = 'observation_date,DFF\n2026-10-12,3.88\n2026-10-13,3.88\n2026-10-14,3.88\n';
expect(parseFredLatest(csv) === 3.88, 'FRED: ambil nilai terakhir');
expect(parseFredLatest('d,v\n2026-01-01,1.5\n2026-01-02,.\n') === 1.5, 'FRED: lewati baris kosong');
expect(parseFredLatest('d,v\n') === null, 'FRED: kosong -> null');

// 2. Derived liquidity note reflects VIX level, dollar and equity direction.
const calm = buildLiquidityNote(13, -0.3, 0.5) || '';
expect(calm.includes('tenang'), 'catatan: VIX rendah -> tenang');
expect(calm.includes('dolar melemah'), 'catatan: DXY turun -> dolar melemah');
expect(calm.includes('risk-on'), 'catatan: S&P naik -> risk-on');

const fear = buildLiquidityNote(30, 0.2, -0.4) || '';
expect(fear.includes('cemas'), 'catatan: VIX tinggi -> cemas');
expect(fear.includes('dolar menguat'), 'catatan: DXY naik -> dolar menguat');
expect(fear.includes('risk-off'), 'catatan: S&P turun -> risk-off');

expect(buildLiquidityNote(null, null, null) === undefined, 'catatan: tanpa data -> undefined');

if (failures > 0) {
  console.error(`MACRO_SMOKE_FAIL (${failures})`);
  process.exit(1);
}
console.log('MACRO_SMOKE_OK');
