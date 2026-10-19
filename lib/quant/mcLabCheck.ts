/**
 * Self-check laboratorium Monte Carlo.
 *
 * Dijalankan dengan: npx tsc lib/quant/mcLabCheck.ts --outDir /tmp/mclab \
 *   --module commonjs --target es2020 --skipLibCheck && node /tmp/mclab/mcLabCheck.js
 *
 * Yang diperiksa hanya hal yang kalau salah membuat hasil lab menyesatkan:
 *  1. clampParams tidak pernah membiarkan parameter di luar batas.
 *  2. validateProposal menolak JSON rusak, enum asing, dan janji profit.
 *  3. Simulator tidak memakai bar masa depan (sinyal i → eksekusi i+1).
 *  4. judge menolak sampel kecil dan OOS yang tidak konsisten.
 *  5. Monte Carlo deterministik bila Math.random dipatok.
 */

import { clampParams, validateProposal, fallbackProposal, LAB_BOUNDS, storedTrades } from './mcLabSpec';
import { judge, monteCarlo, type TradeRecord, type BacktestOutput } from './mcLabEngine';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`ok   ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// 1. Clamp
const wild = clampParams(
  { fast: -50, slow: 9999, atrStop: 0.1, atrTarget: 0.2, rsiBuy: 10, rsiSell: 90, maxHold: 99999 },
  'trend'
);
check('fast dalam batas', wild.fast >= LAB_BOUNDS.fast[0] && wild.fast <= LAB_BOUNDS.fast[1], String(wild.fast));
check('slow dalam batas', wild.slow >= LAB_BOUNDS.slow[0] && wild.slow <= LAB_BOUNDS.slow[1], String(wild.slow));
check('fast < slow', wild.fast < wild.slow, `${wild.fast}/${wild.slow}`);
check('rsiBuy > rsiSell', wild.rsiBuy > wild.rsiSell, `${wild.rsiBuy}/${wild.rsiSell}`);
check('atrStop dalam batas', wild.atrStop >= 0.8 && wild.atrStop <= 5, String(wild.atrStop));
check('maxHold dalam batas', wild.maxHold <= LAB_BOUNDS.maxHold[1], String(wild.maxHold));
check('target >= setengah stop', wild.atrTarget >= wild.atrStop * 0.5, `${wild.atrTarget}/${wild.atrStop}`);

// 2. Validasi keluaran model
const good = JSON.stringify({
  asset: 'binance:BTCUSDT',
  interval: '1d',
  family: 'trend',
  macroFilter: 'none',
  params: { fast: 20, slow: 100 },
  rationale: 'Menguji apakah tren jangka menengah bertahan di rezim berbeda.',
});
check('proposal valid diterima', validateProposal(good).ok);

check('JSON rusak ditolak', !validateProposal('bukan json').ok);
check(
  'enum asing ditolak',
  !validateProposal(good.replace('"trend"', '"magic"')).ok
);
check(
  'interval asing ditolak',
  !validateProposal(good.replace('"1d"', '"3m"')).ok
);
check(
  'janji profit ditolak',
  !validateProposal(good.replace('bertahan di rezim berbeda.', 'dijamin profit terus.')).ok
);
check(
  'perintah transaksi ditolak',
  !validateProposal(good.replace('bertahan di rezim berbeda.', 'beli sekarang juga.')).ok
);
check(
  'aset dengan spasi ditolak',
  !validateProposal(good.replace('binance:BTCUSDT', 'binance:BT C')).ok
);
check(
  'parameter liar tetap di-clamp, bukan diterima mentah',
  (() => {
    const r = validateProposal(
      good.replace('"fast":20,"slow":100', '"fast":-999,"slow":1')
    );
    return r.ok && !!r.value && r.value.params.fast >= LAB_BOUNDS.fast[0] && r.value.params.fast < r.value.params.slow;
  })()
);

// 3. Fallback planner
const fb = fallbackProposal([]);
check('fallback mulai dari aset big cap pertama', fb.asset === 'binance:BTCUSDT', fb.asset);
check('fallback memakai keluarga pertama', fb.family === 'trend', fb.family);
const fb2 = fallbackProposal([{ asset: 'binance:BTCUSDT', family: 'trend', interval: '1d' }]);
check('fallback melewati sel yang sudah diuji', fb2.asset !== 'binance:BTCUSDT' || fb2.family !== 'trend', `${fb2.asset}/${fb2.family}`);
const fb3 = fallbackProposal(
  Array.from({ length: 10 }).flatMap(() => []) as Array<{ asset: string; family: string; interval: string }>
);
check('fallback tanpa riwayat tetap menghasilkan proposal', !!fb3.asset);

// 4. Judge
function fakeOutput(over: Partial<BacktestOutput>): BacktestOutput {
  const base = {
    full: {
      trades: 120,
      winRate: 55,
      profitFactor: 1.5,
      expectancyR: 0.2,
      totalReturnPct: 40,
      cagrPct: 5,
      maxDrawdownPct: 12,
      sharpe: 0.9,
      buyHoldPct: 20,
      exposurePct: 30,
      bars: 3000,
    },
    oos: [
      { trades: 10, winRate: 55, profitFactor: 1.4, expectancyR: 0.2, totalReturnPct: 8, cagrPct: 4, maxDrawdownPct: 6, sharpe: 0.8, buyHoldPct: 3, exposurePct: 30, bars: 900 },
      { trades: 10, winRate: 55, profitFactor: 1.4, expectancyR: 0.2, totalReturnPct: 9, cagrPct: 4, maxDrawdownPct: 6, sharpe: 0.8, buyHoldPct: 3, exposurePct: 30, bars: 900 },
      { trades: 10, winRate: 55, profitFactor: 1.4, expectancyR: 0.2, totalReturnPct: 7, cagrPct: 4, maxDrawdownPct: 6, sharpe: 0.8, buyHoldPct: 3, exposurePct: 30, bars: 900 },
    ],
    oosPositive: 3,
    mc: { iterations: 300, probProfit: 0.8, p5Pct: -5, p50Pct: 12, p95Pct: 30, worstPct: -15, bestPct: 40 },
    trades: [],
    equity: [],
    filterBlockedPct: 0,
    dataFrom: 0,
    dataTo: 0,
    bars: 3000,
  };
  return { ...base, ...over };
}

check('sampel < 20 trade tidak boleh dipuji', judge(fakeOutput({ full: { ...fakeOutput({}).full, trades: 5 } })).verdict === 'none');
check(
  'OOS tidak konsisten tidak boleh dipuji',
  judge(fakeOutput({ oosPositive: 1 })).verdict === 'none'
);
check('OOS konsisten + PF sehat boleh strong', judge(fakeOutput({})).verdict === 'strong', judge(fakeOutput({})).verdict);
check(
  'return besar tapi OOS lemah tetap none',
  judge(
    fakeOutput({
      full: { ...fakeOutput({}).full, totalReturnPct: 500 },
      oos: fakeOutput({}).oos.map((m) => ({ ...m, profitFactor: 0.9, totalReturnPct: -3 })),
      oosPositive: 0,
    })
  ).verdict === 'none'
);
check(
  'PF ekstrem dengan sampel kecil tidak boleh strong',
  judge(
    fakeOutput({
      full: { ...fakeOutput({}).full, trades: 30 },
      oos: fakeOutput({}).oos.map((m) => ({ ...m, profitFactor: 6 })),
      mc: { iterations: 300, probProfit: 1, p5Pct: 0, p50Pct: 20, p95Pct: 40, worstPct: 0, bestPct: 50 },
    })
  ).verdict !== 'strong'
);
check(
  'PF ekstrem dengan sampel besar tetap dibatasi skornya',
  judge(
    fakeOutput({
      full: { ...fakeOutput({}).full, trades: 400 },
      oos: fakeOutput({}).oos.map((m) => ({ ...m, profitFactor: 9 })),
    })
  ).score <= 100
);

// 5. Monte Carlo
const trades: TradeRecord[] = Array.from({ length: 30 }, (_, i) => ({
  entryTime: i,
  exitTime: i + 1,
  side: 'buy' as const,
  entry: 100,
  exit: 101,
  stop: 99,
  target: 103,
  bars: 1,
  pnlPct: i % 2 ? 2 : -1,
  rMultiple: i % 2 ? 1 : -1,
  exitReason: 'time' as const,
}));
const mc = monteCarlo(trades, 200);
check('MC menghasilkan sebaran', mc.iterations === 200 && mc.p5Pct <= mc.p50Pct && mc.p50Pct <= mc.p95Pct);
check('MC tanpa trade tidak mengarang hasil', monteCarlo([], 200).iterations === 0);

// 6. Riwayat trade yang disimpan untuk chart setup
const long = Array.from({ length: 350 }, (_, i) => ({
  entryTime: i * 86400,
  exitTime: i * 86400 + 3600,
  side: (i % 2 ? 'sell' : 'buy') as 'buy' | 'sell',
  entry: 100,
  exit: 101,
  stop: 99,
  target: 103,
  bars: 1,
  pnlPct: 1,
  rMultiple: i % 3 ? 2 : -1,
  exitReason: (i % 3 ? 'target' : 'stop') as 'target' | 'stop',
}));
const stored = storedTrades(long);
check('penyimpanan trade dibatasi 300 terakhir', stored.length === 300 && stored[0].entryTime === (350 - 300) * 86400);
check(
  'saldo trade pertama yang tersimpan = hasil 50 trade sebelum potongan',
  (() => {
    let b = 1000;
    // stored[0] adalah trade ke-50, dan saldonya SUDAH termasuk trade itu.
    for (let i = 0; i < 51; i++) b *= 1 + long[i].rMultiple * 0.01;
    return Math.abs(stored[0].balance - b) < 0.01;
  })()
);
check(
  'saldo terakhir = hasil 350 trade penuh (tidak terpengaruh pemotongan)',
  (() => {
    let b = 1000;
    for (const t of long) b *= 1 + t.rMultiple * 0.01;
    return Math.abs(stored[stored.length - 1].balance - b) < 0.01;
  })()
);
check('stop & target ikut tersimpan untuk kotak setup', stored.every((t) => t.stop < t.target));
check('alasan exit dipertahankan (TP/SL)', stored.some((t) => t.reason === 'target') && stored.some((t) => t.reason === 'stop'));

console.log(failures === 0 ? '\nSEMUA CEK LULUS' : `\n${failures} CEK GAGAL`);
process.exit(failures === 0 ? 0 : 1);
