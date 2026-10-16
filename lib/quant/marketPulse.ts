/**
 * Whole-context market pulse.
 *
 * Where `analysis` reasons about one instrument and `narrator` summarises one
 * scan, the pulse sees EVERY market at once — crypto, commodities and US
 * equities — and produces one synchronised read: which way each market leans,
 * whether there is rotation between them, and one portfolio-level stance.
 *
 * Data comes from the existing futures book (`loadFutures`), so all three
 * groups already share one fetch, one timeframe and one macro snapshot. The
 * pulse adds no new data source; it adds the cross-market reasoning layer.
 *
 * Strictness is the same toolkit as the analyst: schema + enum + length caps,
 * forbidden-phrase scan, hallucinated-number scan, macro guard, a direction
 * guard that refuses to fight the markets, and a deterministic fallback.
 */

import { callLLM, numbersIn, isKnownNumber, NarratorSeverity, CallLLMOptions } from './marketNarrator';
import {
  AnalystConviction,
  AnalystDirection,
  MacroContext,
  collectInputNumbers,
  firstForbidden,
  hasMacroContent,
  macroGuard,
} from './marketAnalyst';
import { buildLiquidityNote } from './macroData';
import type { FuturesGroup, FuturesSignal, MacroSnapshot } from '../futuresBook';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PulseMarketId = 'crypto' | 'commodities' | 'us_stocks';

export interface PulseRow {
  symbol: string;
  name: string;
  verdict: 'long' | 'short' | 'wait';
  score: number;
  changePct: number;
  price: number;
  macroNote: string;
  reasons: string[];
}

export interface PulseMarket {
  market: PulseMarketId;
  label: string;
  longs: number;
  shorts: number;
  waits: number;
  avgScore: number;
  bias: 'up' | 'down' | 'mixed';
  rows: PulseRow[];
}

export interface PulseSnapshot {
  generatedAt: number;
  tf: string;
  macro: MacroContext | null;
  markets: PulseMarket[];
  warnings: Array<{ severity: NarratorSeverity; title: string; detail: string }>;
}

export interface PulseModelOutput {
  marketRegime: string;
  direction: AnalystDirection;
  conviction: AnalystConviction;
  headline: string;
  crossMarket: string[];
  macroRead: string;
  playbook: { long: string | null; short: string | null; invalidation: string | null };
  confidence: number;
  caveats: string[];
}

export interface PulseOutput extends PulseModelOutput {
  source: 'llm' | 'rule_fallback';
  model?: string;
  directionReason?: string;
}

// ---------------------------------------------------------------------------
// Snapshot builder
// ---------------------------------------------------------------------------

const GROUP_TO_MARKET: Record<FuturesGroup, PulseMarketId> = {
  crypto: 'crypto',
  commodity: 'commodities',
  equity: 'us_stocks',
};

const MARKET_LABEL: Record<PulseMarketId, string> = {
  crypto: 'Crypto',
  commodities: 'Komoditas',
  us_stocks: 'Saham US',
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

/** Convert the futures macro snapshot into the analyst's MacroContext shape. */
export function macroContextFromSnapshot(m: MacroSnapshot): MacroContext | null {
  const ctx: MacroContext = {
    asOf: m.asOf ?? undefined,
    dxy: m.dxy != null ? `DXY ${m.dxy.toFixed(2)}${m.dxyChangePct != null ? ` (${fmtPct(m.dxyChangePct)} 5 hari)` : ''}` : undefined,
    vix: m.vix != null ? `VIX ${m.vix.toFixed(1)}` : undefined,
    treasury10y: m.us10y != null ? `US 10Y ${m.us10y.toFixed(2)}%` : undefined,
    fedFundRate: m.fedFunds != null ? `Fed funds ${m.fedFunds.toFixed(2)}%` : undefined,
    cpi: m.cpiYoY != null ? `CPI YoY ${m.cpiYoY.toFixed(2)}%` : undefined,
    liquidityNote: buildLiquidityNote(m.vix, m.dxyChangePct, null),
  };
  return hasMacroContent(ctx) ? ctx : null;
}

export function buildPulseSnapshot(args: {
  signals: FuturesSignal[];
  macro: MacroSnapshot;
  tf: string;
  missing?: string[];
}): PulseSnapshot {
  const groups: FuturesGroup[] = ['crypto', 'commodity', 'equity'];

  const markets: PulseMarket[] = groups.map((g) => {
    const rows = args.signals.filter((s) => s.instrument.group === g);
    const longs = rows.filter((r) => r.verdict === 'long').length;
    const shorts = rows.filter((r) => r.verdict === 'short').length;
    const active = rows.filter((r) => r.verdict !== 'wait');
    const bias: PulseMarket['bias'] = longs > shorts ? 'up' : shorts > longs ? 'down' : 'mixed';
    const avgScore = active.length
      ? Math.round(active.reduce((a, r) => a + r.score, 0) / active.length)
      : 0;
    const market = GROUP_TO_MARKET[g];
    return {
      market,
      label: MARKET_LABEL[market],
      longs,
      shorts,
      waits: rows.length - longs - shorts,
      avgScore,
      bias,
      rows: active
        .slice()
        .sort((a, b) => b.score - a.score)
        .slice(0, 6)
        .map((r) => ({
          symbol: r.instrument.symbol,
          name: r.instrument.name,
          verdict: r.verdict,
          score: r.score,
          changePct: round2(r.changePct),
          price: r.price,
          macroNote: r.macroNote,
          reasons: r.reasons.filter((x) => !x.startsWith('⚠')).slice(0, 2),
        })),
    };
  });

  const warnings: PulseSnapshot['warnings'] = [];
  if (args.missing && args.missing.length > 0) {
    warnings.push({
      severity: 'medium',
      title: 'Book tidak lengkap',
      detail: `simbol tanpa data: ${args.missing.join(', ')}`,
    });
  }
  const totalActive = markets.reduce((a, m) => a + m.longs + m.shorts, 0);
  if (totalActive >= 6) {
    warnings.push({
      severity: 'high',
      title: 'Banyak arah aktif',
      detail: `${totalActive} instrumen punya arah aktif sekaligus`,
    });
  }

  return {
    generatedAt: Date.now(),
    tf: args.tf,
    macro: macroContextFromSnapshot(args.macro),
    markets,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Input guard
// ---------------------------------------------------------------------------

const MAX_SNAPSHOT_BYTES = 24_000;

export function validatePulseSnapshot(s: unknown): { ok: boolean; error?: string } {
  if (!s || typeof s !== 'object') return { ok: false, error: 'snapshot harus objek' };
  const o = s as Record<string, unknown>;
  if (typeof o.generatedAt !== 'number' || !Number.isFinite(o.generatedAt)) {
    return { ok: false, error: 'generatedAt wajib angka' };
  }
  if (typeof o.tf !== 'string' || o.tf.length === 0) return { ok: false, error: 'tf wajib' };
  if (!Array.isArray(o.markets) || o.markets.length === 0) {
    return { ok: false, error: 'markets wajib non-kosong' };
  }
  if (JSON.stringify(s).length > MAX_SNAPSHOT_BYTES) {
    return { ok: false, error: `snapshot melewati ${MAX_SNAPSHOT_BYTES} byte` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Output guard
// ---------------------------------------------------------------------------

const MAX_HEADLINE = 90;
const MAX_REGIME = 280;
const MAX_CROSS = 4;
const MAX_BULLET = 110;
const MAX_PLAY = 200;
const MAX_MACRO = 420;
const MAX_CAVEATS = 3;

const ALLOWED_DIRECTION: readonly AnalystDirection[] = ['wait', 'prepare_long', 'prepare_short', 'hedge'];
const ALLOWED_CONVICTION: readonly AnalystConviction[] = ['low', 'medium', 'high'];

export function validatePulseOutput(
  raw: string,
  inputNumbers: number[]
): { ok: true; value: PulseModelOutput } | { ok: false; error: string } {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { ok: false, error: 'keluaran bukan JSON valid' };
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'JSON bukan objek' };
  const o = parsed as Record<string, unknown>;

  if (typeof o.marketRegime !== 'string' || o.marketRegime.length === 0 || o.marketRegime.length > MAX_REGIME) {
    return { ok: false, error: `marketRegime harus 1-${MAX_REGIME} karakter` };
  }
  if (typeof o.direction !== 'string' || !ALLOWED_DIRECTION.includes(o.direction as AnalystDirection)) {
    return { ok: false, error: 'direction di luar enum' };
  }
  if (typeof o.conviction !== 'string' || !ALLOWED_CONVICTION.includes(o.conviction as AnalystConviction)) {
    return { ok: false, error: 'conviction di luar enum' };
  }
  if (typeof o.headline !== 'string' || o.headline.length === 0 || o.headline.length > MAX_HEADLINE) {
    return { ok: false, error: `headline harus 1-${MAX_HEADLINE} karakter` };
  }
  if (typeof o.macroRead !== 'string' || o.macroRead.length === 0 || o.macroRead.length > MAX_MACRO) {
    return { ok: false, error: `macroRead harus 1-${MAX_MACRO} karakter` };
  }
  if (typeof o.confidence !== 'number' || o.confidence < 0 || o.confidence > 100) {
    return { ok: false, error: 'confidence harus 0-100' };
  }
  if (!Array.isArray(o.crossMarket) || o.crossMarket.length === 0 || o.crossMarket.length > MAX_CROSS) {
    return { ok: false, error: `crossMarket wajib 1-${MAX_CROSS} poin` };
  }
  if (o.crossMarket.some((x) => typeof x !== 'string' || x.length > MAX_BULLET)) {
    return { ok: false, error: `poin crossMarket melewati ${MAX_BULLET} karakter` };
  }
  if (!Array.isArray(o.caveats) || o.caveats.length > MAX_CAVEATS) {
    return { ok: false, error: `caveats maks ${MAX_CAVEATS} poin` };
  }
  if (o.caveats.some((c) => typeof c !== 'string' || c.length > MAX_BULLET)) {
    return { ok: false, error: `poin caveats melewati ${MAX_BULLET} karakter` };
  }
  if (!o.playbook || typeof o.playbook !== 'object') return { ok: false, error: 'playbook wajib ada' };
  const p = o.playbook as Record<string, unknown>;
  for (const key of ['long', 'short', 'invalidation']) {
    if (p[key] !== null && (typeof p[key] !== 'string' || (p[key] as string).length > MAX_PLAY)) {
      return { ok: false, error: `playbook.${key} harus string (maks ${MAX_PLAY}) atau null` };
    }
  }

  const allText = [o.headline, o.marketRegime, o.macroRead, ...(o.crossMarket as string[]), ...(o.caveats as string[])]
    .concat([String(p.long ?? ''), String(p.short ?? ''), String(p.invalidation ?? '')])
    .join('\n');
  const banned = firstForbidden(allText);
  if (banned) return { ok: false, error: `frasa terlarang: ${banned}` };

  for (const field of [o.headline, o.marketRegime, o.macroRead, ...(o.crossMarket as string[]), ...(o.caveats as string[]),
    String(p.long ?? ''), String(p.short ?? ''), String(p.invalidation ?? '')]) {
    for (const n of numbersIn(field as string)) {
      if (!isKnownNumber(n, inputNumbers)) {
        return { ok: false, error: `angka ${n} tidak ada di input` };
      }
    }
  }

  return {
    ok: true,
    value: {
      marketRegime: o.marketRegime,
      direction: o.direction as AnalystDirection,
      conviction: o.conviction as AnalystConviction,
      headline: o.headline,
      crossMarket: o.crossMarket as string[],
      macroRead: o.macroRead,
      playbook: {
        long: (p.long as string | null) ?? null,
        short: (p.short as string | null) ?? null,
        invalidation: (p.invalidation as string | null) ?? null,
      },
      confidence: Math.round(o.confidence),
      caveats: o.caveats as string[],
    },
  };
}

// ---------------------------------------------------------------------------
// Direction guard
// ---------------------------------------------------------------------------

export function guardPulseDirection(
  out: PulseModelOutput,
  markets: PulseMarket[]
): { direction: AnalystDirection; reason?: string } {
  if (out.direction === 'wait' || out.direction === 'hedge') return { direction: out.direction };
  if (out.conviction === 'low') {
    return { direction: 'wait', reason: 'conviction rendah tidak boleh arah directional' };
  }
  const up = markets.filter((m) => m.bias === 'up').length;
  const down = markets.filter((m) => m.bias === 'down').length;

  if (out.direction === 'prepare_long') {
    if (!out.playbook.long) return { direction: 'wait', reason: 'prepare_long tanpa skenario long' };
    if (up < 2 || down >= up) return { direction: 'wait', reason: 'prepare_long butuh minimal 2 pasar naik' };
  }
  if (out.direction === 'prepare_short') {
    if (!out.playbook.short) return { direction: 'wait', reason: 'prepare_short tanpa skenario short' };
    if (down < 2 || up >= down) return { direction: 'wait', reason: 'prepare_short butuh minimal 2 pasar turun' };
  }
  return { direction: out.direction };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `Kamu adalah KEPALA STRATEGIS MULTI-ASET: dalam satu pandangan kamu mengawasi crypto, komoditas, dan saham US SEKALIGUS. Kamu memadukan disiplin top-down seorang hedge fund manager dengan ketajaman entry seorang scalper elite.

TUJUANMU: satu bacaan tersinkron untuk seluruh pasar — mana yang naik, mana yang turun, ada rotasi ke mana, dan satu sikap portofolio.

METODE WAJIB (whole-context)
1. Makro dulu: liquidity, dolar, volatilitas, suku bunga. Ini bias utama semua pasar.
2. Regime antar-pasar: mana risk-on, mana risk-off, dan apakah dana bergerak dari satu pasar ke pasar lain (rotasi)?
3. Bias tiap pasar dari sinyal & skor yang ada (naik / turun / campur).
4. Konfluensi & divergensi: pasar yang sepaham menguatkan; yang berlawanan adalah peringatan.
5. Baru ambil SATU sikap portofolio: wait / prepare_long / prepare_short / hedge.

SUMBER KEBENARAN
- Satu-satunya sumber fakta adalah objek JSON pada pesan user (INPUT).
- Setiap angka yang kamu tulis WAJIB ada di INPUT. Dilarang mengarang statistik.
- Kamu TIDAK punya data makro live. Kalau field "macro" kosong, WAJIB tulis bahwa data makro tidak tersedia, dan DILARANG menyebut event makro spesifik.

FORMAT KELUARAN (WAJIB)
Keluarkan HANYA satu objek JSON, tanpa markdown, tanpa penjelasan. Skema:
{
  "marketRegime": "<=280 karakter, regime seluruh pasar & rotasi",
  "direction": "wait|prepare_long|prepare_short|hedge",
  "conviction": "low|medium|high",
  "headline": "<=90 karakter, satu kalimat sikap utama",
  "crossMarket": ["<=4 poin: baca tiap pasar (crypto/komoditas/saham US), masing-masing <=110 karakter"],
  "macroRead": "<=420 karakter, baca makro ATAU nyatakan tidak tersedia",
  "playbook": {
    "long": "<skenario long lintas-pasar, atau null>",
    "short": "<skenario short lintas-pasar, atau null>",
    "invalidation": "<kondisi yang membatalkan tesis>"
  },
  "confidence": 0-100,
  "caveats": ["<=3 poin, masing-masing <=110 karakter"]
}

ATURAN KERAS (langgar = keluaran ditolak)
1. direction "prepare_long"/"prepare_short" hanya saat conviction medium/high, playbook sisi itu terisi, DAN mayoritas pasar mendukung arah itu. Kalau ragu → "wait".
2. JANGAN menulis perintah eksekusi ("beli sekarang", "jual sekarang", "segera masuk"). Kamu menyusun SIAPSIAGA, bukan mengeksekusi.
3. JANGAN memberi angka target harga, take-profit, atau stop-loss.
4. JANGAN menjanjikan keuntungan atau menjamin hasil.
5. JANGAN menyebut leverage / all in / margin call.
6. Selalu sertakan "invalidation".
7. Isi hanya bahasa Indonesia (nama aset/simbol bebas).

SEBELUM mengeluarkan JSON, periksa: setiap angka ada di INPUT? Arah tidak melawan mayoritas pasar? Kalau ragu, pilih "wait" dan conviction "low".`;

export function buildPulsePrompt(snapshot: PulseSnapshot): string {
  return `INPUT (JSON):\n${JSON.stringify(snapshot, null, 2)}`;
}

// ---------------------------------------------------------------------------
// Deterministic fallback
// ---------------------------------------------------------------------------

export function rulePulseFallback(snapshot: PulseSnapshot): PulseOutput {
  const up = snapshot.markets.filter((m) => m.bias === 'up');
  const down = snapshot.markets.filter((m) => m.bias === 'down');
  let direction: AnalystDirection = 'wait';
  let conviction: AnalystConviction = 'low';
  if (up.length >= 2 && up.length > down.length) {
    direction = 'prepare_long';
    conviction = 'medium';
  } else if (down.length >= 2 && down.length > up.length) {
    direction = 'prepare_short';
    conviction = 'medium';
  }

  const biasWord = (b: PulseMarket['bias']) => (b === 'up' ? 'naik' : b === 'down' ? 'turun' : 'campur');
  const topRows = snapshot.markets
    .flatMap((m) => m.rows.slice(0, 1).map((r) => `${r.symbol} ${r.verdict === 'long' ? 'naik' : 'turun'} (${r.score})`))
    .slice(0, 3);

  return {
    marketRegime: snapshot.markets.map((m) => `${m.label}: ${biasWord(m.bias)}`).join('; '),
    direction,
    conviction,
    headline:
      direction === 'wait'
        ? 'Pasar campur; belum ada sikap portofolio yang disepakati.'
        : `${direction === 'prepare_long' ? 'Persiapan long' : 'Persiapan short'} lintas-pasar.`,
    crossMarket: snapshot.markets.map(
      (m) => `${m.label}: ${m.longs} long / ${m.shorts} short, bias ${biasWord(m.bias)}`
    ),
    macroRead: snapshot.macro
      ? 'Data makro tersedia di input.'
      : 'Data makro tidak tersedia; sikap diturunkan dari sinyal harga saja.',
    playbook: {
      long: direction === 'prepare_long' ? `Pasar terkuat: ${topRows.join(', ') || 'belum ada'}.` : null,
      short: direction === 'prepare_short' ? `Pasar terlemah: ${topRows.join(', ') || 'belum ada'}.` : null,
      invalidation: 'Batalkan jika bias mayoritas berbalik arah.',
    },
    confidence: 60,
    caveats: ['Bacaan rule-based, bukan pendapat AI.', 'Bukan instruksi eksekusi.'],
    source: 'rule_fallback',
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface PulseOptions {
  model?: string;
  call?: (prompt: string, opts?: CallLLMOptions) => Promise<string>;
}

export async function analysePulse(snapshot: PulseSnapshot, opts: PulseOptions = {}): Promise<PulseOutput> {
  const inputGuard = validatePulseSnapshot(snapshot);
  if (!inputGuard.ok) return { ...rulePulseFallback(snapshot), directionReason: inputGuard.error };

  const inputNumbers = collectInputNumbers(snapshot);
  const fallback = rulePulseFallback(snapshot);

  let raw: string;
  try {
    const call = opts.call ?? callLLM;
    raw = await call(buildPulsePrompt(snapshot), { model: opts.model, system: SYSTEM_PROMPT });
  } catch (err) {
    return { ...fallback, directionReason: err instanceof Error ? err.message : 'model gagal' };
  }

  const checked = validatePulseOutput(raw, inputNumbers);
  if (!checked.ok) return { ...fallback, directionReason: `output ditolak: ${checked.error}` };

  const macro = macroGuard(checked.value.macroRead, snapshot.macro);
  if (!macro.ok) return { ...fallback, directionReason: `makro ditolak: ${macro.reason}` };

  const { direction, reason } = guardPulseDirection(checked.value, snapshot.markets);
  return { ...checked.value, direction, directionReason: reason, source: 'llm', model: opts.model };
}
