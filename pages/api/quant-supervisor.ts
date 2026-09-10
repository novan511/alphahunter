import type { NextApiRequest, NextApiResponse } from 'next';
import { MARKET_PROFILES, MarketId } from '../../lib/quant/marketProfiles';
import { getKpiForAgent } from '../../lib/quant/autoTune';
import { getSupabase, isSupabaseConfigured } from '../../lib/supabase';
import {
  buildSupervisorPayload,
  generateSupervisorInsight,
  DeskSnapshot,
  SupervisorInsight,
} from '../../lib/quant/supervisorInsight';

const AGENTS: MarketId[] = ['crypto', 'commodities', 'gold-silver'];

export interface EquityPoint {
  time: number;
  equity: number;
}

export interface SupervisorCharts {
  desks: Array<{ agentId: string; label: string; accent: string; series: EquityPoint[] }>;
  total: EquityPoint[];
}

async function loadDesk(agentId: MarketId): Promise<DeskSnapshot> {
  const cfg = getKpiForAgent(agentId);
  const empty: DeskSnapshot = {
    agentId,
    running: false,
    equity: cfg.capitalStart,
    cash: cfg.capitalStart,
    openPositions: 0,
    totalTrades: 0,
    winRate: 0,
    pnlPercent: 0,
    paceMonthlyPercent: 0,
    kpiStatus: 'offline',
    activity: 'Agent offline',
    updatedAt: null,
    monthlyTargetLow: cfg.monthlyTargetLow,
    monthlyTargetHigh: cfg.monthlyTargetHigh,
    capitalStart: cfg.capitalStart,
    recentTrades: [],
    openList: [],
    lastActivityLog: [],
    equityHistory: [{ time: Date.now(), equity: cfg.capitalStart }],
  };

  if (isSupabaseConfigured()) {
    const supabase = getSupabase();
    if (supabase) {
      const { data } = await supabase
        .from('paper_trading_state')
        .select('state')
        .eq('id', agentId)
        .maybeSingle();
      if (data?.state) {
        const s = data.state as Record<string, unknown>;
        const positions = (s.positions as DeskSnapshot['openList']) || [];
        const trades = (s.trades as DeskSnapshot['recentTrades']) || [];
        const stats = (s.stats as { totalTrades?: number; winRate?: number }) || {};
        const equityHistory = (s.equityHistory as EquityPoint[]) || [];
        const cash = Number(s.cash ?? cfg.capitalStart);
        const kpiStatus = s.halted ? 'critical' : s.running ? 'running' : 'stopped';
        return {
          agentId,
          running: Boolean(s.running),
          equity: Number(s.equity ?? cash),
          cash,
          openPositions: positions.length,
          totalTrades: Number(stats.totalTrades ?? trades.length),
          winRate: Number(stats.winRate ?? 0),
          pnlPercent:
            cfg.capitalStart > 0
              ? Math.round(((cash - cfg.capitalStart) / cfg.capitalStart) * 10000) / 100
              : 0,
          paceMonthlyPercent: 0,
          kpiStatus,
          activity: String(s.activity || ''),
          updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : null,
          monthlyTargetLow: cfg.monthlyTargetLow,
          monthlyTargetHigh: cfg.monthlyTargetHigh,
          capitalStart: cfg.capitalStart,
          recentTrades: trades.slice(0, 8).map((t) => ({
            symbol: String(t.symbol || ''),
            side: String(t.side || ''),
            pnl: Number(t.pnl || 0),
            pnlPercent: Number(t.pnlPercent || 0),
            exitReason: String(t.exitReason || ''),
          })),
          openList: positions.slice(0, 8).map((p) => ({
            symbol: String(p.symbol || ''),
            side: String(p.side || ''),
            entryPrice: Number(p.entryPrice || 0),
            markPrice: Number((p as { markPrice?: number }).markPrice || 0),
            unrealizedPnl: Number((p as { unrealizedPnl?: number }).unrealizedPnl || 0),
          })),
          lastActivityLog: ((s.log as string[]) || []).slice(0, 6),
          equityHistory:
            equityHistory.length > 0
              ? equityHistory
              : [{ time: Date.now(), equity: Number(s.equity ?? cash) }],
        };
      }
    }
  }

  return empty;
}

function buildCharts(desks: DeskSnapshot[]): SupervisorCharts {
  const accents: Record<string, string> = {
    crypto: '#3b82f6',
    commodities: '#f59e0b',
    'gold-silver': '#eab308',
  };
  const labels: Record<string, string> = {
    crypto: 'Quant Crypto',
    commodities: 'Quant Commodities',
    'gold-silver': 'Quant Gold & Silver',
  };

  const deskSeries = desks.map((d) => ({
    agentId: d.agentId,
    label: labels[d.agentId] || d.agentId,
    accent: accents[d.agentId] || '#93c5fd',
    series: d.equityHistory?.length
      ? d.equityHistory
      : [{ time: Date.now(), equity: d.equity }],
  }));

  // Align total equity by timestamp buckets (minute)
  const bucketMs = 60_000;
  const sums = new Map<number, { equity: number; count: number }>();
  for (const d of desks) {
    for (const pt of d.equityHistory || []) {
      const key = Math.floor(pt.time / bucketMs) * bucketMs;
      const cur = sums.get(key) || { equity: 0, count: 0 };
      cur.equity += pt.equity;
      cur.count += 1;
      sums.set(key, cur);
    }
  }
  // Fill missing desks with their capitalStart for fair total
  const totalStart = desks.reduce((a, d) => a + d.capitalStart, 0);
  const keys = Array.from(sums.keys()).sort((a, b) => a - b);
  const total: EquityPoint[] = keys.map((time) => {
    const row = sums.get(time)!;
    // if a desk missing that bucket, approximate with its latest equity
    let equity = row.equity;
    const covered = row.count;
    if (covered < desks.length) {
      for (const d of desks) {
        const has = (d.equityHistory || []).some(
          (p) => Math.floor(p.time / bucketMs) * bucketMs === time
        );
        if (!has) equity += d.equity;
      }
    }
    return { time, equity: Math.round(equity * 100) / 100 };
  });

  if (total.length === 0) {
    total.push({ time: Date.now(), equity: totalStart });
  }

  return { desks: deskSeries, total };
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<
    SupervisorInsight & { charts?: SupervisorCharts } | { error: string }
  >
) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET,POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const desks = await Promise.all(AGENTS.map((id) => loadDesk(id)));
    void MARKET_PROFILES;

    const payload = buildSupervisorPayload(desks);
    const insight = await generateSupervisorInsight(payload);
    const charts = buildCharts(desks);
    return res.status(200).json({ ...insight, charts });
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Supervisor failed',
    });
  }
}
