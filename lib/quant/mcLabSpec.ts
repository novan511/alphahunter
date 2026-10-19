/**
 * Spesifikasi eksperimen Monte Carlo otonom.
 *
 * File ini SENGAJA tidak mengimpor apa pun: ia adalah batas kepercayaan antara
 * model bahasa dan mesin backtest. Semua angka dari AI masuk lewat clampSpec,
 * semua teks masuk lewat validateProposal. Kalau aturan di sini longgar, satu
 * keluaran model yang aneh bisa membuat backtest berjalan di luar batas yang
 * masuk akal (atau menghabiskan memori server).
 */

export type LabFamily = 'trend' | 'momentum' | 'breakout' | 'meanrev' | 'rs' | 'pattern';
export type LabInterval = '1h' | '4h' | '1d' | '1w';
export type MacroFilter =
  | 'none'
  | 'vix_low'
  | 'vix_high'
  | 'fed_easing'
  | 'fed_tightening'
  | 'curve_inverted'
  | 'curve_positive';

export const LAB_FAMILIES: LabFamily[] = [
  'trend',
  'momentum',
  'breakout',
  'meanrev',
  'rs',
  'pattern',
];

export const LAB_INTERVALS: LabInterval[] = ['1h', '4h', '1d', '1w'];

export const MACRO_FILTERS: MacroFilter[] = [
  'none',
  'vix_low',
  'vix_high',
  'fed_easing',
  'fed_tightening',
  'curve_inverted',
  'curve_positive',
];

export interface LabParams {
  /** EMA cepat / lambat untuk keluarga trend. */
  fast: number;
  slow: number;
  /** RSI filter untuk momentum & meanrev. */
  rsiPeriod: number;
  rsiBuy: number;
  rsiSell: number;
  /** Rate-of-change untuk momentum. */
  rocPeriod: number;
  rocThreshold: number;
  /** Lookback Donchian untuk breakout. */
  donchian: number;
  /** Ambang z-score untuk meanrev. */
  zEntry: number;
  /** Exit berbasis ATR (R-multiple dinormalisasi oleh atrStop). */
  atrStop: number;
  atrTarget: number;
  maxHold: number;
  allowShort: boolean;
  /** Jumlah sentuhan minimum untuk level pattern. */
  minTouches: number;
}

export interface LabProposal {
  /** Id aset: "binance:BTCUSDT", "yahoo:GC=F", "yahoo:NVDA", "hyperliquid:HYPE". */
  asset: string;
  interval: LabInterval;
  family: LabFamily;
  params: LabParams;
  macroFilter: MacroFilter;
  rationale: string;
  source: 'llm' | 'fallback';
}

/** Batas keras setiap parameter. Di luar ini clamp, bukan ditolak. */
export const LAB_BOUNDS = {
  fast: [3, 60] as const,
  slow: [10, 300] as const,
  rsiPeriod: [5, 40] as const,
  rsiBuy: [40, 80] as const,
  rsiSell: [20, 60] as const,
  rocPeriod: [2, 120] as const,
  rocThreshold: [0.005, 0.25] as const,
  donchian: [10, 200] as const,
  zEntry: [0.5, 3.5] as const,
  atrStop: [0.8, 5] as const,
  atrTarget: [1, 8] as const,
  maxHold: [3, 200] as const,
  minTouches: [2, 6] as const,
};

export function defaultParamsFor(family: LabFamily): LabParams {
  const base: LabParams = {
    fast: 20,
    slow: 50,
    rsiPeriod: 14,
    rsiBuy: 55,
    rsiSell: 45,
    rocPeriod: 20,
    rocThreshold: 0.03,
    donchian: 55,
    zEntry: 1.5,
    atrStop: 2,
    atrTarget: 3,
    maxHold: 40,
    allowShort: true,
    minTouches: 2,
  };
  if (family === 'trend') return { ...base, fast: 20, slow: 100, maxHold: 60 };
  if (family === 'momentum') return { ...base, rocPeriod: 20, rocThreshold: 0.04, maxHold: 30 };
  if (family === 'breakout') return { ...base, donchian: 55, maxHold: 50 };
  if (family === 'meanrev') return { ...base, zEntry: 1.5, atrTarget: 2, maxHold: 20 };
  if (family === 'rs') return { ...base, fast: 6, slow: 20, maxHold: 30 };
  return { ...base, minTouches: 2, maxHold: 45 };
}

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(hi, Math.max(lo, n));
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  return Math.round(clampNum(v, lo, hi, fallback));
}

/** Clamp setiap parameter ke batas keras, lalu perbaiki relasi yang tidak masuk akal. */
export function clampParams(raw: Partial<LabParams> | undefined, family: LabFamily): LabParams {
  const d = defaultParamsFor(family);
  const p: LabParams = {
    fast: clampInt(raw?.fast, ...LAB_BOUNDS.fast, d.fast),
    slow: clampInt(raw?.slow, ...LAB_BOUNDS.slow, d.slow),
    rsiPeriod: clampInt(raw?.rsiPeriod, ...LAB_BOUNDS.rsiPeriod, d.rsiPeriod),
    rsiBuy: clampInt(raw?.rsiBuy, ...LAB_BOUNDS.rsiBuy, d.rsiBuy),
    rsiSell: clampInt(raw?.rsiSell, ...LAB_BOUNDS.rsiSell, d.rsiSell),
    rocPeriod: clampInt(raw?.rocPeriod, ...LAB_BOUNDS.rocPeriod, d.rocPeriod),
    rocThreshold: clampNum(raw?.rocThreshold, ...LAB_BOUNDS.rocThreshold, d.rocThreshold),
    donchian: clampInt(raw?.donchian, ...LAB_BOUNDS.donchian, d.donchian),
    zEntry: clampNum(raw?.zEntry, ...LAB_BOUNDS.zEntry, d.zEntry),
    atrStop: clampNum(raw?.atrStop, ...LAB_BOUNDS.atrStop, d.atrStop),
    atrTarget: clampNum(raw?.atrTarget, ...LAB_BOUNDS.atrTarget, d.atrTarget),
    maxHold: clampInt(raw?.maxHold, ...LAB_BOUNDS.maxHold, d.maxHold),
    allowShort: typeof raw?.allowShort === 'boolean' ? raw.allowShort : d.allowShort,
    minTouches: clampInt(raw?.minTouches, ...LAB_BOUNDS.minTouches, d.minTouches),
  };
  // Relasi wajib: EMA cepat harus benar-benar lebih cepat, dan RSI beli > jual.
  if (p.fast >= p.slow) p.slow = Math.min(LAB_BOUNDS.slow[1], p.fast + 10);
  if (p.rsiBuy <= p.rsiSell) p.rsiBuy = Math.min(LAB_BOUNDS.rsiBuy[1], p.rsiSell + 5);
  // Target di bawah stop membuat ekspektasi R hampir selalu negatif setelah fee.
  if (p.atrTarget < p.atrStop * 0.5) p.atrTarget = Math.min(8, p.atrStop * 0.5);
  return p;
}

/** Simbol yang boleh dipakai: id venue atau ticker Yahoo. Tanpa spasi/kutip/URL. */
export function isValidAssetId(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const s = raw.trim();
  if (s.length < 1 || s.length > 32) return false;
  return /^[A-Za-z0-9^=._:-]+$/.test(s);
}

export function isValidInterval(raw: unknown): raw is LabInterval {
  return typeof raw === 'string' && (LAB_INTERVALS as string[]).includes(raw);
}

export function isValidFamily(raw: unknown): raw is LabFamily {
  return typeof raw === 'string' && (LAB_FAMILIES as string[]).includes(raw);
}

export function isValidMacroFilter(raw: unknown): raw is MacroFilter {
  return typeof raw === 'string' && (MACRO_FILTERS as string[]).includes(raw);
}

/**
 * Frasa yang membuat hasil eksperimen berubah menjadi janji investasi.
 * Model boleh menjelaskan hipotesis; ia tidak boleh menjanjikan hasil.
 */
const FORBIDDEN: Array<{ re: RegExp; label: string }> = [
  { re: /\b(jaminan|dijamin|pasti\s+(profit|untung|naik|turun|aman)|100%\s*aman|bebas\s+risiko|guaranteed)\b/i, label: 'janji hasil' },
  { re: /\b(beli|jual|masuk|keluar)\s+(sekarang|langsung|saat ini)\b/i, label: 'perintah transaksi' },
  { re: /\b(kamu|anda|kita)\s+(harus|sebaiknya|disarankan)\s+(membeli|menjual|memegang)\b/i, label: 'saran transaksi' },
  { re: /\ball\s*in\b|\bleverage\s*\d|\bmargin\s+call\b/i, label: 'risiko berlebih' },
];

export function firstForbidden(text: string): string | null {
  for (const { re, label } of FORBIDDEN) if (re.test(text)) return label;
  return null;
}

export interface ValidationResult {
  ok: boolean;
  value?: LabProposal;
  error?: string;
}

/** Validasi keluaran model. Tidak pernah melempar; gagal = fallback di pemanggil. */
export function validateProposal(raw: string): ValidationResult {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { ok: false, error: 'keluaran bukan JSON valid' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'JSON bukan objek' };
  }
  const o = parsed as Record<string, unknown>;

  if (!isValidAssetId(o.asset)) return { ok: false, error: 'asset tidak valid' };
  if (!isValidInterval(o.interval)) return { ok: false, error: 'interval di luar enum' };
  if (!isValidFamily(o.family)) return { ok: false, error: 'family di luar enum' };
  if (!isValidMacroFilter(o.macroFilter ?? 'none')) {
    return { ok: false, error: 'macroFilter di luar enum' };
  }

  const rationale = typeof o.rationale === 'string' ? o.rationale.trim() : '';
  if (!rationale) return { ok: false, error: 'rationale wajib' };
  if (rationale.length > 400) return { ok: false, error: 'rationale > 400 karakter' };
  const banned = firstForbidden(rationale);
  if (banned) return { ok: false, error: `frasa terlarang: ${banned}` };

  const family = o.family as LabFamily;
  const params = clampParams(
    o.params && typeof o.params === 'object' ? (o.params as Partial<LabParams>) : undefined,
    family
  );

  return {
    ok: true,
    value: {
      asset: o.asset.trim(),
      interval: o.interval as LabInterval,
      family,
      params,
      macroFilter: (o.macroFilter ?? 'none') as MacroFilter,
      rationale,
      source: 'llm',
    },
  };
}

// ---------------------------------------------------------------------------
// Katalog titik awal
// ---------------------------------------------------------------------------

export interface LabGroup {
  id: 'crypto' | 'commodities' | 'equities' | 'indices';
  label: string;
  /** Urut dari big cap ke bawah; hanya titik awal, bukan whitelist. */
  assets: string[];
}

export const LAB_CATALOG: LabGroup[] = [
  {
    id: 'crypto',
    label: 'Crypto',
    assets: [
      'binance:BTCUSDT',
      'binance:ETHUSDT',
      'binance:SOLUSDT',
      'binance:XRPUSDT',
      'hyperliquid:HYPE',
      'binance:BNBUSDT',
      'binance:ADAUSDT',
      'binance:AVAXUSDT',
      'binance:LINKUSDT',
      'binance:DOGEUSDT',
    ],
  },
  {
    id: 'commodities',
    label: 'Komoditas',
    assets: ['yahoo:CL=F', 'yahoo:GC=F', 'yahoo:SI=F', 'yahoo:NG=F', 'yahoo:HG=F', 'yahoo:PL=F'],
  },
  {
    id: 'equities',
    label: 'Saham Big Cap',
    assets: ['yahoo:AAPL', 'yahoo:NVDA', 'yahoo:META', 'yahoo:MSFT', 'yahoo:AMZN', 'yahoo:GOOGL', 'yahoo:TSLA'],
  },
  {
    id: 'indices',
    label: 'Index ETF',
    assets: ['yahoo:SPY', 'yahoo:QQQ', 'yahoo:DIA', 'yahoo:IWM'],
  },
];

export function groupForAsset(assetId: string): LabGroup['id'] | 'other' {
  for (const g of LAB_CATALOG) {
    if (g.assets.includes(assetId)) return g.id;
  }
  return 'other';
}

export interface HistoryLite {
  asset: string;
  family: string;
  interval: string;
  verdict?: string | null;
}

/**
 * Perencana deterministik: dipakai saat model gagal atau belum dikonfigurasi.
 * Mengisi sel (aset × keluarga) yang belum pernah diuji, big cap lebih dulu,
 * dan tetap berputar setelah semua sel terisi (mulai dari kombinasi terbaik).
 */
export function fallbackProposal(history: HistoryLite[]): LabProposal {
  const tested = new Set(history.map((h) => `${h.asset}|${h.family}|${h.interval}`));
  const interval: LabInterval = '1d';

  for (const group of LAB_CATALOG) {
    for (const asset of group.assets) {
      for (const family of LAB_FAMILIES) {
        if (!tested.has(`${asset}|${family}|${interval}`)) {
          return {
            asset,
            interval,
            family,
            params: defaultParamsFor(family),
            macroFilter: 'none',
            rationale: `Sel ${asset} × ${family} belum pernah diuji pada ${interval}; dijalankan sebagai baseline deterministik.`,
            source: 'fallback',
          };
        }
      }
    }
  }

  // Semua sel dasar terisi: lanjutkan dari aset yang paling sering menang,
  // lalu putar keluarga berikutnya (auto-iterasi lanjutan).
  const scored = history.filter((h) => h.verdict === 'promising' || h.verdict === 'strong');
  const seed = scored[scored.length - 1] || history[history.length - 1];
  const asset = seed?.asset || LAB_CATALOG[0].assets[0];
  const familyIdx = Math.max(0, LAB_FAMILIES.indexOf((seed?.family as LabFamily) || 'trend'));
  const family = LAB_FAMILIES[(familyIdx + 1) % LAB_FAMILIES.length];
  const params = defaultParamsFor(family);
  const rounds = history.filter((h) => h.asset === asset && h.family === family).length;
  // Variasi terarah: setiap putaran menggeser satu sumbu, bukan acak.
  const slow = Math.min(LAB_BOUNDS.slow[1], params.slow + rounds * 10);
  return {
    asset,
    interval,
    family,
    params: { ...params, slow },
    macroFilter: 'none',
    rationale: `Iterasi lanjutan: ${asset} keluarga ${family}, memperlebar sumbu slow ke ${slow} setelah ${rounds} putaran.`,
    source: 'fallback',
  };
}

export const LAB_COOLDOWN_MINUTES = 10;

// ---------------------------------------------------------------------------
// Riwayat trade untuk chart setup
// ---------------------------------------------------------------------------

export const LAB_MAX_STORED_TRADES = 300;
export const LAB_RISK_PER_TRADE = 0.01;
export const LAB_START_BALANCE = 1000;

export interface StoredTrade {
  entryTime: number;
  exitTime: number;
  side: 'buy' | 'sell';
  entry: number;
  exit: number;
  stop: number;
  target: number;
  bars: number;
  r: number;
  /** Saldo akhir trade ini, mulai dari $1.000 dengan risiko 1% per trade. */
  balance: number;
  reason: string;
}

/**
 * Trade yang disimpan per run: 300 terakhir, masing-masing dengan saldo
 * berjalan. Saldo DIHITUNG dari urutan PENUH sebelum pemotongan, jadi tabel
 * saldo di UI tetap benar walau trade awal tidak disimpan.
 */
export function storedTrades(
  trades: Array<{
    entryTime: number;
    exitTime: number;
    side: 'buy' | 'sell';
    entry: number;
    exit: number;
    stop: number;
    target: number;
    bars: number;
    rMultiple: number;
    exitReason: string;
  }>
): StoredTrade[] {
  let balance = LAB_START_BALANCE;
  const withBalance = trades.map((t) => {
    balance *= 1 + t.rMultiple * LAB_RISK_PER_TRADE;
    const round = (v: number) => Math.round(v * 1e6) / 1e6;
    return {
      entryTime: t.entryTime,
      exitTime: t.exitTime,
      side: t.side,
      entry: round(t.entry),
      exit: round(t.exit),
      stop: round(t.stop),
      target: round(t.target),
      bars: t.bars,
      r: Math.round(t.rMultiple * 1000) / 1000,
      balance: Math.round(balance * 100) / 100,
      reason: t.exitReason,
    };
  });
  return withBalance.slice(-LAB_MAX_STORED_TRADES);
}
