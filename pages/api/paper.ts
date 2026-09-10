import type { NextApiRequest, NextApiResponse } from 'next';
import { QuantRiskConfig } from '../../lib/quant/types';
import { DEFAULT_QUANT_RISK } from '../../lib/quant/risk';
import { getPresetById } from '../../lib/marketData/presets';
import { parseAssetList, AssetRef } from '../../lib/marketData';
import {
  createPaperState,
  paperStep,
  serializePaper,
  paperEquity,
  PaperState,
  StepMarketSnapshot,
} from '../../lib/quant/paperEngine';
import {
  autoTuneRisk,
  computeAgentKpi,
  getKpiForAgent,
} from '../../lib/quant/autoTune';
import {
  persistPaperTrade,
  persistParamTune,
  persistKpiSnapshot,
  fetchPaperTrades,
  fetchParamHistory,
  fetchKpiHistory,
  AgentId,
} from '../../lib/quant/paperStore';
import { getSupabase, isSupabaseConfigured } from '../../lib/supabase';
import { buildMultiTfSnapshot } from '../../lib/quant/paperMultiTf';
import { allocateMetaCapital, metaRiskScale, DeskPerf } from '../../lib/quant/metaAllocator';
import { releaseAgent } from '../../lib/quant/conflictGuard';
import { banditSummary } from '../../lib/quant/strategyBandit';
import { runStressTest } from '../../lib/quant/stressTest';

const VALID_AGENTS = new Set(['crypto', 'commodities', 'gold-silver', 'default']);
const memory = new Map<string, PaperState>();

function resolveAgentId(raw: unknown): AgentId {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return (VALID_AGENTS.has(s) ? s : 'default') as AgentId;
}

function parseRisk(body: Record<string, unknown>): QuantRiskConfig {
  const num = (k: string, d: number) => {
    const v = body[k];
    const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
    return Number.isFinite(n) ? n : d;
  };
  return {
    initialCapital: num('initialCapital', getKpiForAgent('crypto').capitalStart),
    riskPerTrade: num('riskPerTrade', DEFAULT_QUANT_RISK.riskPerTrade),
    stopLossATR: num('stopLossATR', DEFAULT_QUANT_RISK.stopLossATR),
    takeProfitATR: num('takeProfitATR', DEFAULT_QUANT_RISK.takeProfitATR),
    maxHoldBars: num('maxHoldBars', DEFAULT_QUANT_RISK.maxHoldBars),
    feeRate: num('feeRate', DEFAULT_QUANT_RISK.feeRate),
    slippage: num('slippage', DEFAULT_QUANT_RISK.slippage),
    maxConcurrentPositions: num('maxConcurrentPositions', DEFAULT_QUANT_RISK.maxConcurrentPositions),
    maxExposurePct: num('maxExposurePct', DEFAULT_QUANT_RISK.maxExposurePct),
    maxPortfolioDrawdownPct: num('maxPortfolioDrawdownPct', DEFAULT_QUANT_RISK.maxPortfolioDrawdownPct),
    minSignalStrength: num('minSignalStrength', DEFAULT_QUANT_RISK.minSignalStrength),
    allowShort: body.allowShort === true || body.allowShort === 'true',
    interval: String(body.interval || DEFAULT_QUANT_RISK.interval),
  };
}

async function loadState(agentId: AgentId): Promise<PaperState | null> {
  if (memory.has(agentId)) return memory.get(agentId)!;
  if (!isSupabaseConfigured()) return null;
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('paper_trading_state')
    .select('state')
    .eq('id', agentId)
    .maybeSingle();
  if (error || !data?.state) return null;
  const state = data.state as PaperState;
  memory.set(agentId, state);
  return state;
}

async function saveState(agentId: AgentId, state: PaperState): Promise<void> {
  memory.set(agentId, state);
  if (!isSupabaseConfigured()) return;
  const supabase = getSupabase();
  if (!supabase) return;
  const { error } = await supabase.from('paper_trading_state').upsert({
    id: agentId,
    state,
    updated_at: new Date().toISOString(),
  });
  if (error) console.warn('paper save failed', error.message);
}

async function buildSnapshot(
  universe: AssetRef[],
  benchmark: AssetRef | null,
  interval: string
): Promise<StepMarketSnapshot> {
  // Multi-timeframe view: 15m–1w with 120–300 bars each, aggregated confluence
  return buildMultiTfSnapshot(universe, benchmark, interval);
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET,POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const action =
      req.method === 'GET'
        ? String(req.query.action || 'status')
        : String(req.body?.action || 'status');

    const agentId = resolveAgentId(
      req.method === 'GET' ? req.query.agentId : (req.body as Record<string, unknown> | undefined)?.agentId
    );

    if (action === 'status') {
      const state = await loadState(agentId);
      if (!state) {
        return res.status(200).json({ ok: true, running: false, state: null, agentId });
      }
      const prices: Record<string, number> = { ...(state.lastPrices || {}) };
      for (const p of state.positions) {
        if (prices[p.symbol] === undefined) prices[p.symbol] = p.entryPrice;
      }
      const equity = paperEquity(state, prices);
      const kpi = computeAgentKpi(
        state.cash,
        state.startedAt,
        state.positions.length,
        state.stats.totalTrades,
        state.stats.winRate,
        agentId
      );
      return res.status(200).json({
        ok: true,
        running: state.running,
        agentId,
        state: { ...serializePaper(state), equity, kpi },
        kpi,
        meta: state.lastMeta
          ? { weights: state.lastMeta.weights, reason: state.lastMeta.reason, scale: state.lastMeta.scale }
          : undefined,
        bandit: state.lastBandit,
        stress: state.lastStress as never,
      });
    }

    if (action === 'history') {
      const [trades, params, kpis] = await Promise.all([
        fetchPaperTrades(50, agentId),
        fetchParamHistory(10, agentId),
        fetchKpiHistory(20, agentId),
      ]);
      return res.status(200).json({ ok: true, agentId, trades, params, kpis });
    }

    if (action === 'start') {
      const body = (req.body || {}) as Record<string, unknown>;
      const risk = parseRisk(body);
      const kpiCfg = getKpiForAgent(agentId);
      risk.initialCapital = kpiCfg.capitalStart;
      risk.allowShort = body.allowShort === true || body.allowShort === 'true' || risk.allowShort;
      const presetId = String(body.presetId || body.preset || 'binance-top');
      const preset = getPresetById(presetId);
      const custom = typeof body.symbols === 'string' ? body.symbols : '';
      const universeRefs = parseAssetList(custom, preset?.assets ?? []);
      if (universeRefs.length === 0) {
        return res.status(400).json({ error: 'Empty universe' });
      }
      const universeIds = universeRefs.map((a) => a.id);
      const state = createPaperState(risk, universeIds);
      state.log = [
        `[start:${agentId}] capital $${kpiCfg.capitalStart} · KPI +${(kpiCfg.monthlyTargetLow * 100).toFixed(0)}%..+${(kpiCfg.monthlyTargetHigh * 100).toFixed(0)}%/mo · universe=${universeIds.length}`,
        `[watch:${agentId}] live scan on ${risk.interval} · isolated state`,
        ...state.log,
      ].slice(0, 80);
      state.activity = `Agent ${agentId} online · watching ${universeIds.length} assets · capital $${kpiCfg.capitalStart}`;
      await saveState(agentId, state);
      const kpi = computeAgentKpi(state.cash, state.startedAt, 0, 0, 0, agentId);
      await persistKpiSnapshot(kpi, 0, agentId);
      return res.status(200).json({ ok: true, running: true, agentId, state: serializePaper(state), kpi });
    }

    if (action === 'stop') {
      const state = await loadState(agentId);
      if (!state) return res.status(200).json({ ok: true, running: false, state: null, agentId });
      state.running = false;
      releaseAgent(agentId);
      state.log = [`[stop:${agentId}] halted by user`, ...state.log].slice(0, 80);
      await saveState(agentId, state);
      return res.status(200).json({ ok: true, running: false, agentId, state: serializePaper(state) });
    }

    if (action === 'stress') {
      const trades = await fetchPaperTrades(200, agentId);
      const pnls = trades.map((t) => ({ pnl: Number(t.pnl || 0) }));
      const result = runStressTest(pnls, {
        iterations: 400,
        scenario: 'all',
        initialCapital: getKpiForAgent(agentId).capitalStart,
      });
      return res.status(200).json({ ok: true, agentId, stress: result });
    }

    if (action === 'reset') {
      memory.delete(agentId);
      if (isSupabaseConfigured()) {
        const supabase = getSupabase();
        if (supabase) {
          await supabase.from('paper_trading_state').delete().eq('id', agentId);
        }
      }
      return res.status(200).json({ ok: true, running: false, state: null, agentId });
    }

    if (action === 'step') {
      let state = await loadState(agentId);
      if (!state) {
        return res.status(200).json({ ok: true, running: false, state: null, note: 'not started', agentId });
      }
      if (!state.running) {
        state.activity = 'Stopped';
        return res.status(200).json({ ok: true, running: false, agentId, state: serializePaper(state) });
      }

      const refs = parseAssetList(state.universe.join(','), []);
      const presetBenchmark =
        refs.find((a) => a.symbol.includes('BTC')) ||
        refs.find((a) => a.symbol.includes('GC')) ||
        refs.find((a) => a.symbol.includes('CL')) ||
        refs[0] ||
        null;

      // MetaAllocator: rebalance capital share across 3 desks
      const deskPerf: DeskPerf[] = [];
      for (const id of ['crypto', 'commodities', 'gold-silver'] as const) {
        const s = id === agentId ? state : await loadState(id);
        const kpiCfg = getKpiForAgent(id);
        deskPerf.push({
          agentId: id,
          equity: s ? s.cash : kpiCfg.capitalStart,
          capitalStart: kpiCfg.capitalStart,
          pnlPercent: s
            ? ((s.cash - kpiCfg.capitalStart) / kpiCfg.capitalStart) * 100
            : 0,
          winRate: s?.stats?.winRate ?? 0,
          totalTrades: s?.stats?.totalTrades ?? 0,
          maxDrawdownPct:
            s && s.peakEquity > 0
              ? ((s.peakEquity - s.cash) / s.peakEquity) * 100
              : 0,
          running: Boolean(s?.running),
        });
      }
      const meta = allocateMetaCapital(deskPerf);
      state.metaWeight = meta.weights[agentId] ?? 1 / 3;
      state.lastMeta = {
        weights: meta.weights,
        reason: meta.reason,
        scale: metaRiskScale(meta, agentId),
        at: Date.now(),
      };
      if (state.risk) {
        state.risk = {
          ...state.risk,
          riskPerTrade: Math.min(
            0.02,
            state.risk.riskPerTrade * metaRiskScale(meta, agentId)
          ),
        };
      }

      state.activity = `Fetching live candles (${refs.length} assets)…`;
      const snap = await buildMultiTfSnapshot(refs, presetBenchmark, state.risk.interval);
      const stepResult = paperStep(state, snap, agentId);
      state = stepResult.state;

      for (const t of stepResult.closedTrades) {
        const prices: Record<string, number> = {};
        for (const p of state.positions) prices[p.symbol] = p.entryPrice;
        const eq = paperEquity(state, prices);
        await persistPaperTrade(t, state, eq, agentId);
      }

      const recent = state.trades.slice(0, 15);
      const recentWin =
        recent.length > 0
          ? (recent.filter((t) => t.pnl > 0).length / recent.length) * 100
          : state.stats.winRate;
      const kpi = computeAgentKpi(
        state.cash,
        state.startedAt,
        state.positions.length,
        state.stats.totalTrades,
        state.stats.winRate,
        agentId
      );
      const tune = autoTuneRisk(state.risk, kpi, recentWin, state.trades.length, agentId);
      if (tune.changed) {
        const oldParams = { ...state.risk };
        state.risk = tune.risk;
        state.log = [
          `[tune] ${tune.reason} · risk/trade ${(tune.risk.riskPerTrade * 100).toFixed(2)}% · maxPos ${tune.risk.maxConcurrentPositions} · minStr ${tune.risk.minSignalStrength}`,
          ...state.log,
        ].slice(0, 80);
        await persistParamTune(tune.reason, kpi, oldParams, state.risk, agentId);
      }

      const banditNote = state.bandit ? banditSummary(state.bandit) : '';
      state.lastBandit = banditNote || state.lastBandit;
      if (banditNote && stepResult.closedTrades.length > 0) {
        state.log = [`[bandit] ${banditNote}`, ...state.log].slice(0, 80);
      }

      // Auto stress: always once we have any trades; refresh every ~10 closed
      if (state.trades.length > 0 && (!state.lastStress || state.stats.totalTrades % 10 === 0)) {
        const stress = runStressTest(
          state.trades.slice(0, 200).map((t) => ({ pnl: t.pnl })),
          {
            iterations: 300,
            scenario: 'all',
            initialCapital: getKpiForAgent(agentId).capitalStart,
          }
        );
        state.lastStress = stress;
      }

      await saveState(agentId, state);
      await persistKpiSnapshot(kpi, state.positions.length, agentId);

      return res.status(200).json({
        ok: true,
        running: state.running,
        agentId,
        state: serializePaper(state),
        kpi,
        meta: state.lastMeta
          ? { weights: state.lastMeta.weights, reason: state.lastMeta.reason, scale: state.lastMeta.scale }
          : { weights: meta.weights, reason: meta.reason, scale: metaRiskScale(meta, agentId) },
        bandit: state.lastBandit || banditNote,
        stress: state.lastStress as never,
        tune: { reason: tune.reason, changed: tune.changed },
        closedThisStep: stepResult.closedTrades.length,
        lastSignals: snap.signals.slice(0, 20),
      });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Paper agent failed',
    });
  }
}
