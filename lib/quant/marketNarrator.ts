/**
 * Strict market narrator.
 *
 * Turns the deterministic scan output (regime, rankings, sector shifts,
 * warnings) into one short human digest for Telegram. The AI is interpretation
 * ONLY: it never invents numbers, never issues trade instructions, and never
 * picks an action outside a whitelist that this module re-validates in code.
 *
 * Strictness is layered — a prompt alone is not strict:
 *   1. Prompt lock  — role, scope, exact output schema, hard bans.
 *   2. Input guard  — snapshot must be well-formed and under the size cap.
 *   3. Output guard — strict JSON schema, enums, length caps, forbidden-phrase
 *                     scan, and a hallucinated-number scan against the input.
 *   4. Action guard — whitelist + severity gate + cooldown.
 *   5. Fallback     — any failure yields the deterministic rule digest.
 *
 * No new dependency: the validator is hand-rolled on purpose.
 */

import { NVIDIA_API_KEY, NVIDIA_INVOKE_URL } from '../config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NarratorSeverity = 'none' | 'low' | 'medium' | 'high' | 'critical';
export type NarratorAction = 'scan_now' | 'wait' | 'summarize';

export interface NarratorSnapshot {
  generatedAt: number;
  indexSymbol: string;
  regime: { regime: string; confidence: number };
  summary: {
    totalScanned: number;
    buySignals: number;
    sellSignals: number;
    neutralSignals: number;
  };
  topMovers: Array<{
    asset: string;
    direction: 'up' | 'down';
    confluenceScore: number;
    changePct: number;
  }>;
  sectorShifts: Array<{ sector: string; direction: 'heating' | 'cooling'; magnitude: number }>;
  warnings: Array<{ severity: NarratorSeverity; title: string; detail: string }>;
  recentHistory: Array<{ at: string; regime: string; buySignals: number; sellSignals: number }>;
}

/** Exactly what the model is asked to return. No source/model fields — we set those. */
export interface NarratorModelOutput {
  severity: NarratorSeverity;
  headline: string;
  summary: string;
  why: string[];
  action: NarratorAction;
  confidence: number;
  caveats: string[];
}

/** What this module returns to callers. */
export interface NarratorOutput extends NarratorModelOutput {
  source: 'llm' | 'rule_fallback';
  model?: string;
  actionReason?: string;
}

// ---------------------------------------------------------------------------
// Config (so the Antseed gateway at localhost:8379 can be used locally)
// ---------------------------------------------------------------------------

export function llmEnv(): {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  configured: boolean;
} {
  // LLM_BASE_URL must be the full chat-completions URL, e.g.
  //   NVIDIA:   https://integrate.api.nvidia.com/v1/chat/completions
  //   Antseed:  http://localhost:8379/v1/chat/completions
  const baseUrl = (process.env.LLM_BASE_URL || NVIDIA_INVOKE_URL).replace(/\/+$/, '');
  const apiKey = process.env.LLM_API_KEY || NVIDIA_API_KEY;
  const model = process.env.LLM_MODEL || 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning';
  // Reasoning models burn tokens on reasoning_content before content; give room.
  const maxTokens = Number(process.env.LLM_MAX_TOKENS || 1500);
  return { baseUrl, apiKey, model, maxTokens, configured: apiKey.length > 0 };
}

// ---------------------------------------------------------------------------
// Guard 2 — input
// ---------------------------------------------------------------------------

const MAX_SNAPSHOT_BYTES = 12_000;

export function validateSnapshot(s: unknown): { ok: boolean; error?: string } {
  if (!s || typeof s !== 'object') return { ok: false, error: 'snapshot harus objek' };
  const o = s as Record<string, unknown>;

  if (typeof o.generatedAt !== 'number' || !Number.isFinite(o.generatedAt)) {
    return { ok: false, error: 'generatedAt wajib angka' };
  }
  if (typeof o.indexSymbol !== 'string' || o.indexSymbol.length === 0) {
    return { ok: false, error: 'indexSymbol wajib string' };
  }
  if (!o.regime || typeof o.regime !== 'object') return { ok: false, error: 'regime wajib ada' };
  if (!o.summary || typeof o.summary !== 'object') return { ok: false, error: 'summary wajib ada' };

  if (!Array.isArray(o.topMovers) || o.topMovers.length > 20) {
    return { ok: false, error: 'topMovers tidak valid' };
  }
  if (!Array.isArray(o.sectorShifts) || o.sectorShifts.length > 20) {
    return { ok: false, error: 'sectorShifts tidak valid' };
  }
  if (!Array.isArray(o.warnings) || o.warnings.length > 10) {
    return { ok: false, error: 'warnings tidak valid' };
  }
  if (!Array.isArray(o.recentHistory) || o.recentHistory.length > 24) {
    return { ok: false, error: 'recentHistory tidak valid' };
  }

  // Keep the prompt cheap and well inside context.
  if (JSON.stringify(s).length > MAX_SNAPSHOT_BYTES) {
    return { ok: false, error: `snapshot melewati ${MAX_SNAPSHOT_BYTES} byte` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Guard 3 — output schema + content
// ---------------------------------------------------------------------------

const MAX_HEADLINE = 90;
const MAX_SUMMARY = 300;
const MAX_BULLET = 90;
const MAX_WHY = 3;
const MAX_CAVEATS = 2;

const ALLOWED_SEVERITY: readonly NarratorSeverity[] = ['none', 'low', 'medium', 'high', 'critical'];
const ALLOWED_ACTION: readonly NarratorAction[] = ['scan_now', 'wait', 'summarize'];

/** Phrases that turn a digest into a trade instruction or a promise. */
const FORBIDDEN: Array<{ re: RegExp; label: string }> = [
  { re: /\bbeli\s+(sekarang|langsung|saat ini|di level|di harga)\b/i, label: 'perintah beli' },
  { re: /\bjual\s+(sekarang|langsung|saat ini)\b/i, label: 'perintah jual' },
  {
    re: /\b(kamu|kita|anda)\s+(harus|sebaiknya|disarankan)\s+(membeli|menjual|memegang|masuk|keluar|entry|exit|menahan)\b/i,
    label: 'saran transaksi',
  },
  { re: /\b(target|take\s*profit|stop\s*loss)\b[^\n]{0,12}\d/i, label: 'target/SL/TP' },
  {
    re: /\b(jaminan|dijamin|pasti\s+(profit|untung|aman|naik|turun)|100%\s*aman|bebas\s+risiko|guaranteed)\b/i,
    label: 'janji hasil',
  },
  { re: /\b(buy|sell)\s+now\b/i, label: 'perintah now' },
  { re: /\ball\s*in\b|\bleverage\b|\bmargin\s+call\b/i, label: 'risiko berlebih' },
];

export function collectNumbers(value: unknown, out: number[] = []): number[] {
  if (typeof value === 'number' && Number.isFinite(value)) out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectNumbers(v, out);
  else if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectNumbers(v, out);
  }
  return out;
}

export function numbersIn(text: string): number[] {
  // The negative lookbehind stops a range hyphen ("66500-67000") from being
  // read as a minus sign, while a real negative ("-0.15%") still parses.
  const matches = text.match(/(?<![\d])-?\d+(?:[.,]\d+)?/g) || [];
  return matches.map((m) => Number(m.replace(',', '.'))).filter(Number.isFinite);
}

/**
 * A number is acceptable only if it already exists in the input (within
 * tolerance), or is a small structural integer (ordinals/counts). Anything
 * else is treated as a hallucinated stat.
 *
 * shortcut: derived ratios (e.g. "2x") are rejected. Relax here only if a
 * real digest needs them, and then pin the formula in code, not in the prompt.
 */
export function isKnownNumber(n: number, inputNumbers: number[]): boolean {
  if (Number.isInteger(n) && n >= 0 && n <= 9) return true;
  return inputNumbers.some((src) => Math.abs(src - n) <= Math.max(1e-6, Math.abs(src) * 1e-6));
}

function firstForbidden(text: string): string | null {
  for (const { re, label } of FORBIDDEN) if (re.test(text)) return label;
  return null;
}

/** Parse and strictly validate the model's raw text. Returns a typed value or a reason. */
export function validateModelOutput(
  raw: string,
  inputNumbers: number[]
): { ok: true; value: NarratorModelOutput } | { ok: false; error: string } {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { ok: false, error: 'keluaran bukan JSON valid' };
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'JSON bukan objek' };
  const o = parsed as Record<string, unknown>;

  if (typeof o.severity !== 'string' || !ALLOWED_SEVERITY.includes(o.severity as NarratorSeverity)) {
    return { ok: false, error: 'severity di luar enum' };
  }
  if (typeof o.action !== 'string' || !ALLOWED_ACTION.includes(o.action as NarratorAction)) {
    return { ok: false, error: 'action di luar whitelist' };
  }
  if (typeof o.headline !== 'string' || o.headline.length === 0 || o.headline.length > MAX_HEADLINE) {
    return { ok: false, error: `headline harus 1-${MAX_HEADLINE} karakter` };
  }
  if (typeof o.summary !== 'string' || o.summary.length === 0 || o.summary.length > MAX_SUMMARY) {
    return { ok: false, error: `summary harus 1-${MAX_SUMMARY} karakter` };
  }
  if (typeof o.confidence !== 'number' || o.confidence < 0 || o.confidence > 100) {
    return { ok: false, error: 'confidence harus 0-100' };
  }
  if (!Array.isArray(o.why) || o.why.length > MAX_WHY || o.why.some((w) => typeof w !== 'string')) {
    return { ok: false, error: `why harus array string (maks ${MAX_WHY})` };
  }
  if (!Array.isArray(o.caveats) || o.caveats.length > MAX_CAVEATS || o.caveats.some((c) => typeof c !== 'string')) {
    return { ok: false, error: `caveats harus array string (maks ${MAX_CAVEATS})` };
  }

  // Length caps on free text.
  if (o.why.some((w) => (w as string).length > MAX_BULLET)) {
    return { ok: false, error: `poin why melewati ${MAX_BULLET} karakter` };
  }
  if (o.caveats.some((c) => (c as string).length > MAX_BULLET)) {
    return { ok: false, error: `poin caveats melewati ${MAX_BULLET} karakter` };
  }

  // Forbidden instruction/promise phrases.
  const allText = [o.headline, o.summary, ...(o.why as string[]), ...(o.caveats as string[])].join('\n');
  const banned = firstForbidden(allText);
  if (banned) return { ok: false, error: `frasa terlarang: ${banned}` };

  // Hallucinated-number scan.
  for (const field of [o.headline, o.summary, ...(o.why as string[]), ...(o.caveats as string[])]) {
    for (const n of numbersIn(field as string)) {
      if (!isKnownNumber(n, inputNumbers)) {
        return { ok: false, error: `angka ${n} tidak ada di input` };
      }
    }
  }

  return {
    ok: true,
    value: {
      severity: o.severity as NarratorSeverity,
      headline: o.headline,
      summary: o.summary,
      why: o.why as string[],
      action: o.action as NarratorAction,
      confidence: Math.round(o.confidence),
      caveats: o.caveats as string[],
    },
  };
}

// ---------------------------------------------------------------------------
// Guard 4 — action
// ---------------------------------------------------------------------------

export interface ActionGuardOptions {
  now: number;
  lastActionAt: number | null;
  cooldownMs: number;
}

/**
 * The model may *suggest*, never decide. scan_now additionally requires
 * high/critical severity and a cooled-down window; anything else is downgraded.
 */
export function guardAction(
  action: NarratorAction,
  severity: NarratorSeverity,
  opts: ActionGuardOptions
): { action: NarratorAction; reason?: string } {
  if (action === 'scan_now') {
    if (severity !== 'high' && severity !== 'critical') {
      return { action: 'summarize', reason: 'scan_now butuh severity high/critical' };
    }
    if (opts.lastActionAt != null && opts.now - opts.lastActionAt < opts.cooldownMs) {
      return { action: 'summarize', reason: 'scan_now masih dalam cooldown' };
    }
    return { action: 'scan_now' };
  }
  if (action === 'summarize' || action === 'wait') return { action };
  return { action: 'wait', reason: 'action tidak dikenal' };
}

// ---------------------------------------------------------------------------
// Guard 1 — prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `Kamu adalah NARATOR PASAR untuk Althunter, mesin scanning kripto.
Peranmu HANYA: menerjemahkan angka hasil scan menjadi ringkasan pendek untuk manusia di Telegram.
Kamu BUKAN penasihat trading, BUKAN eksekutor, BUKAN pengambil keputusan.

SUMBER KEBENARAN
- Satu-satunya sumber fakta adalah objek JSON pada pesan user (INPUT).
- Setiap angka yang kamu tulis WAJIB ada di INPUT. Kalau tidak ada, jangan tulis.
  Kalau ragu, tulis "tidak diketahui".
- Dilarang mengarang, menebak, membulatkan ulang, atau menurunkan statistik baru
  yang tidak eksplisit ada di INPUT.

FORMAT KELUARAN (WAJIB)
Keluarkan HANYA satu objek JSON, tanpa markdown, tanpa penjelasan, tanpa komentar
sebelum atau sesudah. Skema persis:
{
  "severity": "none|low|medium|high|critical",
  "headline": "<=90 karakter, satu kalimat, fakta + arah",
  "summary": "<=300 karakter, 1-2 kalimat, apa yang berubah",
  "why": ["<=3 poin, masing-masing <=90 karakter"],
  "action": "scan_now|wait|summarize",
  "confidence": 0-100,
  "caveats": ["<=2 poin, masing-masing <=90 karakter"]
}

ATURAN KERAS (langgar = keluaran ditolak)
1. JANGAN pernah menyuruh membeli, menjual, masuk, keluar, atau mengubah ukuran
   posisi nyata. Tidak ada kalimat perintah transaksi.
2. JANGAN pernah menjanjikan keuntungan, menjamin hasil, atau memberi angka
   target harga / take-profit / stop-loss.
3. Kamu boleh melaporkan bahwa ENGINE menandai sesuatu, tapi JANGAN mengubahnya
   menjadi rekomendasi untuk bertindak.
4. JANGAN menambah aksi di luar: scan_now, wait, summarize.
5. Isi hanya bahasa Indonesia (nama aset/simbol bebas).
6. JANGAN membuat tabel, heading, atau bullet di luar field JSON.
7. JANGAN mengulang angka mentah tanpa konteks; selalu jelaskan artinya.

CARA MENILAI severity
- critical: regime berubah ATAU >=3 peringatan high, atau kerusakan data parah.
- high: >=1 peringatan high, atau pergerakan besar yang sudah terkonfirmasi.
- medium: ada perubahan tapi tidak mendesak.
- low/none: datar, tidak ada yang perlu dilihat manusia.
- action scan_now hanya boleh dipilih saat severity high/critical. Selain itu:
  wait atau summarize.

SEBELUM mengeluarkan JSON, periksa ulang: setiap angka ada di INPUT? Tidak ada
kalimat perintah transaksi? Kalau ragu, pilih severity paling rendah dan action "wait".`;

export function buildNarratorPrompt(snapshot: NarratorSnapshot): string {
  return `INPUT (JSON):\n${JSON.stringify(snapshot, null, 2)}`;
}

// ---------------------------------------------------------------------------
// Guard 5 — deterministic fallback
// ---------------------------------------------------------------------------

export function ruleNarratorFallback(snapshot: NarratorSnapshot): NarratorOutput {
  const highWarnings = snapshot.warnings.filter((w) => w.severity === 'high' || w.severity === 'critical');
  const severity: NarratorSeverity =
    snapshot.regime.regime.includes('crash') || highWarnings.length >= 3
      ? 'critical'
      : highWarnings.length >= 1
        ? 'high'
        : snapshot.sectorShifts.length > 0
          ? 'medium'
          : 'low';

  const movers = snapshot.topMovers.slice(0, 3);
  const moversText =
    movers.length > 0
      ? movers
          .map((m) => `${m.asset} ${m.direction === 'up' ? 'naik' : 'turun'} ${m.changePct}%`)
          .join(', ')
      : 'tidak ada pergerakan besar';

  const headline =
    severity === 'low'
      ? `Market ${snapshot.regime.regime}, tidak ada yang perlu dilihat.`
      : `Regime ${snapshot.regime.regime}; ${highWarnings.length} peringatan aktif.`;

  return {
    severity,
    headline,
    summary: `${snapshot.summary.totalScanned} aset dipindai: ${snapshot.summary.buySignals} sinyal naik, ${snapshot.summary.sellSignals} sinyal turun. Pergerakan terbesar: ${moversText}.`,
    why: highWarnings.slice(0, 3).map((w) => `${w.title} — ${w.detail}`),
    action: severity === 'high' || severity === 'critical' ? 'scan_now' : 'wait',
    confidence: 100,
    caveats: ['Ringkasan rule-based, bukan pendapat AI.'],
    source: 'rule_fallback',
  };
}

// ---------------------------------------------------------------------------
// Model call
// ---------------------------------------------------------------------------

export interface CallLLMOptions {
  model?: string;
  system?: string;
}

/** Shared OpenAI-compatible chat call. Reused by the analyst module. */
export async function callLLM(prompt: string, opts: CallLLMOptions = {}): Promise<string> {
  const env = llmEnv();
  if (!env.configured) throw new Error('LLM_API_KEY belum diset');
  const res = await fetch(env.baseUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: opts.system ?? SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      model: opts.model || env.model,
      max_tokens: env.maxTokens,
      temperature: 0.2,
      top_p: 0.9,
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const data = await res.json();
  const msg = data.choices?.[0]?.message as
    | { content?: string | null; reasoning_content?: string | null }
    | undefined;
  const text = (msg?.content || msg?.reasoning_content || '').trim();
  if (!text) throw new Error('LLM mengembalikan kosong');
  return text;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface NarrateOptions {
  now?: number;
  lastActionAt?: number | null;
  cooldownMs?: number;
  model?: string;
  /** Inject a model call for testing; defaults to the configured HTTP endpoint. */
  call?: (prompt: string, opts?: CallLLMOptions) => Promise<string>;
}

/**
 * Produce the digest. Never throws: any guard failure returns the
 * deterministic fallback, and the returned `source` tells the caller which.
 */
export async function narrate(
  snapshot: NarratorSnapshot,
  opts: NarrateOptions = {}
): Promise<NarratorOutput> {
  const inputGuard = validateSnapshot(snapshot);
  if (!inputGuard.ok) return { ...ruleNarratorFallback(snapshot), actionReason: inputGuard.error };

  const inputNumbers = collectNumbers(snapshot);
  const now = opts.now ?? Date.now();
  const lastActionAt = opts.lastActionAt ?? null;
  const cooldownMs = opts.cooldownMs ?? 30 * 60_000;

  let raw: string;
  try {
    const call = opts.call ?? callLLM;
    raw = await call(buildNarratorPrompt(snapshot), { model: opts.model });
  } catch (err) {
    return {
      ...ruleNarratorFallback(snapshot),
      actionReason: err instanceof Error ? err.message : 'model gagal',
    };
  }

  const checked = validateModelOutput(raw, inputNumbers);
  if (!checked.ok) {
    return { ...ruleNarratorFallback(snapshot), actionReason: `output ditolak: ${checked.error}` };
  }

  const { action, reason } = guardAction(checked.value.action, checked.value.severity, {
    now,
    lastActionAt,
    cooldownMs,
  });

  return { ...checked.value, action, actionReason: reason, source: 'llm' };
}
