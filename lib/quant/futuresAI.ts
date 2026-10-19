/**
 * Analisis AI futures: S&R, pola HTF, arah, dan sinyal per instrumen.
 *
 * AI hanya interpretasi: tidak ada perintah beli/jual, tidak ada janji profit,
 * semua level harga harus turun dari data candlestick input (tidak halusinasi).
 * Setiap kegagalan → fallback aturan, tidak pernah diam-diam.
 */

import { callLLM, type CallLLMOptions } from './marketNarrator';

export type FuturesAIDirection = 'long' | 'short' | 'wait';
export type FuturesAISignal = 'buy' | 'sell' | 'wait';

export interface FuturesAIInput {
  symbol: string;
  name: string;
  group: 'crypto' | 'commodity' | 'equity';
  price: number;
  changePct: number;
  verdict: FuturesAIDirection;
  score: number;
  atrPct: number;
  technicalReasons: string[];
  alignment: Array<{ tf: string; label: string; verdict: FuturesAIDirection; score: number }>;
  macroNote: string;
  macro: { dxy: number | null; vix: number | null; us10y: number | null };
  /** Last closed bars of the active timeframe (max ~60). */
  candles: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>;
}

export interface FuturesAIOutput {
  symbol: string;
  direction: FuturesAIDirection;
  confidence: number; // 0-100
  support: number | null;
  resistance: number | null;
  pattern: string; // deskriptif, bukan prediksi
  htfBias: string; // ringkasan 1H/4H/Daily/Weekly
  signal: FuturesAISignal;
  reasoning: string[]; // maks 3 poin, bahasa Indonesia
  caveat: string; // disclaimer risiko
  source: 'llm' | 'rule_fallback';
}

/** Guardrail: frasi yang melarang model menjadi penasihat transaksi. */
const FORBIDDEN: Array<{ re: RegExp; label: string }> = [
  { re: /\b(beli|jual|masuk|keluar|entry|exit|open)\s+(sekarang|langsung|saat ini|di level|di harga)\b/i, label: 'perintah transaksi' },
  { re: /\b(kamu|kita|anda)\s+(harus|sebaiknya|disarankan)\s+(membeli|menjual|memegang|menahan)\b/i, label: 'saran transaksi' },
  { re: /\b(jaminan|dijamin|pasti\s+(profit|untung|aman|naik|turun)|100%\s*aman|bebas\s+risiko|guaranteed)\b/i, label: 'janji hasil' },
  { re: /\btarget\s*harga|take\s*profit|stop\s*loss\b/i, label: 'target/SL/TP dari AI' },
  { re: /\ball\s*in\b|\bleverage\b|\bmargin\s+call\b/i, label: 'risiko berlebih' },
];

const MAX_REASONING = 3;
const MAX_REASONING_LEN = 100;

function swap(side: 'buy' | 'sell'): 'buy' | 'sell' {
  return side === 'buy' ? 'sell' : 'buy';
}

/** Fallback aturan: turun sepenuhnya dari input, tidak memakai model. */
export function ruleFallback(input: FuturesAIInput): FuturesAIOutput {
  const candles = input.candles.slice(-60);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);

  const resistance = highs.length ? Math.max(...highs) : null;
  const support = lows.length ? Math.min(...lows) : null;

  const upCount = closes.reduce((n, c, i) => (i > 0 && c > closes[i - 1] ? n + 1 : n), 0);
  const downCount = closes.reduce((n, c, i) => (i > 0 && c < closes[i - 1] ? n + 1 : n), 0);

  let direction: FuturesAIDirection = input.verdict;
  let signal: FuturesAISignal = 'wait';
  let pattern = '';
  let htfBias = '';

  const htfLong = input.alignment.filter((a) => a.verdict === 'long').length;
  const htfShort = input.alignment.filter((a) => a.verdict === 'short').length;
  if (htfLong >= htfShort && htfLong > 0) {
    htfBias = `Kecenderungan naik di ${input.alignment.filter((a) => a.verdict === 'long').map((a) => a.label).join('/')}.`;
    if (direction === 'long') signal = 'buy';
  } else if (htfShort > htfLong && htfShort > 0) {
    htfBias = `Kecenderungan turun di ${input.alignment.filter((a) => a.verdict === 'short').map((a) => a.label).join('/')}.`;
    if (direction === 'short') signal = 'sell';
  } else {
    htfBias = 'Timeframe lebih tinggi tidak menunjukkan arah yang bersesuaian.';
  }

  if (upCount > downCount * 1.3) pattern = 'Struktur candlestick cenderung naik pada bar terakhir.';
  else if (downCount > upCount * 1.3) pattern = 'Struktur candlestick cenderung turun pada bar terakhir.';
  else pattern = 'Candlestick bergerak sideways, belum ada pola breakout yang jelas.';

  const reasoning: string[] = [];
  if (input.technicalReasons.length) reasoning.push(input.technicalReasons.slice(0, 2).join('; '));
  reasoning.push(input.macroNote || 'Macro netral.');

  return {
    symbol: input.symbol,
    direction,
    confidence: Math.round(input.score),
    support: support ? Number(support.toFixed(2)) : null,
    resistance: resistance ? Number(resistance.toFixed(2)) : null,
    pattern,
    htfBias,
    signal,
    reasoning: reasoning.slice(0, MAX_REASONING),
    caveat: 'Analisis ini bukan rekomendasi transaksi. Level harga dihitung dari candlestick terakhir, bukan janji harga akan menjujurnya.',
    source: 'rule_fallback',
  };
}

/** Prompt untuk model: struktur ketat, bahasa Indonesia, tanpa saran transaksi. */
export function buildPrompt(input: FuturesAIInput): string {
  const align = input.alignment
    .map((a) => `- ${a.label}: ${a.verdict.toUpperCase()} (skor ${Math.round(a.score * 100)})`)
    .join('\n');
  const recent = input.candles.slice(-20).map((c) => `O${c.open} H${c.high} L${c.low} C${c.close}`).join(' | ');

  return `Kamu adalah ANALIS TEKNIS FUTURES untuk Althunter. Tugasmu: baca data candlestick dan sinyal engine, lalu tulis analisis pendek per instrumen. Kamu BUKAN penasihat trading, BUKAN eksekutor, BUKAN janji profit.

INPUT (satu-satunya sumber fakta):
- Aset: ${input.symbol} (${input.name}, ${input.group})
- Harga kini: ${input.price}
- Perubahan: ${(input.changePct * 100).toFixed(2)}%
- Sinyal engine: ${input.verdict.toUpperCase()} (skor ${input.score}, ATR% ${input.atrPct.toFixed(2)})
- Alasan teknis engine: ${input.technicalReasons.join('; ')}
- Align timeframe lebih tinggi:\n${align}
- Makro: DXY=${input.macro.dxy ?? '—'}, VIX=${input.macro.vix ?? '—'}, US10Y=${input.macro.us10y ?? '—'}
- Candlestick terbaru (O/H/L/C): ${recent}

KELUARAN WAJIB (hanya satu objek JSON, tanpa markdown):
{
  "direction": "long|short|wait",
  "confidence": 0-100,
  "support": <angka atau null, harus ada di data candlestick input>,
  "resistance": <angka atau null, harus ada di data candlestick input>,
  "pattern": "<deskripsi pola candlestick/HTF, maks 80 kata, bahasa Indonesia>",
  "htfBias": "<ringkasan arah 1H/4H/Daily/Weekly, maks 80 kata, bahasa Indonesia>",
  "signal": "buy|sell|wait",
  "reasoning": ["<=3 poin, masing-masing <=100 karakter, bahasa Indonesia"],
  "caveat": "<disclaimer risiko, maks 120 karakter, bahasa Indonesia>"
}

ATURAN KERAS:
1. Tidak boleh ada kata perintah transaksi ("beli sekarang", "jual sekarang", "harus beli", "harus jual", "entry", "exit", "masuk", "keluar").
2. Tidak boleh janji profit, target harga, take-profit, stop-loss, atau "100% aman".
3. Support/resistance harus diambil dari high/low candlestick input di atas, tidak boleh diarang.
4. Sinyal "buy"/"sell" hanyalah kecenderungan, bukan instruksi; gunakan kata "cenderung", "kemungkinan".
5. Semua teks dalam bahasa Indonesia (nama aset/simbol bebas).
6. Jika tidak yakin, pilih direction "wait", signal "wait", dan confidensi rendah.

SEBELUM mengeluarkan JSON, verifikasi: setiap angka support/resistance ada di data candlestick input? Tidak ada frasi perintah transaksi? Jika ragu, arahkan ke "wait".`;
}

const ALLOWED_DIRECTION: readonly FuturesAIDirection[] = ['long', 'short', 'wait'];
const ALLOWED_SIGNAL: readonly FuturesAISignal[] = ['buy', 'sell', 'wait'];

/** Validasi output model; kembalikan parsed value atau alasan penolakan. */
export function validateModelOutput(
  raw: string,
  input: FuturesAIInput
): { ok: true; value: FuturesAIOutput } | { ok: false; error: string } {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { ok: false, error: 'keluaran bukan JSON valid' };
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'JSON bukan objek' };
  const o = parsed as Record<string, unknown>;

  const direction = o.direction;
  if (typeof direction !== 'string' || !ALLOWED_DIRECTION.includes(direction as FuturesAIDirection)) {
    return { ok: false, error: 'direction di luar enum' };
  }
  const confidence = o.confidence;
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 100) {
    return { ok: false, error: 'confidence harus 0-100' };
  }
  const support = o.support;
  if (support != null && (typeof support !== 'number' || !Number.isFinite(support))) {
    return { ok: false, error: 'support harus angka atau null' };
  }
  const resistance = o.resistance;
  if (resistance != null && (typeof resistance !== 'number' || !Number.isFinite(resistance))) {
    return { ok: false, error: 'resistance harus angka atau null' };
  }
  const pattern = o.pattern;
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > 400) {
    return { ok: false, error: 'pattern harus 1-400 karakter' };
  }
  const htfBias = o.htfBias;
  if (typeof htfBias !== 'string' || htfBias.length === 0 || htfBias.length > 400) {
    return { ok: false, error: 'htfBias harus 1-400 karakter' };
  }
  const signal = o.signal;
  if (typeof signal !== 'string' || !ALLOWED_SIGNAL.includes(signal as FuturesAISignal)) {
    return { ok: false, error: 'signal di luar enum' };
  }
  if (!Array.isArray(o.reasoning) || o.reasoning.length > MAX_REASONING || o.reasoning.some((r) => typeof r !== 'string')) {
    return { ok: false, error: `reasoning harus array string (maks ${MAX_REASONING})` };
  }
  if (o.reasoning.some((r) => (r as string).length > MAX_REASONING_LEN)) {
    return { ok: false, error: `poin reasoning melewati ${MAX_REASONING_LEN} karakter` };
  }
  const caveat = o.caveat;
  if (typeof caveat !== 'string' || caveat.length === 0 || caveat.length > 160) {
    return { ok: false, error: 'caveat harus 1-160 karakter' };
  }

  // Forbidden phrase scan.
  const allText = [pattern, htfBias, ...(o.reasoning as string[]), caveat].join('\n');
  const banned = firstForbidden(allText);
  if (banned) return { ok: false, error: `frasi terlarang: ${banned}` };

  // Support/resistance must be derivable from input candles (approximate tolerance).
  const candleNumbers = input.candles.flatMap((c) => [c.open, c.high, c.low, c.close]);
  if (support != null && !isNearCandleNumber(support, candleNumbers)) {
    return { ok: false, error: `support ${support} tidak ada di candlestick input` };
  }
  if (resistance != null && !isNearCandleNumber(resistance, candleNumbers)) {
    return { ok: false, error: `resistance ${resistance} tidak ada di candlestick input` };
  }

  return {
    ok: true,
    value: {
      symbol: input.symbol,
      direction: direction as FuturesAIDirection,
      confidence: Math.round(confidence),
      support: support != null ? Number(support.toFixed(2)) : null,
      resistance: resistance != null ? Number(resistance.toFixed(2)) : null,
      pattern,
      htfBias,
      signal: signal as FuturesAISignal,
      reasoning: (o.reasoning as string[]).slice(0, MAX_REASONING),
      caveat,
      source: 'llm',
    },
  };
}

function firstForbidden(text: string): string | null {
  for (const { re, label } of FORBIDDEN) if (re.test(text)) return label;
  return null;
}

/** Angka dianggap valid jika mendekati open/high/low/close dari candle input (toleransi 0.5%). */
function isNearCandleNumber(n: number, candles: number[]): boolean {
  return candles.some((c) => Math.abs(c - n) <= Math.max(0.01, Math.abs(c) * 0.005));
}

/** Titik masuk utama: coba model, kalau gagal → rule fallback. Tidak pernah throw. */
export async function analyzeFutures(
  input: FuturesAIInput,
  opts: CallLLMOptions = {}
): Promise<FuturesAIOutput> {
  try {
    const raw = await callLLM(buildPrompt(input), opts);
    const checked = validateModelOutput(raw, input);
    if (checked.ok) return checked.value;
    return { ...ruleFallback(input), source: 'rule_fallback' };
  } catch {
    return ruleFallback(input);
  }
}
