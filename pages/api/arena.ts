import type { NextApiRequest, NextApiResponse } from 'next';
import { randomUUID, timingSafeEqual } from 'crypto';
import { parseAssetList } from '../../lib/marketData';
import { getPresetById } from '../../lib/marketData/presets';
import { buildMultiTfSnapshot } from '../../lib/quant/paperMultiTf';
import {
  ArenaState,
  createArenaState,
  listArenaModels,
  arenaStep,
  arenaEquity,
  arenaRankingScore,
  recalculateArenaStats,
  ArenaModelInfo,
  pickArchetype,
  ARENA_OR_PREFIX,
  styleFingerprint,
  ensureStyleUnique,
  manageOpen,
  arenaExecutionProfile,
  ensureGatewayKeepalive,
  arenaExecutionAssumptions,
  gatewayHealth,
  pingGateway,
} from '../../lib/quant/arena';
import { getSupabase, isSupabaseConfigured } from '../../lib/supabase';
import { getSupabaseAdmin, isSupabaseAdminConfigured } from '../../lib/supabaseAdmin';

export const config = { maxDuration: 60 };

const memory = new Map<string, ArenaState>();
const pendingNormalization = new WeakSet<ArenaState>();
const controlToken = (process.env.ARENA_CONTROL_TOKEN || '').trim();

function controlRequirements(): string[] {
  const requirements: string[] = [];
  if (process.env.NODE_ENV === 'production' && !controlToken) requirements.push('ARENA_CONTROL_TOKEN is not configured');
  if (process.env.NODE_ENV === 'production' && !isSupabaseConfigured()) requirements.push('Supabase persistence is not configured');
  if (isSupabaseConfigured() && !isSupabaseAdminConfigured()) requirements.push('SUPABASE_SERVICE_ROLE_KEY is missing or invalid');
  return requirements;
}

function controlsReady() {
  return controlRequirements().length === 0;
}

function isAuthorized(req: NextApiRequest) {
  if (process.env.NODE_ENV !== 'production') return true;
  const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!controlToken || !supplied) return false;
  const expected = Buffer.from(controlToken);
  const received = Buffer.from(supplied);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

const SYSTEM_PROMPT = `You are an autonomous trading agent in the Althunter AI Arena, competing against other LLM models. You start with $1000 of virtual capital, paper-trading across crypto, US equities/ETFs, forex (EUR/JPY/GBP), and commodities — gold, silver, copper, aluminium, platinum, palladium, natgas, crude/brent oil — using the Althunter engines: multi-timeframe confluence signals (15m/1w), spike detection, relative-strength decoupling, ATR-based risk sizing.

Evaluate decisions by net R expectancy (R after modeled simulation costs), not win rate alone. Every completed position counts as one trade, including any partial exits. The leaderboard uses expectancy with a small-sample shrinkage heuristic; this is a comparison aid, not a statistical confidence guarantee.

NON-NEGOTIABLE GUARDRAILS (the engine enforces these; violations are rejected):
1. A stop-loss is attached to every position at entry — no unbundled risk, ever.
2. Risk per trade 0.5%-3% of equity; total open risk across all positions max 6% of equity.
3. Max 5 concurrent positions.
4. Circuit breaker: if your open unrealized R drops to -3R, new entries are blocked until total open R recovers above -3R.
5. Equity floor $500: below that you are knocked out of the arena.
6. No revenge trading mechanics: position limits and risk caps apply even during a losing streak.

Ruled by the guardrails above, everything else is YOUR call. Keep iterating to raise avg R — but you must stay in the archetype/style assigned to your agent (stated at the top of every session): entry timing, thresholds, targets, risk size and hold time are yours to tune; copying another competitor's whole playbook is impossible anyway (style-guard reverts it). Rationalize every iteration in one line: what you changed, why you believe it raises avg R.`;

async function loadState(modelId: string): Promise<ArenaState | null> {
  const local = memory.get(modelId) || null;
  if (!isSupabaseConfigured()) return local;
  const supa = getSupabase();
  if (!supa) return local;
  const { data, error } = await supa.from('ai_arena_agents').select('state').eq('id', modelId).maybeSingle();
  if (error) return local;
  if (data?.state) {
    const st = normalizeState(data.state as ArenaState);
    if (local && (local.updatedAt || 0) > (st.updatedAt || 0)) return normalizeState(local);
    memory.set(modelId, st);
    return st;
  }
  return local;
}

async function saveState(s: ArenaState): Promise<void> {
  s.updatedAt = Date.now();
  if (!isSupabaseConfigured()) {
    memory.set(s.model, s);
    pendingNormalization.delete(s);
    return;
  }
  if (!isSupabaseAdminConfigured()) throw new Error('Arena persistence is configured but SUPABASE_SERVICE_ROLE_KEY is missing or invalid');
  const supa = getSupabaseAdmin();
  if (!supa) throw new Error('Arena admin database client unavailable');
  const { error } = await supa.from('ai_arena_agents').upsert({ id: s.model, state: s, updated_at: new Date().toISOString() });
  if (error) throw new Error(`Arena state save failed: ${error.message}`);
  memory.set(s.model, s);
  pendingNormalization.delete(s);
}

/** ringkasan pikiran & trade history agent LAIN — diberikan ke tiap agent biar belajar satu sama
 *  lain (berbeda gaya, tapi saling melihat pola R & cara berpikir). Dipangkas ringkas per agent. */
function othersBriefOf(s: ArenaState, all: ArenaState[]): string {
  const others = all.filter((o) => o.model !== s.model && o.running);
  if (others.length === 0) return '';
  const lines = others.map((o) => {
    const avgR = o.stats.totalTrades ? o.stats.totalR / o.stats.totalTrades : 0;
    const th = (o.thoughts || [])[0];
    const think = th ? `rationale model: "${(th.thoughtPlain || th.thought || '').slice(0, 180)}"` : 'belum ada rationale tercatat';
    const hist = o.trades
      .slice(0, 6)
      .map((t) => `${t.symbol} ${t.side} ${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)}R (${t.exitReason})`)
      .join('; ');
    return `- ${o.model} [${o.archetype}] $${arenaEquity(o).toFixed(0)} totalR=${o.stats.totalR.toFixed(2)} avgR=${avgR.toFixed(2)} — ${think}${hist ? ` — history: ${hist}` : ''}`;
  });
  return lines.join('\n');
}

let stepInFlight = false; // single-flight step guard
let modelsCache: { t: number; list: ArenaModelInfo[]; freeCount: number } = { t: 0, list: [], freeCount: 0 };

async function acquireDistributedStepLock(): Promise<{ release: () => Promise<void> } | null> {
  if (!isSupabaseConfigured()) return { release: async () => undefined };
  if (!isSupabaseAdminConfigured()) throw new Error('Arena step lock requires SUPABASE_SERVICE_ROLE_KEY');
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error('Arena step lock database client unavailable');
  const owner = randomUUID();
  const { data, error } = await admin.rpc('claim_ai_arena_step_lock', { p_owner_token: owner, p_lease_seconds: 90 });
  if (error) throw new Error(`Arena distributed lock unavailable; apply migration 020: ${error.message}`);
  if (data !== true) return null;
  return {
    release: async () => {
      const { error: releaseError } = await admin.rpc('release_ai_arena_step_lock', { p_owner_token: owner });
      if (releaseError) console.error('[arena] failed to release distributed step lock', releaseError.message);
    },
  };
}

async function acquireArenaMutationLock(): Promise<{ release: () => Promise<void> } | null> {
  if (stepInFlight) return null;
  stepInFlight = true;
  try {
    const distributed = await acquireDistributedStepLock();
    if (!distributed) {
      stepInFlight = false;
      return null;
    }
    return {
      release: async () => {
        try { await distributed.release(); }
        catch (error) { console.error('[arena] lock release failed', error); }
        finally { stepInFlight = false; }
      },
    };
  } catch (error) {
    stepInFlight = false;
    throw error;
  }
}

export function leaderboard(states: ArenaState[]) {
  return states
    .map((s) => {
      const eq = arenaEquity(s);
      return {
        model: s.model,
        running: s.running,
        terminated: Boolean(s.terminated),
        equity: Math.round(eq * 100) / 100,
        archetype: s.archetype,
        pnlPct: Math.round(((eq - 1000) / 10) * 100) / 100, // % dari $1000
        expectancyScore: s.stats.totalTrades ? arenaRankingScore(s.stats) : null,
        maxDrawdownPct: Math.round((s.maxDrawdownPct || 0) * 100) / 100,
        tradeSample: s.trades.length,
        tradeHistoryCapped: Boolean(s.tradeHistoryCapped),
        lastDecision: s.lastDecision || null,
        lastSnapshot: s.lastSnapshot || null,
        openCount: s.positions.length,
        iterCount: s.iterCount,
        iterNote: s.iterNote,
        thoughts: s.thoughts || [],
        params: s.params,
        equityHistory: (s.equityHistory || []).slice(-150).map((p) => p.equity),
        stats: s.stats,
      };
    })
    .sort((a, b) => (b.expectancyScore ?? Number.NEGATIVE_INFINITY) - (a.expectancyScore ?? Number.NEGATIVE_INFINITY) || b.stats.totalR - a.stats.totalR || b.equity - a.equity);
}

/** gabung memori proses (terbaru) dengan baris Supabase — table belum jalan pun arena tetap hidup */
async function allStates(): Promise<ArenaState[]> {
  const merged = new Map<string, ArenaState>();
  if (isSupabaseConfigured()) {
    const supa = getSupabase();
    const { data } = await supa!.from('ai_arena_agents').select('state');
    for (const r of data ?? []) {
      const st = r.state as ArenaState;
      if (st?.model) merged.set(st.model, normalizeState(st));
    }
  }
  for (const [k, v] of Array.from(memory.entries())) {
    const persisted = merged.get(k);
    if (!persisted || (v.updatedAt || 0) > (persisted.updatedAt || 0)) merged.set(k, v);
  }
  return Array.from(merged.values()).map(normalizeState);
}

function sameArenaPosition(a: Pick<ArenaState['trades'][number], 'symbol' | 'side' | 'entryTime' | 'entryPrice'>, b: Pick<ArenaState['positions'][number], 'symbol' | 'side' | 'entryTime' | 'entryPrice'>) {
  const priceTolerance = Math.max(0.0002, Math.abs(a.entryPrice) * 1e-6);
  return a.symbol === b.symbol
    && a.side === b.side
    && a.entryTime === b.entryTime
    && Math.abs(a.entryPrice - b.entryPrice) <= priceTolerance;
}

/** Fold pre-fix partial_target rows back into their parent position/trade. */
function migrateLegacyPartialExits(st: ArenaState) {
  const consumed = new Set<ArenaState['trades'][number]>();
  const oldPartials = st.trades.filter((trade) => trade.exitReason === 'partial_target');

  for (const partial of oldPartials) {
    const completedTrade = st.trades.find((trade) =>
      trade !== partial
      && trade.exitReason !== 'partial_target'
      && sameArenaPosition(partial, trade)
    );
    if (completedTrade) {
      completedTrade.pnl = Math.round((completedTrade.pnl + partial.pnl) * 100) / 100;
      completedTrade.r = Math.round((completedTrade.r + partial.r) * 100) / 100;
      completedTrade.legacySegmentsMerged = true;
      completedTrade.legacyPartialCount = (completedTrade.legacyPartialCount || 0) + 1;
      // Historical partial-fill fees were not stored, so keep fees unknown.
      delete completedTrade.fees;
      consumed.add(partial);
      continue;
    }

    const openPosition = st.positions.find((position) =>
      position.tookPartial
      && !position.legacyPartialMigrated
      && sameArenaPosition(partial, position)
    );
    if (openPosition) {
      openPosition.realizedPnl = Math.round(((openPosition.realizedPnl || 0) + partial.pnl) * 100) / 100;
      openPosition.realizedFeesKnown = false;
      openPosition.legacyPartialMigrated = true;
      openPosition.legacyPartialCount = (openPosition.legacyPartialCount || 0) + 1;
      consumed.add(partial);
    }
  }

  if (consumed.size) st.trades = st.trades.filter((trade) => !consumed.has(trade));
  return consumed.size > 0;
}

/** compat for older persisted arena states */
function normalizeState(st: ArenaState): ArenaState {
  if (!Array.isArray(st.positions)) st.positions = [];
  if (!Array.isArray(st.trades)) st.trades = [];
  if (!Array.isArray(st.equityHistory)) st.equityHistory = [];
  if (!Array.isArray(st.log)) st.log = [];
  if (!st.params) st.params = createArenaState(st.model).params;
  if (!st.archetype) {
    st.archetype = 'Momentum General';
    st.mandate = 'generalist momentum (warisan pra-arketipe)';
    st.classes = ['momentum'];
  }
  if (!st.thoughts) st.thoughts = [];
  if (!st.decisionHistory) st.decisionHistory = [];
  if (st.trades?.length >= 200) st.tradeHistoryCapped = true;
  if (migrateLegacyPartialExits(st)) pendingNormalization.add(st);
  const curve = st.equityHistory || [];
  let runningPeak = 0;
  let observedDrawdown = 0;
  for (const point of curve) {
    runningPeak = Math.max(runningPeak, point.equity);
    if (runningPeak > 0) observedDrawdown = Math.max(observedDrawdown, ((runningPeak - point.equity) / runningPeak) * 100);
  }
  st.maxDrawdownPct = Math.max(st.maxDrawdownPct || 0, observedDrawdown);
  if (!st.lastBarTimes) st.lastBarTimes = {};
  if (typeof st.lastBarKey !== 'string') st.lastBarKey = '';
  const intervalPrefix = `${st.params.interval}:`;
  if (st.lastBarKey && !st.lastBarKey.startsWith(intervalPrefix)) {
    const oldBarTimes = st.lastBarKey.split('|').map((item) => Number(item.slice(item.lastIndexOf(':') + 1))).filter(Number.isFinite);
    if (oldBarTimes.length) st.lastBarKey = `${intervalPrefix}${Math.max(...oldBarTimes)}`;
  }
  for (const p of st.positions || []) {
    // posisi lama belum punya riskUnit (dipakai liveR saat stop sudah di-trail)
    if (!p.riskUnit) p.riskUnit = p.riskDollar && p.qty ? p.riskDollar / p.qty : p.entryATR * st.params.stopLossATR;
  }
  if (!st.stats) st.stats = { totalTrades: 0, wins: 0, winRate: 0, totalR: 0, avgR: 0, bestR: 0, worstR: 0, ProfitFactor: 0 };
  recalculateArenaStats(st);
  return st;
}

/** serialisasi ringan untuk live-positions di UI */
function livePositions(s: ArenaState) {
  return s.positions.map((p) => {
    const mark = s.lastPrices[p.symbol] ?? p.entryPrice;
    const profile = arenaExecutionProfile(p.symbol);
    const riskDollar = p.riskDollar || p.riskUnit * p.qty || 1;
    const slip = profile.slippageBpsPerSide / 10_000;
    const estimatedExit = mark * (1 + (p.side === 'long' ? -slip : slip));
    const gross = (p.side === 'long' ? estimatedExit - p.entryPrice : p.entryPrice - estimatedExit) * p.qty;
    const estimatedFee = profile.feeBpsPerSide / 10_000 * p.qty * (p.entryPrice + estimatedExit);
    const liveR = Math.round(((gross - estimatedFee) / riskDollar) * 100) / 100;
    return {
      model: s.model,
      symbol: p.symbol,
      side: p.side,
      entryPrice: Math.round(p.entryPrice * 10000) / 10000,
      markPrice: Math.round(mark * 10000) / 10000,
      stopLoss: Math.round(p.stopLoss * 10000) / 10000,
      takeProfit: Math.round(p.takeProfit * 10000) / 10000,
      liveR,
      qty: Math.round(p.qty * 1e6) / 1e6,
      riskDollar: Math.round(riskDollar * 100) / 100,
      feeBpsPerSide: profile.feeBpsPerSide,
      slippageBpsPerSide: profile.slippageBpsPerSide,
      tookPartial: Boolean(p.tookPartial),
      barsHeld: p.barsHeld,
      reason: p.reason,
    };
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET,POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const action = req.method === 'GET' ? String(req.query.action || 'leaderboard') : String(req.body?.action || 'leaderboard');

  if (req.method === 'POST') {
    if (!controlsReady()) return res.status(503).json({ ok: false, error: `Arena controls are disabled: ${controlRequirements().join('; ')}.` });
    if (!isAuthorized(req)) return res.status(401).json({ ok: false, error: 'Unauthorized arena control request.' });
  }

  let mutationLock: { release: () => Promise<void> } | null = null;
  if (req.method === 'POST' && ['start', 'step', 'stop', 'resume', 'reset'].includes(action)) {
    try {
      mutationLock = await acquireArenaMutationLock();
    } catch (e) {
      return res.status(503).json({ ok: false, error: e instanceof Error ? e.message : 'Arena mutation lock unavailable' });
    }
    if (!mutationLock) return res.status(409).json({ ok: false, busy: true, note: 'Another arena mutation is already running across the deployment.' });
  }

  try {
    ensureGatewayKeepalive();
    if (action === 'models') {
      // 60s cache daftar mentah + fallback list terakhir: gateway flicker (timeout/5xx)
      // tak boleh bikin panel rekrutmen kosong. Filter freeOnly dijalankan SETELAH cache
      // supaya kedua mode menghasilkan daftar yang benar dari cache yang sama.
      const wantFree = req.query.freeOnly === '1' || req.body?.freeOnly === true;
      let raw: ArenaModelInfo[] = [];
      let note = '';
      if (modelsCache.t && Date.now() - modelsCache.t < 60_000) {
        raw = modelsCache.list;
        note = 'cached';
      } else {
        try {
          raw = await listArenaModels();
          modelsCache = { t: Date.now(), list: raw, freeCount: raw.filter((m) => m.free).length };
        } catch (e) {
          note = modelsCache.t ? 'stale-cache' : 'gateway-down';
          raw = modelsCache.t ? modelsCache.list : [];
        }
      }
      const filtered = wantFree && raw.some((m) => m.free) ? raw.filter((m) => m.free) : raw;
      return res.status(200).json({
        ok: true,
        models: filtered,
        freeCount: raw.filter((m) => m.free).length,
        gatewayConfigured: filtered.length > 0 || raw.length > 0,
        ...(note ? { note } : {}),
      });
    }

    if (action === 'gw-ping') {
      // coba hidupkan/bangun gateway dari sisi kita (kalau instabox resume-on-request, ping ini membangunkan)
      const alive = await pingGateway();
      return res.status(200).json({ ok: true, alive, gw: { ...gatewayHealth } });
    }

    if (action === 'leaderboard') {
      const states = await allStates();
      return res.status(200).json({
        ok: true,
        lb: leaderboard(states),
        positions: states.flatMap(livePositions),
        persisted: isSupabaseConfigured(),
        gw: { ...gatewayHealth, down: gatewayHealth.lastErrAt > gatewayHealth.lastOkAt },
        // diagnostik: kalau '0' → runtime menonaktifkan verifikasi sertifikat TLS (bukan dari kode kita)
        tls: process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? null,
        deepseekFallback: Boolean(process.env.DEEPSEEK_API_KEY_2),
        controlsReady: controlsReady(),
        controlTokenRequired: process.env.NODE_ENV === 'production',
        controlMessage: controlRequirements().join('; '),
        persistenceMode: isSupabaseConfigured() ? (isSupabaseAdminConfigured() ? 'database' : 'read-only: service role unavailable') : 'process memory (ephemeral)',
        executionAssumptions: arenaExecutionAssumptions(),
      });
    }

    if (action === 'detail') {
      const model = String(req.method === 'GET' ? req.query.model : req.body?.model || '');
      const s = await loadState(model);
      if (!s) return res.status(404).json({ ok: false, error: 'not started' });
      const detailPositions = s.positions.map((position) => {
        const profile = arenaExecutionProfile(position.symbol);
        return {
          ...position,
          markPrice: s.lastPrices[position.symbol] ?? position.entryPrice,
          feeBpsPerSide: profile.feeBpsPerSide,
          slippageBpsPerSide: profile.slippageBpsPerSide,
        };
      });
      return res.status(200).json({ ok: true, state: { ...s, positions: detailPositions, equity: arenaEquity(s) }, positions: livePositions(s) });
    }

    if (action === 'start') {
      const body = (req.body || {}) as Record<string, unknown>;
      let models: string[] = [];
      if (Array.isArray(body.models)) models = body.models.map(String).filter(Boolean).slice(0, 10);
      console.log('[arena-start] req:', models.join(',') || '(default)', Array.isArray(body.models) ? 'explicit' : 'default-pool');
      if (models.length === 0) {
        // default: cukup model gratis saja (peers berharga 0/0)
        let info: ArenaModelInfo[] = [];
        try {
          info = await listArenaModels();
        } catch (e) {
          return res.status(502).json({ ok: false, error: `Gateway models failed: ${e instanceof Error ? e.message : e}` });
        }
        const free = info.filter((m) => m.free);
        const pool = free.length > 0 ? free : info;
        const known = ['glm', 'deepseek', 'gpt', 'claude', 'gemini', 'grok', 'qwen', 'kimi', 'mimo', 'deepseek-2'];
        const seen = new Set<string>();
        for (const m of pool) {
          const fam = known.find((k) => m.id.toLowerCase().includes(k)) || m.id;
          const key = fam.split(/[\s/]/)[0].slice(0, 12);
          if (seen.has(key)) continue;
          seen.add(key);
          models.push(m.id);
          if (models.length >= 6) break;
        }
        if (models.length === 0) models = pool.slice(0, 4).map((m) => m.id);
      }
      if (models.length === 0) {
        return res.status(502).json({ ok: false, error: 'No text models available on gateway' });
      }
      const existing = await allStates();
      const taken = existing.map((s) => s.archetype).filter(Boolean);
      for (const id of models) {
        const prior = await loadState(id);
        if (prior) continue;
        const arch = pickArchetype(id, taken);
        taken.push(arch.name);
        await saveState(createArenaState(id, arch));
      }
      return res.status(200).json({ ok: true, started: models });
    }

    if (action === 'step') {
      const only = String(req.body?.model || '');
      const all = await allStates();
      for (const s of all) {
        if (pendingNormalization.has(s)) await saveState(s);
      }
      // Interval dari SEMUA agent (running + stopped) agar snapshot tersedia
      // untuk manageOpen posisi stopped agent.
      const allWithPos = all.filter((s) => s.positions && s.positions.length > 0);
      const targetPool = only ? all.filter((s) => s.model === only) : all.filter((s) => s.running);
      const targets = targetPool;

      if (targets.length === 0 && allWithPos.length === 0) {
        return res.status(200).json({ ok: true, ran: 0, lb: [], note: 'no running agents or open positions' });
      }

      // snapshot diambil per interval unik — semua model di interval sama tidak akan double-fetch
      // universe arena: crypto + US stock + oil + komoditas
      const preset = getPresetById('arena-multi') || getPresetById('paper-cross-asset');
      const universeRefs = preset?.assets ?? parseAssetList('binance:BTCUSDT,binance:ETHUSDT,yahoo:CL=F,yahoo:GC=F', []);
      const intervals = Array.from(new Set([...allWithPos, ...targets].map((s) => s.params.interval)));
      const snaps: Record<string, Awaited<ReturnType<typeof buildMultiTfSnapshot>>> = {};
      const bench = universeRefs.find((a) => a.symbol?.includes('BTC')) || universeRefs[0] || null;
      await Promise.allSettled(
        intervals.map(async (iv) => {
          snaps[iv] = await buildMultiTfSnapshot(universeRefs, bench, iv);
        })
      );
      if (Object.keys(snaps).length === 0) {
        return res.status(502).json({ ok: false, error: 'market snapshot failed' });
      }

      // Pre-step: kelola posisi TP/SL untuk SEMUA agent (termasuk yang stopped),
      // supaya posisi tetap ditutup saat TP/SL tercapai meskipun agent tidak running.
      for (const s of all) {
        if (!s.positions || s.positions.length === 0) continue;
        const snap = snaps[s.params.interval];
        if (!snap) continue;
        const changed = manageOpen(s, snap);
        if (changed) {
          recalculateArenaStats(s);
          const eq = arenaEquity(s);
          s.peakEquity = Math.max(s.peakEquity || 0, eq);
          s.maxDrawdownPct = Math.max(s.maxDrawdownPct || 0, s.peakEquity > 0 ? ((s.peakEquity - eq) / s.peakEquity) * 100 : 0);
          // Persist bar counts and partial exits even when position count is unchanged.
          await saveState(s);
        }
      }

      if (targets.length === 0) {
        return res.status(200).json({ ok: true, ran: 0, lb: [], note: 'no running agents' });
      }

      const results: Array<{ model: string; ok: boolean; fallback?: boolean; skipped?: boolean; error?: string; styleGuard?: string }> = [];
      const paramsBefore = new Map<string, string>();
      // sekali per request: sehat-tidaknya AntSeed dipakai semua agent saat menimbang 404
      let antseedHealthy: boolean | null = null;
      const gwHealthy = async () => (antseedHealthy ??= await pingGateway());
      for (const s of targets) paramsBefore.set(s.model, JSON.stringify(s.params));
      const score = (x: typeof all[number]) => arenaRankingScore(x.stats);
      const ranked = [...all].sort((a, b) => score(b) - score(a));
      for (const s of targets) {
        const rank = ranked.findIndex((x) => x.model === s.model) + 1;
        const lead = ranked[0];
        s.rankNote = `#${rank}/${all.length} confidence-adjusted expectancy · n=${s.stats.totalTrades} ${lead && lead.model !== s.model ? `· leader: ${lead.model}` : '· kamu leader'}`;
      }

      // Jalankan step tiap model PARALEL — Vercel 60s timeout, sequential berisiko melebihi
      // saat banyak model memakai DeepSeek fallback (timeout) atau retry prose.
      await Promise.allSettled(
        targets.map(async (s) => {
          const snap = snaps[s.params.interval];
          if (!snap || !Object.keys(snap.latest).length) {
            results.push({ model: s.model, ok: false, error: `no market data for ${s.params.interval}` });
            return;
          }
          ensureStyleUnique(s, all);
          const brief = othersBriefOf(s, all);
          try {
            const out = await arenaStep(s, snap, SYSTEM_PROMPT, Boolean(req.body?.force), brief);
            if (/error: 404\b/.test(out.error || '')) {
              // OUTAGE GUARD: gateway yang sedang mati / host yang berputar juga membalas 404.
              // 404 tunggal TIDAK menewaskan agent — marketplace bisa sempat mute/rebuild lima menit.
              // Terminate cuma kalau 404 beruntun ≥2x DAN gateway sehat di sekitarnya.
              const gatewayHealthy = s.model.startsWith(ARENA_OR_PREFIX) || (await gwHealthy());
              s.strike404 = (s.strike404 || 0) + 1;
              if (s.strike404 >= 2 && gatewayHealthy) {
                s.running = false;
                s.terminated = true;
                s.log = [...(s.log || []), `TERMINATED — gateway menolak permanen 2x beruntun (${(out.error || '').split('error: ')[1] || 'unknown'}). History & catatan dipertahankan.`];
              } else {
                s.log = [...(s.log || []), `⚠️ 404 (${s.strike404}x beruntun) — ${gatewayHealthy ? 'diberi kesempatan, cek ulang step berikutnya; agent TIDAK di-terminate.' : 'gateway ikut tidak sehat → agent TIDAK di-terminate.'}`];
              }
            } else if (/error: 402\b/.test(out.error || '')) {
              s.running = false;
              s.log = [...(s.log || []), `⏸ JEDA — kredit AntSeed habis (${(out.error || '').split('error: ')[1] || '402'}). Top-up di konsol AntSeed lalu klik resume — agent lanjut dari state terakhir.`];
            } else if (/PAID (peer|route)/i.test(out.error || '')) {
              s.running = false;
              s.log = [...(s.log || []), `⏸ JEDA — memakai peer BERBAYAR (${(out.error || '').split('paid peer ')[1] || 'paid'}). Aturan arena: free-only. Resume setelah routing gateway balik ke peer gratis.`];
            }
            if (!s.terminated && s.strike404 && s.strike404 > 0 && !/error: 404\b/.test(out.error || '')) {
              s.strike404 = 0; // step sukses — hitungan 404 beruntun di-nol-kan
            }
            const dup = all.some(
              (other) => other.model !== s.model && other.archetype === s.archetype && styleFingerprint(other) === styleFingerprint(s)
            );
            if (dup) {
              const prev = paramsBefore.get(s.model);
              if (prev) s.params = JSON.parse(prev);
              await saveState(s);
              results.push({ model: s.model, ok: true, fallback: out.fallback, skipped: out.skipped, styleGuard: 'reverted: tune buat identik dengan peserta lain' });
              return;
            }
            await saveState(s);
            results.push({ model: s.model, ok: true, fallback: out.fallback, skipped: out.skipped, error: out.error });
          } catch (e) {
            results.push({ model: s.model, ok: false, error: e instanceof Error ? e.message : String(e) });
          }
        })
      );
      const states = (
        await Promise.all(targets.map((t) => loadState(t.model)))
      ).filter((x): x is ArenaState => x !== null);
      return res.status(200).json({
        ok: true,
        ran: results.length,
        results,
        lb: leaderboard(states.filter(Boolean)),
        positions: states.filter(Boolean).flatMap(livePositions),
      });
    }

    if (action === 'stop') {
      const body = (req.body || {}) as Record<string, unknown>;
      const s = await loadState(String(body.model || ''));
      if (!s) return res.status(404).json({ ok: false, error: 'not started' });
      s.running = false;
      pushStopLog(s);
      await saveState(s);
      return res.status(200).json({ ok: true });
    }
    if (action === 'resume') {
      const body = (req.body || {}) as Record<string, unknown>;
      const s = await loadState(String(body.model || ''));
      if (!s) return res.status(404).json({ ok: false, error: 'not started' });
      // agent yang di-terminate gateway (402/404) tidak dihidupkan ulang — kecuali dipaksa
      if (s.terminated && !body.force) {
        return res.status(200).json({ ok: false, error: 'agent TERMINATED oleh gateway (402/404) — baru hidupkan lewat body {force:true} setelah model diberes di console' });
      }
      s.running = true;
      s.terminated = false; // force-resume bersihkan flag terminated agar bisa step lagi
      await saveState(s);
      return res.status(200).json({ ok: true });
    }

    if (action === 'reset') {
      const body = (req.body || {}) as Record<string, unknown>;
      const id = String(body.model || '');
      if (id) memory.delete(id);
      else memory.clear();
      // db reset satu model; reset 'all' tidak menghapus db (biar aman) —
      // pakai model eksplisit kalau mau hapus baris di Supabase
      if (isSupabaseConfigured() && id) {
        if (!isSupabaseAdminConfigured()) throw new Error('Arena reset requires SUPABASE_SERVICE_ROLE_KEY');
        const supa = getSupabaseAdmin();
        if (supa) {
          const { error } = await supa.from('ai_arena_agents').delete().eq('id', id);
          if (error) throw new Error(`Arena reset failed: ${error.message}`);
        }
      }
      return res.status(200).json({ ok: true, cleared: id || 'all-memory' });
    }

    return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Arena failed' });
  } finally {
    if (mutationLock) await mutationLock.release();
  }
}

function pushStopLog(s: ArenaState) {
  s.log = [`[${new Date().toISOString().slice(11, 19)}] stopped by user`, ...s.log].slice(0, 60);
}
