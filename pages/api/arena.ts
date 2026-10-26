import type { NextApiRequest, NextApiResponse } from 'next';
import { parseAssetList } from '../../lib/marketData';
import { getPresetById } from '../../lib/marketData/presets';
import { buildMultiTfSnapshot } from '../../lib/quant/paperMultiTf';
import {
  ArenaState,
  createArenaState,
  listArenaModels,
  arenaStep,
  arenaEquity,
  ArenaModelInfo,
} from '../../lib/quant/arena';
import { getSupabase, isSupabaseConfigured } from '../../lib/supabase';

export const config = { maxDuration: 60 };

const memory = new Map<string, ArenaState>();

const SYSTEM_PROMPT = `You are an autonomous trading agent in the Althunter AI Arena, competing against other LLM models. You start with $1000 of virtual capital, paper-trading across crypto, US equities/ETFs, oil and commodities using the Althunter engines: multi-timeframe confluence signals (15m/1w), spike detection, relative-strength decoupling, ATR-based risk sizing.

YOUR ONLY GOAL: maximize R expectancy — the average R multiple per trade. A win rate of 30% with avg win R=4 and avg loss R=1 beats a win rate of 70% with avg win R=1.2. Think in R units: every trade risks exactly 1R. Best total R wins the leaderboard.

NON-NEGOTIABLE GUARDRAILS (the engine enforces these; violations are rejected):
1. A stop-loss is attached to every position at entry — no unbundled risk, ever.
2. Risk per trade 0.5%-3% of equity; total open risk across all positions max 6% of equity.
3. Max 5 concurrent positions.
4. Circuit breaker: if your open unrealized R drops to -3R, new entries are blocked until total open R recovers above -3R.
5. Equity floor $500: below that you are knocked out of the arena.
6. No revenge trading mechanics: position limits and risk caps apply even during a losing streak.

Colored by which guardrails constrain you, everything else is YOUR call. You are expected to keep iterating — not stay committed to one method: switch between momentum, mean reversion, spike-following, decoupling, trend-following, tighten or widen targets, change thresholds, intervals, short/long bias. Rationalize every iteration in one line: what you changed, why you believe it raises avg R.`;

async function loadState(modelId: string): Promise<ArenaState | null> {
  if (memory.has(modelId)) return memory.get(modelId)!;
  if (!isSupabaseConfigured()) return null;
  const supa = getSupabase();
  if (!supa) return null;
  const { data } = await supa.from('ai_arena_agents').select('state').eq('id', modelId).maybeSingle();
  if (data?.state) {
    const st = data.state as ArenaState;
    memory.set(modelId, st);
    return st;
  }
  return null;
}

async function saveState(s: ArenaState): Promise<void> {
  memory.set(s.model, s);
  if (!isSupabaseConfigured()) return;
  const supa = getSupabase();
  if (!supa) return;
  const { error } = await supa.from('ai_arena_agents').upsert({ id: s.model, state: s, updated_at: new Date().toISOString() });
  if (error) console.warn('arena save failed', error.message);
}

export function leaderboard(states: ArenaState[]) {
  return states
    .map((s) => {
      const eq = arenaEquity(s);
      return {
        model: s.model,
        running: s.running,
        equity: Math.round(eq * 100) / 100,
        pnlPct: Math.round(((eq - 1000) / 10) * 100) / 100, // % dari $1000
        openCount: s.positions.length,
        iterCount: s.iterCount,
        iterNote: s.iterNote,
        thoughts: (s.thoughts || []).slice(0, 6),
        params: s.params,
        stats: s.stats,
      };
    })
    .sort((a, b) => b.stats.totalR - a.stats.totalR || b.equity - a.equity);
}

/** gabung memori proses (terbaru) dengan baris Supabase — table belum jalan pun arena tetap hidup */
async function allStates(): Promise<ArenaState[]> {
  const merged = new Map<string, ArenaState>();
  if (isSupabaseConfigured()) {
    const supa = getSupabase();
    const { data } = await supa!.from('ai_arena_agents').select('state');
    for (const r of data ?? []) {
      const st = r.state as ArenaState;
      if (st?.model && !memory.has(st.model)) merged.set(st.model, st);
    }
  }
  for (const [k, v] of Array.from(memory.entries())) merged.set(k, v);
  return Array.from(merged.values());
}

/** serialisasi ringan untuk live-positions di UI */
function livePositions(s: ArenaState) {
  return s.positions.map((p) => {
    const mark = s.lastPrices[p.symbol] ?? p.entryPrice;
    const riskU = p.riskDollar && p.qty ? p.riskDollar / p.qty : p.entryATR * s.params.stopLossATR;
    const liveR =
      Math.round(((p.side === 'long' ? mark - p.entryPrice : p.entryPrice - mark) / riskU) * 100) / 100;
    return {
      model: s.model,
      symbol: p.symbol,
      side: p.side,
      entryPrice: Math.round(p.entryPrice * 10000) / 10000,
      markPrice: Math.round(mark * 10000) / 10000,
      stopLoss: Math.round(p.stopLoss * 10000) / 10000,
      takeProfit: Math.round(p.takeProfit * 10000) / 10000,
      liveR,
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

  try {
    if (action === 'models') {
      const all = await listArenaModels();
      const free = all.filter((m) => m.free);
      return res.status(200).json({
        ok: true,
        models: free.length > 0 ? free : all,
        gatewayConfigured: all.length > 0,
      });
    }

    if (action === 'leaderboard') {
      const states = await allStates();
      return res.status(200).json({
        ok: true,
        lb: leaderboard(states),
        positions: states.flatMap(livePositions),
        persisted: isSupabaseConfigured(),
      });
    }

    if (action === 'detail') {
      const model = String(req.method === 'GET' ? req.query.model : req.body?.model || '');
      const s = await loadState(model);
      if (!s) return res.status(404).json({ ok: false, error: 'not started' });
      return res.status(200).json({ ok: true, state: { ...s, equity: arenaEquity(s) }, positions: livePositions(s) });
    }

    if (action === 'start') {
      const body = (req.body || {}) as Record<string, unknown>;
      let models: string[] = [];
      if (Array.isArray(body.models)) models = body.models.map(String).filter(Boolean).slice(0, 10);
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
        const known = ['glm', 'deepseek', 'gpt', 'claude', 'gemini', 'grok', 'qwen', 'kimi', 'mimo'];
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
      for (const id of models) {
        const existing = await loadState(id);
        if (existing) continue;
        await saveState(createArenaState(id));
      }
      return res.status(200).json({ ok: true, started: models });
    }

    if (action === 'step') {
      const only = String(req.body?.model || '');
      const all = await allStates();
      const targets = only ? all.filter((s) => s.model === only) : all.filter((s) => s.running);
      if (targets.length === 0) {
        return res.status(200).json({ ok: true, ran: 0, lb: [], note: 'no running agents' });
      }

      // snapshot diambil per interval unik — semua model di interval sama tidak akan double-fetch
      // universe arena: crypto + US stock + oil + komoditas
      const preset = getPresetById('arena-multi') || getPresetById('paper-cross-asset');
      const universeRefs = preset?.assets ?? parseAssetList('binance:BTCUSDT,binance:ETHUSDT,yahoo:CL=F,yahoo:GC=F', []);
      const intervals = Array.from(new Set(targets.map((s) => s.params.interval)));
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

      const results: Array<{ model: string; ok: boolean; fallback?: boolean; error?: string }> = [];
      for (const s of targets) {
        const snap = snaps[s.params.interval] || snaps[intervals[0]];
        if (!snap) { results.push({ model: s.model, ok: false, error: 'no snapshot' }); continue; }
        try {
          const out = await arenaStep(s, snap, SYSTEM_PROMPT, Boolean(req.body?.force));
          await saveState(s);
          results.push({ model: s.model, ok: true, fallback: out.fallback, error: out.error });
        } catch (e) {
          results.push({ model: s.model, ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
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
      s.running = true;
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
        const supa = getSupabase();
        if (supa) await supa.from('ai_arena_agents').delete().eq('id', id);
      }
      return res.status(200).json({ ok: true, cleared: id || 'all-memory' });
    }

    return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Arena failed' });
  }
}

function pushStopLog(s: ArenaState) {
  s.log = [`[${new Date().toISOString().slice(11, 19)}] stopped by user`, ...s.log].slice(0, 60);
}
