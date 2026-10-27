/**
 * AI Arena engine: tiap model LLM dari gateway AntSeed dapat modal $1000 dan
 * trade otonom di unified universe (semua engine signals via paperMultiTf).
 * Target evaluasi = R-multiple (expectancy per 1R), BUKAN win rate.
 * Tiap model bebas iterasi param-nya sendiri antar step.
 */
import { Candle } from '../types';
import { atr } from '../algorithms/indicators';
import { StepMarketSnapshot } from './paperEngine';

export const ARENA_STARTING_CAPITAL = 1000;

const ATR_MIN = 0.8, ATR_MAX = 6;
const TARGET_MIN = 0.5, TARGET_MAX = 10;
const STR_MIN = 3, STR_MAX = 9.5;
const POS_MIN = 1, POS_MAX = 5;
const HOLD_MIN = 6, HOLD_MAX = 96;
// GUARDRAIL RIGID (engine-level, bukan cuma prompt):
const RISK_PER_TRADE_MIN = 0.005, RISK_PER_TRADE_MAX = 0.03; // 1 trade maks 3% equity
const RISK_R_MAX = 0.06; // total open risk maks 6% equity (=2-6R per sesi)
const CIRCUIT_R = -3;    // open unrealized R total ≤ -3R → stop entry sampan pulih
const KNOCKOUT_EQ = ARENA_STARTING_CAPITAL / 2; // equity ≤ $500 → KO, ditiadakan dari arena

export interface ArenaParams {
  stopLossATR: number;
  takeProfitATR: number;
  minSignalStrength: number;
  maxConcurrentPositions: number;
  maxHoldBars: number;
  riskPerTrade: number; // fraksi equity yang dipertaruhkan per trade (1R)
  allowShort: boolean;
  interval: string; // '15m' | '1h' | '4h'
}

export interface ArenaPosition {
  symbol: string;
  side: 'long' | 'short';
  entryTime: number;
  entryPrice: number;
  entryATR: number;
  qty: number;
  stopLoss: number;
  takeProfit: number;
  barsHeld: number;
  riskDollar: number; // dollar yang dipertaruhkan saat entry (1R) — beku, tidak ikut tune
  reason: string;
}

export interface ArenaTrade {
  symbol: string;
  side: 'long' | 'short';
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  r: number; // pnl / riskDollar — satu angka yang dinilai
  reason: string;
  exitReason: string;
}

export interface ArenaState {
  model: string;
  running: boolean;
  startedAt: number;
  updatedAt: number;
  params: ArenaParams;
  cash: number;
  peakEquity: number;
  positions: ArenaPosition[];
  trades: ArenaTrade[]; // newest first, cap 200
  log: string[];
  iterNote: string; // refleksi iterasi terakhir model
  /** Process persona: arketipe gaya trading — dijamin beda antar peserta */
  archetype: string;
  mandate: string;
  classes: string[]; // kelas sinyal yang diperbolehkan (spike|decoupling|momentum)
  /** Feed "isi pikiran" realtime: thought + versi bahasa awam + rencana (plan) tiap step terbaru di depan */
  thoughts: Array<{ time: number; thought: string; thoughtPlain: string; plan: string; planPlain: string; actions: string }>;
  iterCount: number;
  rankNote?: string; // diisi engine per step, transien (bukan perpindahan state)
  terminated?: boolean; // gateway menolak permanen (402/404) — agent tak dihidupkan ulang otomatis
  lastBarKey: string;
  lastPrices: Record<string, number>;
  equityHistory: Array<{ time: number; equity: number }>;
  stats: { totalTrades: number; wins: number; winRate: number; totalR: number; avgR: number; bestR: number; worstR: number; ProfitFactor: number };
}

export const DEFAULT_ARENA_PARAMS: ArenaParams = {
  stopLossATR: 2,
  takeProfitATR: 4,
  minSignalStrength: 6,
  maxConcurrentPositions: 4,
  maxHoldBars: 48,
  riskPerTrade: 0.02,
  allowShort: true,
  interval: '1h',
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/* ---------------- Arketipe: bak tiap model diberi gaya trading UNIK ---------------- */
/* Saat iterasi mereka bebas di dalam rentang arketipe-nya; mewakili metode sama
   persis dengan peserta lain di-tolak style-guard (lihat API step). */

export interface Archetype {
  name: string;
  mandate: string;
  classes: string[]; // 'spike' | 'decoupling' | 'momentum'
  interval: string;
  params: Partial<ArenaParams>; // titik berangkat
  ranges: Partial<Record<'stopLossATR' | 'takeProfitATR' | 'minSignalStrength' | 'maxHoldBars' | 'riskPerTrade' | 'maxConcurrentPositions', [number, number]>>;
}

export const ARCHETYPES: Archetype[] = [
  {
    name: 'Trend Sniper',
    mandate: 'trend-follower: masuk mengikuti momentum+MTF confluence saat alignment, hold saat trend tahan, tumpang target jauh',
    classes: ['momentum'],
    interval: '4h',
    params: { stopLossATR: 2.5, takeProfitATR: 7, minSignalStrength: 6.5, maxConcurrentPositions: 3, maxHoldBars: 72, riskPerTrade: 0.02, allowShort: true },
    ranges: { stopLossATR: [1.5, 4], takeProfitATR: [5, 10], minSignalStrength: [5, 9], maxHoldBars: [36, 96], riskPerTrade: [0.01, 0.03] },
  },
  {
    name: 'Spike Hunter',
    mandate: 'vol-spike hunter: HANYA sinyal spike volume — masuk cepat after spike, target pendek, stop ketat, frekuensi tinggi',
    classes: ['spike'],
    interval: '1h',
    params: { stopLossATR: 1.2, takeProfitATR: 2, minSignalStrength: 5, maxConcurrentPositions: 5, maxHoldBars: 12, riskPerTrade: 0.015, allowShort: true },
    ranges: { stopLossATR: [0.8, 2], takeProfitATR: [1, 3.5], minSignalStrength: [3, 7], maxHoldBars: [6, 24], riskPerTrade: [0.01, 0.025] },
  },
  {
    name: 'Decoupling Arbitrageur',
    mandate: 'RS decoupling: hanya main asset yang lepas dari indeks benchmark (relative strength), short yang melemah vs index',
    classes: ['decoupling'],
    interval: '4h',
    params: { stopLossATR: 2, takeProfitATR: 5, minSignalStrength: 6, maxConcurrentPositions: 4, maxHoldBars: 60, riskPerTrade: 0.018, allowShort: true },
    ranges: { stopLossATR: [1.2, 3.5], takeProfitATR: [3, 8], minSignalStrength: [5, 9], maxHoldBars: [24, 96], riskPerTrade: [0.008, 0.03] },
  },
  {
    name: 'Mean-Reversion Scalper',
    mandate: 'mean reversion scalper: tag Buy di spiral/overshoot momentum down & sebaliknya, target cepat pendek, modal kecil per trade banyak transaksi',
    classes: ['momentum', 'spike'],
    interval: '15m',
    params: { stopLossATR: 1.5, takeProfitATR: 1.6, minSignalStrength: 5.5, maxConcurrentPositions: 4, maxHoldBars: 16, riskPerTrade: 0.01, allowShort: true },
    ranges: { stopLossATR: [0.8, 2.2], takeProfitATR: [0.5, 3], minSignalStrength: [4, 8], maxHoldBars: [6, 30], riskPerTrade: [0.005, 0.02] },
  },
  {
    name: 'Asymmetric Whale',
    mandate: 'asymmetric low-frequency: jarang entry, CUMA setup force majeure strength tinggi, tapi bila entry target jauh (wide RR) & risiko besar-besaran',
    classes: ['momentum', 'decoupling', 'spike'],
    interval: '4h',
    params: { stopLossATR: 3.5, takeProfitATR: 9, minSignalStrength: 8, maxConcurrentPositions: 2, maxHoldBars: 96, riskPerTrade: 0.03, allowShort: false },
    ranges: { stopLossATR: [2.5, 6], takeProfitATR: [6, 10], minSignalStrength: [7, 9.5], maxHoldBars: [48, 96], riskPerTrade: [0.02, 0.03] },
  },
  {
    name: 'Patient Compounder',
    mandate: 'conservative compounder: risiko mini per trade, banyak posisi kecil passive, exit saat target RR hemat; menang dari konsistensi, BUKAN nuklir',
    classes: ['momentum', 'decoupling'],
    interval: '1h',
    params: { stopLossATR: 1.8, takeProfitATR: 3.5, minSignalStrength: 6.8, maxConcurrentPositions: 5, maxHoldBars: 48, riskPerTrade: 0.007, allowShort: true },
    ranges: { stopLossATR: [1, 3], takeProfitATR: [2, 5], minSignalStrength: [5.5, 9], maxHoldBars: [24, 72], riskPerTrade: [0.005, 0.015] },
  },
];

/** pilih arketipe yang belum dipakai peserta lain; kalau semua terpakai, pilih via hash model */
export function pickArchetype(model: string, taken: string[]): Archetype {
  const used = new Set(taken);
  const unused = ARCHETYPES.filter((a) => !used.has(a.name));
  if (unused.length > 0) {
    // deterministik dari nama model seeded biar stabil antar run
    let h = 0;
    for (const ch of model) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return unused[h % unused.length];
  }
  let h = 0;
  for (const ch of model) h = (h * 17 + ch.charCodeAt(0)) >>> 0;
  return ARCHETYPES[h % ARCHETYPES.length];
}

export function archetypeRange(a: Archetype, key: keyof ArenaParams): [number, number] {
  const r = a.ranges[key as keyof Archetype['ranges']];
  if (r) return r as [number, number];
  const base: Record<string, [number, number]> = {
    stopLossATR: [ATR_MIN, ATR_MAX],
    takeProfitATR: [TARGET_MIN, TARGET_MAX],
    minSignalStrength: [STR_MIN, STR_MAX],
    maxConcurrentPositions: [POS_MIN, POS_MAX],
    maxHoldBars: [HOLD_MIN, HOLD_MAX],
    riskPerTrade: [RISK_PER_TRADE_MIN, RISK_PER_TRADE_MAX],
  };
  return base[key as string] ?? [0, Infinity];
}

function classifySignal(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes('spike')) return 'spike';
  if (r.includes('decoupl')) return 'decoupling';
  return 'momentum';
}

/** fingerprint gaya — dipakai style-guard biar tak ada 2 peserta main sama persis */
export function styleFingerprint(s: Pick<ArenaState, 'params'>): string {
  const p = s.params;
  return [
    p.interval,
    (Math.round(p.stopLossATR * 2) / 2),
    (Math.round(p.takeProfitATR * 2) / 2),
    (Math.round(p.minSignalStrength * 2) / 2),
    p.maxConcurrentPositions,
    p.allowShort ? 'L+S' : 'long-only',
  ].join('|');
}

/** Peserta ke-7+ memakai arketipe yang sudah terpakai (hash). Kalau fingerprint-nya
 *  identik dengan peserta lain se-arketipe (termasuk saat lahir), puter-kan
 *  takeProfitATR di dalam rentang arketipe sampai unik; kalau masih juga, balik
 *  allowShort. Deterministik dari nama model → stabil antar run. */
export function ensureStyleUnique(s: ArenaState, others: ArenaState[]): void {
  const clash = () =>
    others.some((o) => o.model !== s.model && o.archetype === s.archetype && styleFingerprint(o) === styleFingerprint(s));
  if (!clash()) return;
  let h = 0;
  for (const ch of s.model) h = (h * 17 + ch.charCodeAt(0)) >>> 0;
  const arch = ARCHETYPES.find((a) => a.name === s.archetype);
  const [lo, hi] = ARCHETYPES.length && arch ? archetypeRange(arch, 'takeProfitATR') : [TARGET_MIN, TARGET_MAX];
  const span = hi - lo;
  for (let i = 0; i < 24 && clash(); i++) {
    s.params.takeProfitATR = lo + (((h + i * 7) % 100) / 100) * span;
  }
  if (clash()) s.params.allowShort = !s.params.allowShort;
  s.log = [...(s.log || []), `[style] fingerprint diidupkan unik: TP=${s.params.takeProfitATR.toFixed(2)} ATR${s.params.allowShort ? ' · short on' : ' · short off'}`];
}

export function createArenaState(model: string, arch?: Archetype): ArenaState {
  const a = arch || pickArchetype(model, []);
  const params: ArenaParams = {
    ...DEFAULT_ARENA_PARAMS,
    ...(a.params as Partial<ArenaParams>),
    interval: a.interval,
  };
  return {
    model,
    running: true,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    params,
    archetype: a.name,
    mandate: a.mandate,
    classes: [...a.classes],
    cash: ARENA_STARTING_CAPITAL,
    peakEquity: ARENA_STARTING_CAPITAL,
    positions: [],
    trades: [],
    log: [`[start] ${model} online · capital $${ARENA_STARTING_CAPITAL} · mission: maximize R expectancy`],
    iterNote: '',
    thoughts: [],
    iterCount: 0,
    lastBarKey: '',
    lastPrices: {},
    equityHistory: [{ time: Date.now(), equity: ARENA_STARTING_CAPITAL }],
    stats: { totalTrades: 0, wins: 0, winRate: 0, totalR: 0, avgR: 0, bestR: 0, worstR: 0, ProfitFactor: 0 },
  };
}

function recalcStats(s: ArenaState) {
  const wins = s.trades.filter((t) => t.pnl > 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(s.trades.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0));
  const totalR = s.trades.reduce((a, t) => a + t.r, 0);
  s.stats = {
    totalTrades: s.trades.length,
    wins: wins.length,
    winRate: s.trades.length ? (wins.length / s.trades.length) * 100 : 0,
    totalR: Math.round(totalR * 100) / 100,
    avgR: s.trades.length ? Math.round((totalR / s.trades.length) * 1000) / 1000 : 0,
    bestR: s.trades.length ? Math.max(...s.trades.map((t) => t.r)) : 0,
    worstR: s.trades.length ? Math.min(...s.trades.map((t) => t.r)) : 0,
    ProfitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : grossWin > 0 ? 99 : 0,
  };
}

export function arenaEquity(s: ArenaState): number {
  let eq = s.cash;
  for (const p of s.positions) {
    const px = s.lastPrices[p.symbol] ?? p.entryPrice;
    eq += p.side === 'long' ? p.qty * (px - p.entryPrice) : p.qty * (p.entryPrice - px);
  }
  return eq;
}

function pushLog(s: ArenaState, msg: string) {
  s.log = [`[${new Date().toISOString().slice(11, 19)}] ${msg}`, ...s.log].slice(0, 60);
}

function closeArena(s: ArenaState, pos: ArenaPosition, exitTime: number, exitPx: number, reason: string) {
  const pnl =
    pos.side === 'long'
      ? pos.qty * (exitPx - pos.entryPrice)
      : pos.qty * (pos.entryPrice - exitPx);
  const riskDollar = pos.riskDollar || pos.qty * pos.entryATR * s.params.stopLossATR || 1;
  s.cash += pnl;
  s.trades.unshift({
    symbol: pos.symbol,
    side: pos.side,
    entryTime: pos.entryTime,
    exitTime,
    entryPrice: Math.round(pos.entryPrice * 10000) / 10000,
    exitPrice: Math.round(exitPx * 10000) / 10000,
    pnl: Math.round(pnl * 100) / 100,
    r: Math.round((pnl / riskDollar) * 100) / 100,
    reason: pos.reason,
    exitReason: reason,
  });
  s.trades = s.trades.slice(0, 200);
  pushLog(s, `CLOSE ${pos.side.toUpperCase()} ${pos.symbol} @ ${exitPx.toFixed(4)} pnl=$${pnl.toFixed(2)} R=${(pnl / riskDollar).toFixed(2)} (${reason})`);
}

/* ---------------- LLM gateway (OpenAI-compatible, AntSeed/instabox) ---------------- */

export function arenaGateway(): { baseUrl: string; apiKey: string; configured: boolean } {
  const raw = (process.env.ARENA_LLM_BASE_URL || process.env.LLM_BASE_URL || '').trim();
  const apiKey = (process.env.ARENA_LLM_API_KEY || process.env.LLM_API_KEY || '').trim();
  const baseUrl = raw.replace(/\/+$/, '');
  return { baseUrl, apiKey, configured: !!(baseUrl && apiKey) };
}

function gatewayModelsUrl(baseUrl: string): string {
  if (baseUrl.includes('/v1/')) return baseUrl.split('/v1/')[0] + '/v1/models';
  return baseUrl.replace(/\/$/, '') + '/v1/models';
}

export interface ArenaModelInfo { id: string; name: string; free: boolean }

export async function listArenaModels(): Promise<ArenaModelInfo[]> {
  const gw = arenaGateway();
  if (!gw.configured) return [];
  const res = await fetch(gatewayModelsUrl(gw.baseUrl), {
    headers: { Authorization: `Bearer ${gw.apiKey}` },
  });
  if (!res.ok) throw new Error(`Gateway /v1/models error: ${res.status}`);
  const json = await res.json();
  const out: ArenaModelInfo[] = [];
  for (const m of json.data ?? []) {
    if (Array.isArray(m.supported_protocols) && !m.supported_protocols.includes('openai-chat-completions')) continue;
    if (m.type && m.type !== 'text') continue;
    if (!m.id) continue;
    const bestRep = (m.peers ?? []).reduce((a: number, p: { reputationScore?: number }) => Math.max(a, p.reputationScore ?? 0), 0);
    const free = (m.peers ?? []).some((p: { inputUsdPerMillion?: number; outputUsdPerMillion?: number }) => (p.inputUsdPerMillion ?? -1) === 0 && (p.outputUsdPerMillion ?? -1) === 0);
    out.push({ id: m.id, name: m.name || m.id, free });
  }
  return out.filter((m) => !out.some((o) => o !== m && o.id === m.id));
}

export function gatewayChatUrl(baseUrl: string): string {
  if (baseUrl.includes('/chat/completions')) return baseUrl;
  return baseUrl.replace(/\/$/, '') + '/v1/chat/completions';
}

/* ---- Gateway keepalive: host instabox auto-pause setelah 30 menit idle.
 *  Ping ringan /v1/models tiap 10 menit (jauh di bawah ambang), plus rekam
 *  kesehatan supaya UI bisa menampilkan status gateway. Timer hidup malas
 *  (dimulai request /api/arena pertama), sekali per proses. ---- */
export interface GatewayHealth { lastOkAt: number; lastErrAt: number; lastErr: string; pings: number }
export const gatewayHealth: GatewayHealth = { lastOkAt: 0, lastErrAt: 0, lastErr: '', pings: 0 };

export async function pingGateway(): Promise<boolean> {
  const gw = arenaGateway();
  if (!gw.configured) return false;
  try {
    const res = await fetch(gatewayModelsUrl(gw.baseUrl), {
      headers: { Authorization: `Bearer ${gw.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    gatewayHealth.pings += 1;
    if (res.ok) {
      gatewayHealth.lastOkAt = Date.now();
      gatewayHealth.lastErr = '';
      return true;
    }
    gatewayHealth.lastErrAt = Date.now();
    gatewayHealth.lastErr = `/v1/models HTTP ${res.status}`;
    return false;
  } catch (e) {
    gatewayHealth.lastErrAt = Date.now();
    gatewayHealth.lastErr = e instanceof Error ? e.message : String(e);
    return false;
  }
}

let gwTimer: ReturnType<typeof setInterval> | null = null;
export function ensureGatewayKeepalive(): void {
  if (gwTimer || !arenaGateway().configured) return;
  void pingGateway();
  const tick = () => { void pingGateway(); };
  gwTimer = setInterval(tick, 10 * 60_000);
  // jaga timer tidak menahan shutdown proses Next
  (gwTimer as unknown as { unref?: () => void }).unref?.();
}

async function callArenaModel(model: string, system: string, user: string): Promise<string> {
  const gw = arenaGateway();
  if (!gw.configured) throw new Error('Arena gateway not configured');
  const res = await fetch(gatewayChatUrl(gw.baseUrl), {
    method: 'POST',
    headers: { Authorization: `Bearer ${gw.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 2200,
      temperature: 0.4,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Model ${model} error: ${res.status}`);
  const json = await res.json();
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error(`Model ${model} returned empty`);
  return text;
}

function extractJson(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced ? fenced[1] : text).trim();
  const start = raw.indexOf('{');
  if (start < 0) return null;
  const end = raw.lastIndexOf('}');
  const parse = (s: string) => {
    try {
      const parsed = JSON.parse(s);
      return typeof parsed === 'object' && parsed ? parsed : null;
    } catch {
      return null;
    }
  };
  if (end > start) {
    const ok = parse(raw.slice(start, end + 1));
    if (ok) return ok;
  }
  // JSON terpotong (max_tokens habis di tengah output): tutup bracket/brace yang masih terbuka lalu parse lagi
  const cut = raw.slice(start);
  let inStr = false, esc = false;
  const stack: string[] = [];
  for (const ch of cut) {
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') inStr = !inStr;
    if (inStr) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (stack.length === 0 && !inStr) return null; // bukan truncation, memang rusak
  return parse(cut + stack.reverse().map((c) => (c === '{' ? '}' : ']')).join(''));
}

/* ---------------- Prompt & decision application ---------------- */

interface ModelDecision {
  open?: Array<{ symbol?: string; side?: string; riskFra?: number; targetRR?: number; reason?: string }>;
  close?: Array<{ symbol?: string; reason?: string }>;
  tune?: Partial<ArenaParams>;
  note?: string;
  thought?: string;
  thoughtPlain?: string;
  plan?: string;
  planPlain?: string;
}

function buildPrompt(s: ArenaState, snap: StepMarketSnapshot, othersBrief = ''): string {
  const px = s.lastPrices;
  const signals = snap.signals
    .filter((x) => x.strength >= s.params.minSignalStrength && s.classes.includes(classifySignal(x.reason)))
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 6)
    .map((x) => {
      const h = snap.history[x.symbol];
      const a = h ? atr(h, 14)[h.length - 1] : 0;
      return `- ${x.symbol} ${x.type.toUpperCase()} strength=${x.strength.toFixed(1)} price=${x.price} ATR14=${a?.toFixed(4) ?? '?'} · ${x.reason}`;
    })
    .join('\n');
  const open = s.positions
    .map((p) => {
      const mark = px[p.symbol] ?? p.entryPrice;
      const riskU = p.entryATR * s.params.stopLossATR;
      const liveR = (p.side === 'long' ? mark - p.entryPrice : p.entryPrice - mark) / riskU;
      return `- ${p.symbol} ${p.side.toUpperCase()} entry=${p.entryPrice} liveR=${liveR.toFixed(2)} held=${p.barsHeld}bars · why: ${p.reason}`;
    })
    .join('\n');
  const recent = s.trades.slice(0, 8)
    .map((t) => `- ${t.symbol} ${t.side} R=${t.r} exit=${t.exitReason} (${t.reason})`)
    .join('\n');
  const rList = s.trades.map((t) => t.r);
  const wins = rList.filter((r) => r > 0);
  const losses = rList.filter((r) => r <= 0);
  const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;

  // BELAJAR DARI SENDIRI: performa per simbol + pola kegagalan (exit reasons)
  const bySym = new Map<string, { n: number; r: number }>();
  const byExit = new Map<string, { n: number; r: number }>();
  for (const t of s.trades) {
    const sym = bySym.get(t.symbol) || { n: 0, r: 0 };
    sym.n += 1; sym.r += t.r; bySym.set(t.symbol, sym);
    const ex = byExit.get(t.exitReason) || { n: 0, r: 0 };
    ex.n += 1; ex.r += t.r; byExit.set(t.exitReason, ex);
  }
  const symRows = Array.from(bySym.entries()).sort((a, b) => (b[1].r / b[1].n) - (a[1].r / a[1].n))
    .slice(0, 6).map(([k, v]) => `${k}: ${v.n} trade, avgR=${(v.r / v.n).toFixed(2)}`).join('\n');
  const exitRows = Array.from(byExit.entries()).map(([k, v]) => `${k}: ${v.n}x, totalR=${v.r.toFixed(2)}`).join(' | ');
  // regim: momentum BTC 20 bar terakhir + volatilitas
  let regime = '';
  const btc = snap.history['binance:BTCUSDT'];
  if (btc && btc.length > 20) {
    const last = btc[btc.length - 1].close;
    const back = btc[btc.length - 21].close;
    const ret = ((last - back) / back) * 100;
    regime = `BTC 20-bar regime: ${ret >= 0 ? 'up' : 'down'} ${ret.toFixed(1)}% · last=${last.toFixed(0)}`;
  }

  return `Arena session for you (${s.model}). Each trade risks 1R = ${s.params.riskPerTrade} of equity (you may set 0.5%-3% per trade). Score = R expectancy (avg R per trade), NOT win rate.

YOUR MANDATE (other competitors have DIFFERENT mandates — do not copy them): ${s.mandate}. You trade "${s.archetype}" style on ${s.params.interval} candles, only ${s.classes.join(' + ')} signals. Iterate WITHIN your style: entry timing, thresholds, targets, risk size — but stay your own archetype; style-guard rejects tune that makes you identical to another agent.

Your equity: $${arenaEquity(s).toFixed(2)} (start $${ARENA_STARTING_CAPITAL}) · trades=${s.stats.totalTrades} winRate=${s.stats.winRate.toFixed(0)}% avgR=${s.stats.avgR} totalR=${s.stats.totalR} avgWinR=${avgWin.toFixed(2)} avgLossR=${avgLoss.toFixed(2)} ProfitFactor=${s.stats.ProfitFactor}

Current params: ${JSON.stringify(s.params)}

Open positions:
${open || '(flat)'}

Last closed trades (newest first):
${recent || '(none yet)'}

Engine candidates (multi-timeframe confluence >= min strength):
${signals || '(no candidates above your min strength)'}

Market regime snapshot latest closes: ${Object.entries(snap.latest).slice(0, 6).map(([k, c]) => `${k}=${c.close}`).join(' ')}

${regime}

YOUR OWN history analysis (learn from it — don't repeat what loses R):
Per-symbol perf:
${symRows || '(no trades yet)'}
Exit reason pattern: ${exitRows || '—'}
${s.rankNote ? `\nLEADERBOARD POSITION: ${s.rankNote}. Studying the leader is fine; copying their playbook is pointless (style-guard).` : ''}
${othersBrief ? `\nWHAT THE OTHER AGENTS SAW & DID (competitive intel — learn from their R patterns and reasoning, NEVER copy their style or positions; you keep your own mandate):\n${othersBrief}` : ''}

Decide your next moves. You may:
1. open (each: pick symbol among candidates, optional side, optional riskFra 0.005-0.03 of equity as this trade's risk, optional target RR targetRR 0.5-10, short reason)
2. close (symbol — take profit / cut losers early if thesis broken / re-evaluate)
3. tune — adjust ANY of your own strategy params (stopLossATR, takeProfitATR, minSignalStrength, maxConcurrentPositions, maxHoldBars, riskPerTrade, allowShort, interval) to improve R. You may drop win rate if it raises avg R. forbidden: equity, cash, trades.

HARD RULES (enforced by the engine, violating = order rejected):
- Every position ALWAYS carries a stop (SL is set at entry automatically; you cannot remove it).
- Risk per trade 0.5%-3% of equity; total open risk across positions max 6%.
- Max ${s.params.maxConcurrentPositions} concurrent positions (hard cap 5).
- If your open unrealized R total hits -3R, new entries are BLOCKED until it recovers.
- Equity ≤ $500 = knockout, you are out of the arena.

You are otherwise FREE: mix methods (momentum, mean reversion, spike, decoupling, trend), change targets, thresholds, timeframe — just keep explaining your iteration in "note" with R in mind.

Respond ONLY with JSON:
{"thought":"what you see in the market right now and how you feel about your R curve","thoughtPlain":"TOEKU WAJIB: terjemahkan thought ke SATU kalimat bahasa Indonesia sehari-hari yang dimengerti orang awam — tanpa istilah teknis, tanpa istilah Inggris","open":[{"symbol":"...","side":"long","riskFra":0.02,"targetRR":3,"reason":"..."}],"close":[{"symbol":"...","reason":"..."}],"tune":{"takeProfitATR":3,"minSignalStrength":5},"plan":"your intent for the coming bars even if no order now","planPlain":"WAJIB: rencana tu dalam bahasa awam Indonesia, satu kalimat","note":"one-line reflection on what you are changing and why (focus on R)"}`;
}

function applyDecision(s: ArenaState, d: ModelDecision, snap: StepMarketSnapshot): { paramChanged: boolean; notes: string[]; tuned: string[] } {
  const notes: string[] = [];
  const tuned: string[] = [];
  let paramChanged = false;

  const eq = arenaEquity(s);

  for (const c of d.close || []) {
    const sym = c?.symbol;
    const i = s.positions.findIndex((p) => p.symbol === sym);
    if (i < 0) continue;
    const pos = s.positions[i];
    const last = snap.latest[pos.symbol];
    const px = last ? last.close : (s.lastPrices[pos.symbol] ?? pos.entryPrice);
    closeArena(s, pos, last?.time ?? Date.now(), px, `model_close${c.reason ? ': ' + c.reason : ''}`);
    s.positions.splice(i, 1);
  }

  for (const o of d.open || []) {
    if (!o?.symbol) continue;
    if (s.positions.length >= s.params.maxConcurrentPositions) { notes.push('open skipped: max positions'); break; }
    if (s.positions.some((p) => p.symbol === o.symbol)) continue;

    // GUARDRAIL 0: class gate — arketipe hanya main kelas sinyalnya sendiri
    const sig = snap.signals
      .filter((x) => x.symbol === o.symbol && s.classes.includes(classifySignal(x.reason)))
      .sort((a, b) => b.strength - a.strength)[0];
    if (!sig) { notes.push(`open rejected: ${o.symbol} is not a ${s.classes.join('/')}-candidate for ${s.archetype}`); continue; }

    // LEARNING COOLDOWN: 2x loss beruntun di simbol yang sama → berhenti dulu
    const recentSym = s.trades.filter((t) => t.symbol === o.symbol).slice(0, 2);
    if (recentSym.length === 2 && recentSym.every((t) => t.pnl <= 0)) {
      notes.push(`open rejected: cooldown ${o.symbol} (2 loss beruntun — ganti sisi, tunggu setup baru)`);
      continue;
    }
    // LEARNING GOVERNOR: R-rata-rata 10 trade terakhir jelek → kecilkan risiko
    const recent10 = s.trades.slice(0, 10).map((t) => t.r);
    const recentAvg = recent10.length >= 5 ? recent10.reduce((a, b) => a + b, 0) / recent10.length : 0;
    const governed = recent10.length >= 5 && recentAvg < -0.4;

    // GUARDRAIL 1: circuit breaker — open R total ≤ -3R → dilarang entry baru
    const openR = s.positions.reduce((a, p) => {
      const mark = s.lastPrices[p.symbol] ?? p.entryPrice;
      return a + (p.side === 'long' ? mark - p.entryPrice : p.entryPrice - mark) / (p.riskDollar || 1);
    }, 0);
    if (openR <= CIRCUIT_R) {
      pushLog(s, `GUARDRAIL: open R ${openR.toFixed(2)}R ≤ ${CIRCUIT_R}R — entries dihentikan sampai pulih`);
      break;
    }
    // GUARDRAIL 2: total open risk ≤ 6% equity
    const riskBudgetUsed = s.positions.reduce((a, p) => a + p.riskDollar, 0) / Math.max(1, eq);

    const last = snap.latest[o.symbol];
    const hist = snap.history[o.symbol];
    const a = hist ? atr(hist, 14)[hist.length - 1] : 0;
    if (!last || !a || a <= 0) { notes.push(`open skipped: no data ${o.symbol}`); continue; }
    const side = o.side === 'short' ? 'short' : o.side === 'long' ? 'long' : (sig.type === 'sell' ? 'short' : 'long');
    if (side === 'short' && !s.params.allowShort) { notes.push('shorts disabled in your params'); continue; }
    const riskFra = clamp(Number(o.riskFra) || s.params.riskPerTrade, RISK_PER_TRADE_MIN, RISK_PER_TRADE_MAX);
    const effRisk = governed ? Math.min(riskFra, 0.01) : riskFra;
    if (governed && riskFra > 0.01) {
      pushLog(s, `LEARNING GOVERNOR: avgR 10-trade terakhir ${recentAvg.toFixed(2)} < -0.4 → risk ditahan ${riskFra} → 1%`);
    }
    const targetRR = clamp(Number(o.targetRR) || 0, TARGET_MIN, TARGET_MAX);
    const stopATR = clamp(Number(o.targetRR) ? Math.min(targetRR, s.params.stopLossATR) : s.params.stopLossATR, ATR_MIN, ATR_MAX) || s.params.stopLossATR;
    const riskPerUnit = stopATR * a;
    const riskDollar = Math.max(0, eq) * effRisk;
    const qty = riskDollar / riskPerUnit;
    if (qty <= 0) continue;
    // catatan desain: TIDAK ada cap notional — sizing murni risk-based (1R = riskDollar);
    // ukuran posisi dibatasi GUARDRAIL 2 (total open risk ≤6%) + max positions + circuit breaker.
    if (riskBudgetUsed + effRisk > RISK_R_MAX) {
      pushLog(s, `GUARDRAIL: open-risk ${(riskBudgetUsed * 100).toFixed(1)}% + ${(effRisk * 100).toFixed(1)}% > ${RISK_R_MAX * 100}% — skip`);
      break;
    }
    const entryPrice = last.close;
    const stopLoss = side === 'long' ? entryPrice - riskPerUnit : entryPrice + riskPerUnit;
    const takeProfit =
      side === 'long' ? entryPrice + riskPerUnit * (targetRR || 0) : entryPrice - riskPerUnit * (targetRR || 0);
    s.positions.push({
      symbol: o.symbol,
      side,
      entryTime: last.time,
      entryPrice,
      entryATR: a,
      qty,
      stopLoss,
      takeProfit,
      barsHeld: 0,
      riskDollar,
      reason: (sig?.reason || o.reason || 'model pick').slice(0, 140),
    });
    pushLog(s, `OPEN ${side.toUpperCase()} ${o.symbol} @ ${entryPrice.toFixed(4)} risk=${(effRisk * 100).toFixed(1)}% R=1R target=${targetRR || s.params.takeProfitATR}R — ${(o.reason || sig?.reason || '').slice(0, 90)}`);
  }

  const t = d.tune || {};
  const tuneKeys: (keyof ArenaParams)[] = ['stopLossATR', 'takeProfitATR', 'minSignalStrength', 'maxConcurrentPositions', 'maxHoldBars', 'riskPerTrade'];
  const arch = ARCHETYPES.find((a) => a.name === s.archetype);
  for (const key of tuneKeys) {
    const raw = Number(t[key]);
    if (!Number.isFinite(raw) || raw <= 0) continue;
    // rentang arketipe override clamp global — tiap gaya stays in its lane
    const fallbackRanges: Record<string, [number, number]> = {
      stopLossATR: [ATR_MIN, ATR_MAX],
      takeProfitATR: [TARGET_MIN, TARGET_MAX],
      minSignalStrength: [STR_MIN, STR_MAX],
      maxConcurrentPositions: [POS_MIN, POS_MAX],
      maxHoldBars: [HOLD_MIN, HOLD_MAX],
      riskPerTrade: [RISK_PER_TRADE_MIN, RISK_PER_TRADE_MAX],
    };
    const [lo, hi] = arch ? archetypeRange(arch, key) : fallbackRanges[key];
    const clamped = clamp(raw, lo, hi);
    if (Math.abs((s.params[key] as number) - clamped) > 1e-9) {
      pushLog(s, `[tune] ${key}: ${(s.params[key] as number)} → ${clamped}`);
      tuned.push(`${key}:${(s.params[key] as number)}→${clamped}`);
      (s.params[key] as number) = clamped;
      paramChanged = true;
    }
  }
  if (typeof t.allowShort === 'boolean' && t.allowShort !== s.params.allowShort) {
    s.params.allowShort = t.allowShort;
    pushLog(s, `[tune] allowShort → ${t.allowShort}`);
    tuned.push(`allowShort→${t.allowShort}`);
    paramChanged = true;
  }
  if (typeof t.interval === 'string' && ['15m', '1h', '4h'].includes(t.interval) && t.interval !== s.params.interval) {
    s.params.interval = t.interval;
    pushLog(s, `[tune] interval → ${t.interval} (berlaku mulai step berikutnya)`);
    tuned.push(`interval→${t.interval}`);
    paramChanged = true;
  }
  return { paramChanged, notes, tuned };
}

/* ---------------- Step ---------------- */

export interface ArenaStepResult { closedTrades: ArenaTrade[]; fallback: boolean; error?: string }

function manageOpen(s: ArenaState, snap: StepMarketSnapshot) {
  for (let i = s.positions.length - 1; i >= 0; i--) {
    const pos = s.positions[i];
    const last = snap.latest[pos.symbol];
    if (!last) continue;
    pos.barsHeld += 1;
    const hitStop = pos.side === 'long' ? last.low <= pos.stopLoss : last.high >= pos.stopLoss;
    const hitTarget = pos.side === 'long' ? last.high >= pos.takeProfit : last.low <= pos.takeProfit;
    if (pos.takeProfit > 0 && hitTarget) {
      closeArena(s, pos, last.time, pos.takeProfit, 'risk_target');
      s.positions.splice(i, 1);
    } else if (hitStop) {
      closeArena(s, pos, last.time, pos.stopLoss, 'risk_stop');
      s.positions.splice(i, 1);
    } else if (pos.barsHeld >= s.params.maxHoldBars) {
      closeArena(s, pos, last.time, last.close, 'time_stop');
      s.positions.splice(i, 1);
    }
  }
}

export async function arenaStep(
  s: ArenaState,
  snap: StepMarketSnapshot,
  systemPrompt: string,
  force = false,
  othersBrief = ''
): Promise<ArenaStepResult> {
  if (!s.running) return { closedTrades: [], fallback: false };
  const prices: Record<string, number> = {};
  for (const [k, c] of Object.entries(snap.latest)) prices[k] = c.close;
  s.lastPrices = prices;

  const barKey = Object.entries(snap.latest).map(([k, c]) => `${k}:${c.time}`).sort().join('|');
  const isNewBar = barKey !== s.lastBarKey || force;
  s.lastBarKey = barKey;

  const closedTrades: ArenaTrade[] = [];
  const before = s.trades.length;
  manageOpen(s, snap);

  if (arenaEquity(s) > s.peakEquity) s.peakEquity = arenaEquity(s);

  let fallback = false;
  let error: string | undefined;
  if (isNewBar) {
    const user = buildPrompt(s, snap, othersBrief);
    let decision: ModelDecision | null = null;
    try {
      const text = await callArenaModel(s.model, systemPrompt, user);
      decision = extractJson(text);
      if (!decision) {
        fallback = true;
        error = 'unparseable model output';
        pushLog(s, `FALLBACK parse: output mentah dimulai: ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
      } else {
        const applied = applyDecision(s, decision, snap);
        const thought = String(decision.thought || decision.note || '').slice(0, 400);
        s.iterNote = String(decision.note || '').slice(0, 200);
        s.iterCount += 1;

        // ringkasan aksi yang diminta model step ini (intent) — feed pikiran
        const acts: string[] = [];
        const openTxt = (decision.open || [])
          .filter((o) => o?.symbol)
          .map((o) => `open ${(o.side || 'auto')} ${o.symbol}${o.targetRR ? ` target ${o.targetRR}R` : ''}`)
          .join(', ');
        if (openTxt) acts.push(openTxt);
        const closeTxt = (decision.close || [])
          .filter((c) => c?.symbol)
          .map((c) => `close ${c.symbol}`)
          .join(', ');
        if (closeTxt) acts.push(closeTxt);
        if (applied.tuned.length > 0) acts.push(`tune ${applied.tuned.join(', ')}`);
        // rejection engine harus terlihat — jangan bikin model "berbicara" tapi pesanan lenyap tanpa jejak
        const rejects = applied.notes.slice(0, 4).map((n) => n.replace(/^open (rejected|skipped): /, '').slice(0, 70));
        if (rejects.length > 0) acts.push(`⚠️ engine: ${rejects.join(' • ')}`);
        for (const n of applied.notes) pushLog(s, n);
        const actions = acts.join(' · ') || 'no order taken (hold)';

        const plan = String(decision.plan || '').slice(0, 400);
        // fallback jika model malas mengisi bahasa awam: tutel dari ringkasan aksi
        const fallbackPlain = (() => {
          if (acts.length === 0) return 'Aku masih menunggu kesempatan yang bagus, kali ini tidak pasang pesanan baru.';
          return `Kali ini aku: ${acts.join(' • ')}`.replace(/open (long|short|auto)/g, (m, s) => (s === 'short' ? 'pasang taruhan harga turun' : 'pasang taruhan harga naik'));
        })();
        const thoughtPlain = String(decision.thoughtPlain || '').slice(0, 300)
          || fallbackPlain;
        const planPlain = String(decision.planPlain || '').slice(0, 300);
        if (!s.thoughts) s.thoughts = [];
        s.thoughts.unshift({ time: Date.now(), thought, thoughtPlain, plan, planPlain: planPlain || plan.slice(0, 200), actions });
        s.thoughts = s.thoughts.slice(0, 12);
        pushLog(s, `[iter ${s.iterCount}] ${s.iterNote || (applied.paramChanged ? 'tuned params' : 'held')}`);
      }
    } catch (e) {
      fallback = true;
      error = e instanceof Error ? e.message : String(e);
    }
  }
  closedTrades.push(...s.trades.slice(0, Math.max(0, s.trades.length - before)));
  recalcStats(s);
  const eqNow = arenaEquity(s);
  // GUARDRAIL 3: equity ≤ $500 → knockout, agent dinyatakan gugur
  if (s.running && eqNow <= KNOCKOUT_EQ) {
    s.running = false;
    pushLog(s, `KNOCKOUT — equity $${eqNow.toFixed(2)} ≤ $${KNOCKOUT_EQ}. Agent gugur dari arena.`);
  }
  const eq = arenaEquity(s);
  const lastSample = s.equityHistory[s.equityHistory.length - 1];
  if (!lastSample || Date.now() - lastSample.time > 30_000 || Math.abs(lastSample.equity - eq) > 0.02) {
    s.equityHistory = [...s.equityHistory, { time: Date.now(), equity: Math.round(eq * 100) / 100 }].slice(-240);
  }
  s.updatedAt = Date.now();
  return { closedTrades, fallback, error };
}
