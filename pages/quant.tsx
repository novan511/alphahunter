import React, { useCallback, useEffect, useState } from 'react';
import Layout from '../components/Layout/Layout';
import { MARKET_PROFILES, MarketId } from '../lib/quant/marketProfiles';
import { getKpiForAgent } from '../lib/quant/autoTune';

interface AgentStatusLite {
  agentId: string;
  running: boolean;
  equity: number;
  cash: number;
  openPositions: number;
  totalTrades: number;
  winRate: number;
  pnlPercent: number;
  paceMonthlyPercent: number;
  kpiStatus: string;
  activity: string;
  updatedAt: number | null;
  monthlyTargetLow: number;
  monthlyTargetHigh: number;
  capitalStart: number;
  watchCount: number;
  lastTradePnl: number | null;
}

interface MarketCard extends AgentStatusLite {
  market: MarketId;
  title: string;
  subtitle: string;
  accent: string;
  href: string;
}

const AGENTS: MarketId[] = ['crypto', 'commodities', 'gold-silver'];

const HREFS: Record<MarketId, string> = {
  crypto: '/quant-crypto',
  commodities: '/quant-commodities',
  'gold-silver': '/quant-gold-silver',
};

async function fetchAgentStatus(agentId: string): Promise<AgentStatusLite | null> {
  try {
    const res = await fetch(`/api/paper?action=status&agentId=${encodeURIComponent(agentId)}`);
    if (!res.ok) return null;
    const data = await res.json();
    const state = data.state;
    const kpi = data.kpi;
    const cfg = getKpiForAgent(agentId);

    if (!state) {
      return {
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
        activity: 'Agent belum start di halaman market ini',
        updatedAt: null,
        monthlyTargetLow: cfg.monthlyTargetLow,
        monthlyTargetHigh: cfg.monthlyTargetHigh,
        capitalStart: cfg.capitalStart,
        watchCount: 0,
        lastTradePnl: null,
      };
    }

    const trades = Array.isArray(state.trades) ? state.trades : [];
    return {
      agentId,
      running: Boolean(state.running),
      equity: Number(state.equity ?? state.cash ?? cfg.capitalStart),
      cash: Number(state.cash ?? cfg.capitalStart),
      openPositions: Number(state.openCount ?? state.positions?.length ?? 0),
      totalTrades: Number(state.stats?.totalTrades ?? trades.length),
      winRate: Number(state.stats?.winRate ?? 0),
      pnlPercent: Number(kpi?.pnlPercent ?? state.stats?.totalPnLPercent ?? 0),
      paceMonthlyPercent: Number(kpi?.paceMonthlyPercent ?? 0),
      kpiStatus: String(kpi?.status ?? (state.running ? 'running' : 'stopped')),
      activity: String(state.activity || (state.running ? 'Monitoring…' : 'Stopped')),
      updatedAt: state.updatedAt ?? null,
      monthlyTargetLow: Number(kpi?.monthlyTargetLow ?? cfg.monthlyTargetLow),
      monthlyTargetHigh: Number(kpi?.monthlyTargetHigh ?? cfg.monthlyTargetHigh),
      capitalStart: Number(kpi?.capitalStart ?? cfg.capitalStart),
      watchCount: Array.isArray(state.watchlist) ? state.watchlist.length : 0,
      lastTradePnl: trades[0]?.pnl ?? null,
    };
  } catch {
    return null;
  }
}

function statusColor(s: string): string {
  if (s === 'ahead' || s === 'on_track') return '#10b981';
  if (s === 'behind' || s === 'fresh') return '#f59e0b';
  if (s === 'critical') return '#ef4444';
  if (s === 'offline') return '#6b7280';
  return '#93c5fd';
}

function statusLabel(s: string): string {
  if (s === 'ahead') return 'AHEAD';
  if (s === 'on_track') return 'ON TRACK';
  if (s === 'behind') return 'BEHIND';
  if (s === 'critical') return 'CRITICAL';
  if (s === 'offline') return 'OFFLINE';
  if (s === 'fresh') return 'FRESH';
  return s.replace(/_/g, ' ').toUpperCase();
}

export default function QuantSupervisorPage() {
  const [cards, setCards] = useState<MarketCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const results = await Promise.all(AGENTS.map((id) => fetchAgentStatus(id)));
    const next: MarketCard[] = AGENTS.map((id, i) => {
      const profile = MARKET_PROFILES[id];
      const status = results[i];
      return {
        market: id,
        title: profile.title,
        subtitle: profile.subtitle,
        accent: profile.accent,
        href: HREFS[id],
        agentId: id,
        running: status?.running ?? false,
        equity: status?.equity ?? profile.baseRisk.initialCapital,
        cash: status?.cash ?? profile.baseRisk.initialCapital,
        openPositions: status?.openPositions ?? 0,
        totalTrades: status?.totalTrades ?? 0,
        winRate: status?.winRate ?? 0,
        pnlPercent: status?.pnlPercent ?? 0,
        paceMonthlyPercent: status?.paceMonthlyPercent ?? 0,
        kpiStatus: status?.kpiStatus ?? 'offline',
        activity: status?.activity ?? 'No data',
        updatedAt: status?.updatedAt ?? null,
        monthlyTargetLow: status?.monthlyTargetLow ?? profile.kpi.monthlyTargetLow,
        monthlyTargetHigh: status?.monthlyTargetHigh ?? profile.kpi.monthlyTargetHigh,
        capitalStart: status?.capitalStart ?? profile.baseRisk.initialCapital,
        watchCount: status?.watchCount ?? 0,
        lastTradePnl: status?.lastTradePnl ?? null,
      };
    });
    setCards(next);
    setLastRefresh(Date.now());
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  const runningCount = cards.filter((c) => c.running).length;
  const totalEquity = cards.reduce((a, c) => a + c.equity, 0);
  const totalCapital = cards.reduce((a, c) => a + c.capitalStart, 0);
  const totalOpen = cards.reduce((a, c) => a + c.openPositions, 0);
  const totalTrades = cards.reduce((a, c) => a + c.totalTrades, 0);
  const avgPnl =
    cards.length > 0 ? cards.reduce((a, c) => a + c.pnlPercent, 0) / cards.length : 0;

  return (
    <Layout>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#8b5cf6', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>
          Supervisor Desk
        </div>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: '#f9fafb', margin: 0 }}>
          Quant Command Center
        </h2>
        <p style={{ fontSize: 12, color: '#9ca3af', margin: '6px 0 0', maxWidth: 720 }}>
          Monitoring & supervisi 3 market desk. Trading, watchlist, dan parameter
          dijalankan di masing-masing halaman market — halaman ini hanya overview performa.
        </p>
        <div style={{ fontSize: 11, color: '#6b7280', marginTop: 6 }}>
          {lastRefresh
            ? `Auto-refresh setiap 30s · last ${new Date(lastRefresh).toLocaleTimeString()}`
            : 'Memuat status agents…'}
        </div>
      </div>

      {/* Portfolio of desks */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 10, marginBottom: 20 }}>
        <Tile label="Desks Running" value={`${runningCount}/3`} color={runningCount === 3 ? '#10b981' : runningCount > 0 ? '#f59e0b' : '#6b7280'} />
        <Tile label="Total Equity" value={`$${totalEquity.toFixed(2)}`} hint={`start $${totalCapital}`} />
        <Tile label="Avg PnL%" value={`${avgPnl.toFixed(2)}%`} color={avgPnl >= 0 ? '#10b981' : '#ef4444'} />
        <Tile label="Open Positions" value={totalOpen} />
        <Tile label="Total Paper Trades" value={totalTrades} />
      </div>

      {loading && cards.length === 0 ? (
        <div style={{ padding: 32, textAlign: 'center', color: '#6b7280', background: '#111827', borderRadius: 12, border: '1px solid #374151' }}>
          Loading agent status…
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
          {cards.map((c) => (
            <div
              key={c.market}
              style={{
                background: '#111827',
                border: `1px solid ${c.running ? c.accent + '55' : '#374151'}`,
                borderRadius: 12,
                overflow: 'hidden',
              }}
            >
              <div style={{
                padding: '12px 14px',
                borderBottom: '1px solid #374151',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                gap: 8,
              }}>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: c.accent, textTransform: 'uppercase' }}>
                    {c.market}
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#f9fafb', marginTop: 2 }}>
                    {c.title}
                  </div>
                  <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>{c.subtitle}</div>
                </div>
                <span style={{
                  fontSize: 10,
                  fontWeight: 700,
                  padding: '3px 8px',
                  borderRadius: 6,
                  color: statusColor(c.kpiStatus),
                  background: statusColor(c.kpiStatus) + '20',
                  border: `1px solid ${statusColor(c.kpiStatus)}40`,
                  whiteSpace: 'nowrap',
                }}>
                  {statusLabel(c.kpiStatus)}
                </span>
              </div>

              <div style={{ padding: 14 }}>
                <div style={{ fontSize: 12, color: '#d1d5db', marginBottom: 10, minHeight: 36, lineHeight: 1.4 }}>
                  {c.activity}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
                  <Mini label="Equity" value={`$${c.equity.toFixed(2)}`} />
                  <Mini label="PnL%" value={`${c.pnlPercent}%`} color={c.pnlPercent >= 0 ? '#10b981' : '#ef4444'} />
                  <Mini label="Pace/mo" value={`${c.paceMonthlyPercent}%`} color={c.paceMonthlyPercent >= c.monthlyTargetLow * 100 ? '#10b981' : '#f59e0b'} />
                  <Mini label="KPI band" value={`+${(c.monthlyTargetLow * 100).toFixed(0)}–${(c.monthlyTargetHigh * 100).toFixed(0)}%`} />
                  <Mini label="Open" value={String(c.openPositions)} />
                  <Mini label="Trades" value={`${c.totalTrades} · WR ${c.winRate.toFixed(0)}%`} />
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <div style={{ fontSize: 10, color: '#6b7280' }}>
                    {c.updatedAt
                      ? `updated ${new Date(c.updatedAt).toLocaleTimeString()}`
                      : c.running
                        ? 'running · no scan yet'
                        : 'not started'}
                  </div>
                  <a
                    href={c.href}
                    style={{
                      padding: '7px 12px',
                      borderRadius: 8,
                      background: c.accent + '22',
                      color: c.accent,
                      fontSize: 11,
                      fontWeight: 700,
                      textDecoration: 'none',
                      border: `1px solid ${c.accent}44`,
                    }}
                  >
                    Open Desk →
                  </a>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{
        marginTop: 24,
        padding: '14px 16px',
        borderRadius: 12,
        border: '1px solid #374151',
        background: 'rgba(59,130,246,0.04)',
        fontSize: 12,
        color: '#9ca3af',
        lineHeight: 1.55,
      }}>
        <strong style={{ color: '#93c5fd' }}>Cara pakai:</strong>{' '}
        Buka desk market (Q Crypto / Q Comm / Q Au/Ag) untuk run backtest, atur param,
        start paper agent, dan lihat watchlist. Halaman ini hanya <em>supervisi</em> —
        equity, KPI pace, open positions, dan activity tiap agent.
        State tiap desk <strong>terisolasi</strong> (modal, param, trade history).
      </div>
    </Layout>
  );
}

function Tile({ label, value, color, hint }: { label: string; value: string | number; color?: string; hint?: string }) {
  return (
    <div style={{ background: '#111827', border: '1px solid #374151', borderRadius: 12, padding: '14px 16px' }}>
      <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.4px' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: color || '#f9fafb', marginTop: 4 }}>{value}</div>
      {hint ? <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>{hint}</div> : null}
    </div>
  );
}

function Mini({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ background: '#0a0e17', borderRadius: 8, padding: '8px 10px' }}>
      <div style={{ fontSize: 10, color: '#6b7280' }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 700, color: color || '#f9fafb', marginTop: 2 }}>{value}</div>
    </div>
  );
}
