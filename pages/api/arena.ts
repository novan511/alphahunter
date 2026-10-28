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
  pickArchetype,
  styleFingerprint,
  ensureStyleUnique,
  manageOpen,
  ensureGatewayKeepalive,
  gatewayHealth,
  pingGateway,
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

Ruled by the guardrails above, everything else is YOUR call. Keep iterating to raise avg R — but you must stay in the archetype/style assigned to your agent (stated at the top of every session): entry timing, thresholds, targets, risk size and hold time are yours to tune; copying another competitor's whole playbook is impossible anyway (style-guard reverts it). Rationalize every iteration in one line: what you changed, why you believe it raises avg R.`;

async function loadState(modelId: string): Promise<ArenaState | null> {
  if (memory.has(modelId)) return memory.get(modelId)!;
  if (!isSupabaseConfigured()) return null;
  const supa = getSupabase();
  if (!supa) return null;
  const { data } = await supa.from('ai_arena_agents').select('state').eq('id', modelId).maybeSingle();
  if (data?.state) {
    const st = data.state as ArenaState;
    memory.set(modelId, st);
    return normalizeState(st);
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

/** ringkasan pikiran & trade history agent LAIN — diberikan ke tiap agent biar belajar satu sama
 *  lain (berbeda gaya, tapi saling melihat pola R & cara berpikir). Dipangkas ringkas per agent. */
function othersBriefOf(s: ArenaState, all: ArenaState[]): string {
  const others = all.filter((o) => o.model !== s.model && o.running);
  if (others.length === 0) return '';
  const lines = others.map((o) => {
    const avgR = o.stats.totalTrades ? o.stats.totalR / o.stats.totalTrades : 0;
    const th = (o.thoughts || [])[0];
    const think = th ? `pikirannya: "${(th.thoughtPlain || th.thought || '').slice(0, 180)}"` : 'belum ada pikiran terekam';
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
        openCount: s.positions.length,
        iterCount: s.iterCount,
        iterNote: s.iterNote,
        thoughts: s.thoughts || [],
        params: s.params,
        equityHistory: (s.equityHistory || []).slice(-150).map((p) => p.equity),
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
  return Array.from(merged.values()).map(normalizeState);
}

/** kompatibilitas state lama (pra-arketipe / pra-thoughts) */
function normalizeState(st: ArenaState): ArenaState {
  if (!st.archetype) {
    st.archetype = 'Momentum General';
    st.mandate = 'generalist momentum (warisan pra-arketipe)';
    st.classes = ['momentum'];
  }
  if (!st.thoughts) st.thoughts = [];
  if (!st.lastBarTimes) st.lastBarTimes = {};
  for (const p of st.positions || []) {
    // posisi lama belum punya riskUnit (dipakai liveR saat stop sudah di-trail)
    if (!p.riskUnit) p.riskUnit = p.riskDollar && p.qty ? p.riskDollar / p.qty : p.entryATR * st.params.stopLossATR;
  }
  return st;
}

/** serialisasi ringan untuk live-positions di UI */
function livePositions(s: ArenaState) {
  return s.positions.map((p) => {
    const mark = s.lastPrices[p.symbol] ?? p.entryPrice;
    const riskDollar = p.riskDollar || p.riskUnit * p.qty || 1;
    const liveR =
      Math.round((((p.side === 'long' ? mark - p.entryPrice : p.entryPrice - mark) * p.qty) / riskDollar) * 100) / 100;
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
        deepseekFallback: Boolean(process.env.DEEPSEEK_API_KEY_2),
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
      // single-flight: step auto-loop browser + manual force yang overlap akan menimpa state satu sama lain
      if (stepInFlight) return res.status(200).json({ ok: false, busy: true, note: 'step masih berjalan — request di-skip' });
      stepInFlight = true;
      try {
      const only = String(req.body?.model || '');
      const all = await allStates();
      // Interval dari SEMUA agent (running + stopped) agar snapshot tersedia
      // untuk manageOpen posisi stopped agent.
      const allWithPos = all.filter((s) => s.positions && s.positions.length > 0);
      const targetPool = only ? all.filter((s) => s.model === only) : all.filter((s) => s.running);
      const targets = targetPool;

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
        const snap = snaps[s.params.interval] || snaps[intervals[0]];
        if (!snap) continue;
        const before = s.positions.length;
        manageOpen(s, snap);
        if (s.positions.length !== before) {
          await saveState(s);
        }
      }

      if (targets.length === 0) {
        return res.status(200).json({ ok: true, ran: 0, lb: [], note: 'no running agents' });
      }

      const results: Array<{ model: string; ok: boolean; fallback?: boolean; error?: string; styleGuard?: string }> = [];
      const paramsBefore = new Map<string, string>();
      for (const s of targets) paramsBefore.set(s.model, JSON.stringify(s.params));
      const totalRof = (x: typeof all[number]) => x.trades.reduce((acc, t) => acc + t.r, 0);
      const ranked = [...all].sort((a, b) => totalRof(b) - totalRof(a));
      for (const s of targets) {
        const rank = ranked.findIndex((x) => x.model === s.model) + 1;
        const lead = ranked[0];
        s.rankNote = `#${rank}/${all.length} by totalR ${lead && lead.model !== s.model ? `· pemimpin: ${lead.model}` : '· kamu pemimpin'}`;
      }

      // Jalankan step tiap model PARALEL — Vercel 60s timeout, sequential berisiko melebihi
      // saat banyak model memakai DeepSeek fallback (timeout) atau retry prose.
      await Promise.allSettled(
        targets.map(async (s) => {
          const snap = snaps[s.params.interval] || snaps[intervals[0]];
          if (!snap) {
            results.push({ model: s.model, ok: false, error: 'no snapshot' });
            return;
          }
          ensureStyleUnique(s, all);
          const brief = othersBriefOf(s, all);
          try {
            const out = await arenaStep(s, snap, SYSTEM_PROMPT, Boolean(req.body?.force), brief);
            if (/error: 404\b/.test(out.error || '')) {
              s.running = false;
              s.terminated = true;
              s.log = [...(s.log || []), `TERMINATED — gateway menolak permanen (${(out.error || '').split('error: ')[1] || 'unknown'}). History & catatan dipertahankan.`];
            } else if (/error: 402\b/.test(out.error || '')) {
              s.running = false;
              s.log = [...(s.log || []), `⏸ JEDA — kredit AntSeed habis (${(out.error || '').split('error: ')[1] || '402'}). Top-up di konsol AntSeed lalu klik resume — agent lanjut dari state terakhir.`];
            } else if (/PAID (peer|route)/i.test(out.error || '')) {
              s.running = false;
              s.log = [...(s.log || []), `⏸ JEDA — memakai peer BERBAYAR (${(out.error || '').split('paid peer ')[1] || 'paid'}). Aturan arena: free-only. Resume setelah routing gateway balik ke peer gratis.`];
            }
            const dup = all.some(
              (other) => other.model !== s.model && other.archetype === s.archetype && styleFingerprint(other) === styleFingerprint(s)
            );
            if (dup) {
              const prev = paramsBefore.get(s.model);
              if (prev) s.params = JSON.parse(prev);
              results.push({ model: s.model, ok: true, fallback: out.fallback, styleGuard: 'reverted: tune buat identik dengan peserta lain' });
              return;
            }
            await saveState(s);
            results.push({ model: s.model, ok: true, fallback: out.fallback, error: out.error });
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
      } finally {
        stepInFlight = false;
      }
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
