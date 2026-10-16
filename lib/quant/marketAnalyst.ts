/**
 * Strict market analyst — directional POV.
 *
 * A second persona, deliberately separate from the narrator: where the narrator
 * only summarises, the analyst is ALLOWED to take a directional view
 * (wait / prepare long / prepare short) and to reason top-down across
 * timeframes and macro. The strictness moves accordingly:
 *
 *   1. Prompt lock  — persona, method (top-down), exact output schema, hard bans.
 *   2. Input guard  — snapshot well-formed; macro must be present or declared absent.
 *   3. Output guard — schema, enums, lengths, forbidden phrases, hallucinated numbers.
 *   4. Macro guard  — no macro input ⇒ must say "not available" and may not name events.
 *   5. Direction guard — direction must not contradict the higher-timeframe trend;
 *      low conviction cannot produce a directional call.
 *   6. Fallback     — any failure yields a deterministic top-down fallback.
 *
 * NOTE: a model has no live macro feed. Macro claims are only safe if the caller
 * supplies a `macro` object. Without it, the macro guard forces honesty.
 */

import {
  callLLM,
  llmEnv,
  numbersIn,
  isKnownNumber,
  NarratorSeverity,
  CallLLMOptions,
} from './marketNarrator';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AnalystDirection = 'wait' | 'prepare_long' | 'prepare_short' | 'hedge';
export type AnalystConviction = 'low' | 'medium' | 'high';

export interface MacroContext {
  asOf?: string;
  fedFundRate?: string;
  dxy?: string;
  btcDominance?: string;
  sp500Trend?: string;
  vix?: string;
  treasury10y?: string;
  gold?: string;
  cpi?: string;
  liquidityNote?: string;
  upcomingEvents?: string[];
}

export interface AnalystTimeframe {
  tf: string; // 1w, 1d, 4h, 1h, 15m, 5m
  trend: 'up' | 'down' | 'range';
  structure: 'higher_highs' | 'lower_lows' | 'equal_highs' | 'consolidation';
  keyLevel: number | null;
  rsi: number | null;
}

export interface AnalystSnapshot {
  generatedAt: number;
  indexSymbol: string;
  market: 'crypto' | 'us_stocks';
  macro: MacroContext | null;
  regime: { regime: string; confidence: number };
  timeframes: AnalystTimeframe[];
  crossAsset: Array<{ asset: string; direction: 'up' | 'down' | 'range'; changePct: number }>;
  liquidity: { longs: number; shorts: number } | null;
  warnings: Array<{ severity: NarratorSeverity; title: string; detail: string }>;
}

export interface AnalystModelOutput {
  direction: AnalystDirection;
  conviction: AnalystConviction;
  headline: string;
  thesis: string;
  topDown: string[];
  macroRead: string;
  playbook: {
    long: string | null;
    short: string | null;
    invalidation: string | null;
  };
  confidence: number;
  caveats: string[];
}

export interface AnalystOutput extends AnalystModelOutput {
  source: 'llm' | 'rule_fallback';
  model?: string;
  directionReason?: string;
}

// ---------------------------------------------------------------------------
// Guard 2 — input
// ---------------------------------------------------------------------------

const MAX_SNAPSHOT_BYTES = 16_000;
const TF_RANK: Record<string, number> = { '1w': 0, '1d': 1, '4h': 2, '1h': 3, '15m': 4, '5m': 5 };
const HTF_MAX_RANK = 2; // 1w, 1d, 4h are the higher timeframes

export function validateAnalystSnapshot(s: unknown): { ok: boolean; error?: string } {
  if (!s || typeof s !== 'object') return { ok: false, error: 'snapshot harus objek' };
  const o = s as Record<string, unknown>;

  if (typeof o.generatedAt !== 'number' || !Number.isFinite(o.generatedAt)) {
    return { ok: false, error: 'generatedAt wajib angka' };
  }
  if (typeof o.indexSymbol !== 'string' || o.indexSymbol.length === 0) {
    return { ok: false, error: 'indexSymbol wajib string' };
  }
  if (o.market !== 'crypto' && o.market !== 'us_stocks') {
    return { ok: false, error: 'market harus crypto atau us_stocks' };
  }
  if (o.macro !== null && (typeof o.macro !== 'object' || !o.macro)) {
    return { ok: false, error: 'macro harus objek atau null' };
  }
  if (!Array.isArray(o.timeframes) || o.timeframes.length === 0) {
    return { ok: false, error: 'timeframes wajib non-kosong' };
  }
  if (o.timeframes.length > 8) return { ok: false, error: 'timeframes terlalu banyak' };
  for (const t of o.timeframes as AnalystTimeframe[]) {
    if (!t || typeof t !== 'object') return { ok: false, error: 'timeframe rusak' };
    if (typeof t.tf !== 'string' || TF_RANK[t.tf] === undefined) {
      return { ok: false, error: `timeframe tidak dikenal: ${String(t.tf)}` };
    }
    if (t.trend !== 'up' && t.trend !== 'down' && t.trend !== 'range') {
      return { ok: false, error: `trend tidak valid pada ${t.tf}` };
    }
  }
  if (!Array.isArray(o.crossAsset) || o.crossAsset.length > 20) {
    return { ok: false, error: 'crossAsset tidak valid' };
  }
  if (!Array.isArray(o.warnings) || o.warnings.length > 10) {
    return { ok: false, error: 'warnings tidak valid' };
  }
  if (JSON.stringify(s).length > MAX_SNAPSHOT_BYTES) {
    return { ok: false, error: `snapshot melewati ${MAX_SNAPSHOT_BYTES} byte` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Guard 3 — output schema + content
// ---------------------------------------------------------------------------

const MAX_HEADLINE = 90;
const MAX_THESIS = 420;
const MAX_BULLET = 110;
const MAX_TOPDOWN = 4;
const MAX_CAVEATS = 3;

const ALLOWED_DIRECTION: readonly AnalystDirection[] = ['wait', 'prepare_long', 'prepare_short', 'hedge'];
const ALLOWED_CONVICTION: readonly AnalystConviction[] = ['low', 'medium', 'high'];

/** Directional language is allowed here; promises and executable orders are not. */
const FORBIDDEN: Array<{ re: RegExp; label: string }> = [
  { re: /\b(beli|jual|masuk|keluar)\s+(sekarang|langsung|saat ini|segera)\b/i, label: 'perintah eksekusi' },
  { re: /\b(kamu|kita|anda)\s+(harus|sebaiknya|disarankan)\s+(membeli|menjual)\b/i, label: 'saran eksekusi' },
  { re: /\b(target|take\s*profit|stop\s*loss)\b[^\n]{0,12}\d/i, label: 'target/SL/TP' },
  {
    re: /\b(jaminan|dijamin|pasti\s+(profit|untung|aman|naik|turun)|100%\s*aman|bebas\s+risiko|guaranteed)\b/i,
    label: 'janji hasil',
  },
  { re: /\ball\s*in\b|\bleverage\b|\bmargin\s+call\b/i, label: 'risiko berlebih' },
];

/**
 * Collect every number the model is allowed to cite: real numbers plus numbers
 * embedded in strings (macro fields are prose, e.g. "4.25-4.50%").
 */
export function collectInputNumbers(value: unknown, out: number[] = []): number[] {
  if (typeof value === 'number' && Number.isFinite(value)) out.push(value);
  else if (typeof value === 'string') out.push(...numbersIn(value));
  else if (Array.isArray(value)) for (const v of value) collectInputNumbers(v, out);
  else if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectInputNumbers(v, out);
  }
  return out;
}

export function firstForbidden(text: string): string | null {
  for (const { re, label } of FORBIDDEN) if (re.test(text)) return label;
  return null;
}

export function validateAnalystOutput(
  raw: string,
  inputNumbers: number[]
): { ok: true; value: AnalystModelOutput } | { ok: false; error: string } {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { ok: false, error: 'keluaran bukan JSON valid' };
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'JSON bukan objek' };
  const o = parsed as Record<string, unknown>;

  if (typeof o.direction !== 'string' || !ALLOWED_DIRECTION.includes(o.direction as AnalystDirection)) {
    return { ok: false, error: 'direction di luar enum' };
  }
  if (typeof o.conviction !== 'string' || !ALLOWED_CONVICTION.includes(o.conviction as AnalystConviction)) {
    return { ok: false, error: 'conviction di luar enum' };
  }
  if (typeof o.headline !== 'string' || o.headline.length === 0 || o.headline.length > MAX_HEADLINE) {
    return { ok: false, error: `headline harus 1-${MAX_HEADLINE} karakter` };
  }
  if (typeof o.thesis !== 'string' || o.thesis.length === 0 || o.thesis.length > MAX_THESIS) {
    return { ok: false, error: `thesis harus 1-${MAX_THESIS} karakter` };
  }
  if (typeof o.macroRead !== 'string' || o.macroRead.length === 0 || o.macroRead.length > MAX_THESIS) {
    return { ok: false, error: `macroRead harus 1-${MAX_THESIS} karakter` };
  }
  if (typeof o.confidence !== 'number' || o.confidence < 0 || o.confidence > 100) {
    return { ok: false, error: 'confidence harus 0-100' };
  }
  if (!Array.isArray(o.topDown) || o.topDown.length === 0 || o.topDown.length > MAX_TOPDOWN) {
    return { ok: false, error: `topDown wajib 1-${MAX_TOPDOWN} poin` };
  }
  if (o.topDown.some((x) => typeof x !== 'string' || x.length > MAX_BULLET)) {
    return { ok: false, error: `poin topDown melewati ${MAX_BULLET} karakter` };
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
    if (p[key] !== null && typeof p[key] !== 'string') {
      return { ok: false, error: `playbook.${key} harus string atau null` };
    }
  }

  const allText = [o.headline, o.thesis, o.macroRead, ...(o.topDown as string[]), ...(o.caveats as string[])]
    .concat([String(p.long ?? ''), String(p.short ?? ''), String(p.invalidation ?? '')])
    .join('\n');
  const banned = firstForbidden(allText);
  if (banned) return { ok: false, error: `frasa terlarang: ${banned}` };

  for (const field of [o.headline, o.thesis, o.macroRead, ...(o.topDown as string[]), ...(o.caveats as string[]),
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
      direction: o.direction as AnalystDirection,
      conviction: o.conviction as AnalystConviction,
      headline: o.headline,
      thesis: o.thesis,
      topDown: o.topDown as string[],
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
// Guard 4 — macro
// ---------------------------------------------------------------------------

const UNAVAILABLE_RE = /tidak\s+(ada|tersedia)|belum\s+(ada|tersedia|tersedia)|data\s+makro\s+(kosong|belum|tidak)/i;
const MACRO_CLAIM_RE =
  /\b(fed|fomc|cpi|inflasi|suku\s*bunga|interest\s*rate|yield|nfp|payroll|gdp|dxy|vix|sp500|s&p|treasury)\b/i;

export function hasMacroContent(macro: MacroContext | null): boolean {
  if (!macro) return false;
  return ['asOf', 'fedFundRate', 'dxy', 'btcDominance', 'sp500Trend', 'vix', 'treasury10y', 'gold', 'cpi', 'liquidityNote', 'upcomingEvents'].some(
    (k) => {
      const v = macro[k as keyof MacroContext];
      return Array.isArray(v) ? v.length > 0 : typeof v === 'string' && v.trim().length > 0;
    }
  );
}

export function macroGuard(
  macroRead: string,
  macro: MacroContext | null
): { ok: boolean; reason?: string } {
  if (!hasMacroContent(macro)) {
    if (!UNAVAILABLE_RE.test(macroRead)) {
      return { ok: false, reason: 'menyebut makro padahal tidak ada data makro' };
    }
    if (MACRO_CLAIM_RE.test(macroRead)) {
      return { ok: false, reason: 'menyebut event makro spesifik tanpa data' };
    }
    return { ok: true };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Guard 5 — direction vs higher timeframe
// ---------------------------------------------------------------------------

function htfTrend(timeframes: AnalystTimeframe[]): 'up' | 'down' | 'range' | null {
  const htf = timeframes.filter((t) => (TF_RANK[t.tf] ?? 99) <= HTF_MAX_RANK);
  if (htf.length === 0) return null;
  const ups = htf.filter((t) => t.trend === 'up').length;
  const downs = htf.filter((t) => t.trend === 'down').length;
  if (ups > 0 && downs === 0) return 'up';
  if (downs > 0 && ups === 0) return 'down';
  return 'range';
}

export function guardDirection(
  out: AnalystModelOutput,
  timeframes: AnalystTimeframe[]
): { direction: AnalystDirection; reason?: string } {
  const htf = htfTrend(timeframes);

  if (out.direction === 'wait' || out.direction === 'hedge') {
    return { direction: out.direction };
  }

  // A directional call needs at least medium conviction.
  if (out.conviction === 'low') {
    return { direction: 'wait', reason: 'conviction rendah tidak boleh arah directional' };
  }
  // The playbook must carry the side it is calling.
  if (out.direction === 'prepare_long' && !out.playbook.long) {
    return { direction: 'wait', reason: 'prepare_long tanpa skenario long' };
  }
  if (out.direction === 'prepare_short' && !out.playbook.short) {
    return { direction: 'wait', reason: 'prepare_short tanpa skenario short' };
  }
  // Top-down consistency: never fight the higher timeframe.
  if (out.direction === 'prepare_long' && htf === 'down') {
    return { direction: 'wait', reason: 'prepare_long melawan trend HTF turun' };
  }
  if (out.direction === 'prepare_short' && htf === 'up') {
    return { direction: 'wait', reason: 'prepare_short melawan trend HTF naik' };
  }
  return { direction: out.direction };
}

// ---------------------------------------------------------------------------
// Guard 1 — prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `Kamu adalah KEPALA STRATEGIS sekaligus SCALPER ELIT.
Perpaduan dua keahlian: disiplin top-down seorang hedge fund manager dan
ketajaman entry seorang scalper kripto & saham AS dengan track record profit
tinggi. Kamu membaca pattern di banyak timeframe sekaligus.

METODE WAJIB (top-down)
1. Makro dulu: liquidity, arah dana, risk-on/risk-off. Ini bias utama.
2. Higher timeframe (1w/1d/4h): tentukan bias struktural dan level kunci.
3. Lower timeframe (1h/15m): cari konfirmasi & timing, bukan bias.
4. Konfluence: arah TF besar + struktur + level + cross-asset harus sepaham.
5. Kalau TF besar tidak sepaham → TUNGGU. Kosong itu posisi.

SUMBER KEBENARAN
- Satu-satunya sumber fakta adalah objek JSON pada pesan user (INPUT).
- Setiap angka yang kamu tulis WAJIB ada di INPUT. Dilarang mengarang atau
  menurunkan statistik baru. Kalau ragu, tulis "tidak diketahui".
- Kamu TIDAK punya data makro live. Kalau field "macro" kosong di INPUT, kamu
  WAJIB menulis bahwa data makro tidak tersedia, dan DILARANG menyebut event
  makro spesifik (Fed, CPI, dst). Jangan mengarang berita.

FORMAT KELUARAN (WAJIB)
Keluarkan HANYA satu objek JSON, tanpa markdown, tanpa penjelasan. Skema:
{
  "direction": "wait|prepare_long|prepare_short|hedge",
  "conviction": "low|medium|high",
  "headline": "<=90 karakter, satu kalimat tesis utama",
  "thesis": "<=420 karakter, logika top-down singkat",
  "topDown": ["<=4 poin, HTF ke LTF, masing-masing <=110 karakter"],
  "macroRead": "<=420 karakter, baca makro ATAU nyatakan tidak tersedia",
  "playbook": {
    "long": "<skenario long, atau null>",
    "short": "<skenario short, atau null>",
    "invalidation": "<kondisi yang membatalkan tesis>"
  },
  "confidence": 0-100,
  "caveats": ["<=3 poin, masing-masing <=110 karakter"]
}

ATURAN KERAS (langgar = keluaran ditolak)
1. direction "prepare_long"/"prepare_short" hanya boleh saat conviction medium/high
   DAN playbook sisi itu terisi. Kalau ragu → "wait".
2. JANGAN melawan trend higher timeframe. prepare_long dilarang saat HTF turun;
   prepare_short dilarang saat HTF naik. Kalau melawan, pilih "wait".
3. JANGAN menulis perintah eksekusi ("beli sekarang", "jual sekarang", "segera masuk").
   Kamu menyusun SIAPSIAGA (persiapan), bukan mengeksekusi.
4. JANGAN memberi angka target harga, take-profit, atau stop-loss.
5. JANGAN menjanjikan keuntungan atau menjamin hasil.
6. JANGAN menyebut leverage / all in / margin call.
7. Selalu sertakan "invalidation": apa yang membatalkan tesismu.
8. Isi hanya bahasa Indonesia (nama aset/simbol bebas).

SEBELUM mengeluarkan JSON, periksa: setiap angka ada di INPUT? Arah tidak
melawan HTF? Kalau ragu, pilih direction "wait" dan conviction "low".`;

export function buildAnalystPrompt(snapshot: AnalystSnapshot): string {
  return `INPUT (JSON):\n${JSON.stringify(snapshot, null, 2)}`;
}

// ---------------------------------------------------------------------------
// Guard 6 — deterministic fallback
// ---------------------------------------------------------------------------

export function ruleAnalystFallback(snapshot: AnalystSnapshot): AnalystOutput {
  const htf = htfTrend(snapshot.timeframes);
  const highWarnings = snapshot.warnings.filter(
    (w) => w.severity === 'high' || w.severity === 'critical'
  );
  const macroOk = hasMacroContent(snapshot.macro);

  let direction: AnalystDirection = 'wait';
  let conviction: AnalystConviction = 'low';
  if (htf === 'up' && highWarnings.length === 0) {
    direction = 'prepare_long';
    conviction = 'medium';
  } else if (htf === 'down' && highWarnings.length === 0) {
    direction = 'prepare_short';
    conviction = 'medium';
  }

  const levels = snapshot.timeframes
    .filter((t) => t.keyLevel !== null)
    .slice(0, 3)
    .map((t) => `${t.tf} ${t.keyLevel}`);

  const long = direction === 'prepare_long' ? `Bias naik di TF besar; tunggu konfirmasi LTF di area ${levels.join(' / ') || 'level kunci'}.` : null;
  const short = direction === 'prepare_short' ? `Bias turun di TF besar; konfirmasi LTF di area ${levels.join(' / ') || 'level kunci'}.` : null;

  return {
    direction,
    conviction,
    headline:
      direction === 'wait'
        ? `Market ${snapshot.regime.regime}; belum ada konfluence yang layak masuk.`
        : `${direction === 'prepare_long' ? 'Persiapan long' : 'Persiapan short'} — bias HTF ${htf}.`,
    thesis:
      direction === 'wait'
        ? `HTF ${htf ?? 'tidak jelas'}, ${highWarnings.length} peringatan aktif. Aturan top-down: kosong dulu sampai TF sepaham.`
        : `HTF ${htf} dengan ${highWarnings.length} peringatan; structure dan level mendukung satu arah.`,
    topDown: snapshot.timeframes.map((t) => `${t.tf}: ${t.trend}/${t.structure}${t.rsi !== null ? `, RSI ${t.rsi}` : ''}`),
    macroRead: macroOk
      ? 'Data makro tersedia di input; baca di atas.'
      : 'Data makro tidak tersedia; bias diturunkan dari struktur harga saja.',
    playbook: {
      long,
      short,
      invalidation: `Batalkan jika ${levels[0] ?? 'level kunci'} ditembus dengan konfirmasi.`,
    },
    confidence: 60,
    caveats: ['Analisis rule-based, bukan pendapat AI.', 'Bukan instruksi eksekusi.'],
    source: 'rule_fallback',
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface AnalyseOptions {
  model?: string;
  call?: (prompt: string, opts?: CallLLMOptions) => Promise<string>;
}

/**
 * Produce the directional analysis. Never throws: any guard failure returns the
 * deterministic fallback, with `source` and `directionReason` explaining why.
 */
export async function analyse(snapshot: AnalystSnapshot, opts: AnalyseOptions = {}): Promise<AnalystOutput> {
  const inputGuard = validateAnalystSnapshot(snapshot);
  if (!inputGuard.ok) return { ...ruleAnalystFallback(snapshot), directionReason: inputGuard.error };

  const inputNumbers = collectInputNumbers(snapshot);
  const fallback = ruleAnalystFallback(snapshot);

  let raw: string;
  try {
    const call = opts.call ?? callLLM;
    raw = await call(buildAnalystPrompt(snapshot), { model: opts.model, system: SYSTEM_PROMPT });
  } catch (err) {
    return { ...fallback, directionReason: err instanceof Error ? err.message : 'model gagal' };
  }

  const checked = validateAnalystOutput(raw, inputNumbers);
  if (!checked.ok) {
    return { ...fallback, directionReason: `output ditolak: ${checked.error}` };
  }

  const macro = macroGuard(checked.value.macroRead, snapshot.macro);
  if (!macro.ok) {
    return { ...fallback, directionReason: `makro ditolak: ${macro.reason}` };
  }

  const { direction, reason } = guardDirection(checked.value, snapshot.timeframes);
  return {
    ...checked.value,
    direction,
    directionReason: reason,
    source: 'llm',
    model: opts.model || llmEnv().model,
  };
}
