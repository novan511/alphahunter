import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { QuantRiskConfig } from '../../lib/quant/types';

interface PresetOption {
  id: string;
  name: string;
  description: string;
  preferredInterval: string;
  assets: { id: string; label: string; source: string; klass: string }[];
}

interface PaperPosition {
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  qty: number;
  stopLoss: number;
  takeProfit: number;
  barsHeld: number;
  signalStrength: number;
  reason: string;
  markPrice?: number;
  unrealizedPnl?: number;
  unrealizedPnlPct?: number;
}

interface PaperWatchRow {
  symbol: string;
  price: number;
  changePct: number;
  volumeRatio: number | null;
  lastSignal: 'buy' | 'sell' | null;
  lastSignalStrength: number | null;
  openPosition: 'long' | 'short' | null;
  note: string;
}

interface PaperTrade {
  symbol: string;
  side: string;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  pnlPercent: number;
  exitReason: string;
  exitTime: number;
}

interface PaperStateView {
  running: boolean;
  startedAt: number | null;
  updatedAt: number | null;
  activity?: string;
  watchlist?: PaperWatchRow[];
  cash: number;
  equity?: number;
  peakEquity: number;
  halted: boolean;
  positions: PaperPosition[];
  trades: PaperTrade[];
  log: string[];
  stats: {
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    totalPnL: number;
    totalPnLPercent: number;
  };
  risk: QuantRiskConfig;
  universe: string[];
  openCount?: number;
  totalUnrealizedPnl?: number;
  lastPrices?: Record<string, number>;
}

interface PaperApiResponse {
  ok: boolean;
  running: boolean;
  state: PaperStateView | null;
  note?: string;
  kpi?: AgentKpiView;
  tune?: { reason: string; changed: boolean };
}

interface AgentKpiView {
  capitalStart: number;
  equity: number;
  pnlPercent: number;
  monthlyTargetLow: number;
  monthlyTargetHigh: number;
  daysElapsed: number;
  paceMonthlyPercent: number;
  status: string;
  openPositions: number;
  totalTrades: number;
  winRate: number;
}

interface HistoryTradeRow {
  id: string;
  exit_time: string;
  symbol: string;
  side: string;
  entry_price: number;
  exit_price: number;
  pnl: number;
  pnl_percent: number;
  exit_reason: string;
  signal_reason: string;
}

interface HistoryParamRow {
  id: string;
  created_at: string;
  reason: string;
}

const card: React.CSSProperties = {
  background: '#111827',
  border: '1px solid #374151',
  borderRadius: '12px',
  padding: '16px',
};

const btn: React.CSSProperties = {
  padding: '8px 14px',
  border: 'none',
  borderRadius: '8px',
  fontWeight: 700,
  fontSize: '12px',
  cursor: 'pointer',
  color: 'white',
};

function profileAccent(agentId: string): string {
  if (agentId === 'crypto') return '#3b82f6';
  if (agentId === 'commodities') return '#f59e0b';
  if (agentId === 'gold-silver') return '#eab308';
  return '#93c5fd';
}

export default function PaperTradingAgent({
  risk,
  presetId: presetIdProp,
  customSymbols: customSymbolsProp,
  agentId = 'default',
}: {
  risk: QuantRiskConfig;
  presetId: string;
  customSymbols: string;
  agentId?: string;
}) {
  const [state, setState] = useState<PaperStateView | null>(null);
  const [kpi, setKpi] = useState<AgentKpiView | null>(null);
  const [history, setHistory] = useState<HistoryTradeRow[]>([]);
  const [paramHistory, setParamHistory] = useState<HistoryParamRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [presets, setPresets] = useState<PresetOption[]>([]);
  const [paperPresetId, setPaperPresetId] = useState(
    presetIdProp === 'binance-top' && agentId !== 'crypto' && agentId !== 'default'
      ? presetIdProp
      : presetIdProp
  );
  const [paperSymbols, setPaperSymbols] = useState(customSymbolsProp || '');
  const [allowShort, setAllowShort] = useState(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/quant-presets');
        const data = await res.json();
        if (res.ok && data.presets) setPresets(data.presets);
      } catch {
        /* ignore */
      }
    })();
  }, []);

  useEffect(() => {
    setPaperPresetId(presetIdProp);
    setPaperSymbols(customSymbolsProp || '');
  }, [presetIdProp, customSymbolsProp, agentId]);

  const selectedPreset = presets.find((p) => p.id === paperPresetId);
  const effectiveInterval = paperSymbols.trim()
    ? risk.interval
    : selectedPreset?.preferredInterval || risk.interval;

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch(`/api/paper?action=history&agentId=${encodeURIComponent(agentId)}`);
      const data = await res.json();
      if (res.ok) {
        setHistory(data.trades || []);
        setParamHistory(data.params || []);
      }
    } catch {
      /* ignore */
    }
  }, [agentId]);

  const api = useCallback(async (action: string, body?: Record<string, unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/paper', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          agentId,
          presetId: paperPresetId,
          symbols: paperSymbols.trim() || undefined,
          allowShort,
          interval: effectiveInterval,
          initialCapital: kpi?.capitalStart || 1000,
          riskPerTrade: risk.riskPerTrade,
          stopLossATR: risk.stopLossATR,
          takeProfitATR: risk.takeProfitATR,
          maxHoldBars: risk.maxHoldBars,
          feeRate: risk.feeRate,
          slippage: risk.slippage,
          maxConcurrentPositions: risk.maxConcurrentPositions,
          maxExposurePct: risk.maxExposurePct,
          maxPortfolioDrawdownPct: risk.maxPortfolioDrawdownPct,
          minSignalStrength: risk.minSignalStrength,
          ...body,
        }),
      });
      const data = (await res.json()) as PaperApiResponse;
      if (!res.ok) throw new Error((data as unknown as { error?: string })?.error || 'paper failed');
      setState(data.state);
      if (data.kpi) setKpi(data.kpi);
      else if (data.state && 'kpi' in data.state) {
        setKpi((data.state as unknown as { kpi?: AgentKpiView }).kpi || null);
      }
      if (action === 'step' || action === 'start') void loadHistory();
      return data;
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'paper failed');
      return null;
    } finally {
      setBusy(false);
    }
  }, [risk, paperPresetId, paperSymbols, allowShort, effectiveInterval, loadHistory, agentId]);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/paper?action=status&agentId=${encodeURIComponent(agentId)}`);
    const data = (await res.json()) as PaperApiResponse;
    setState(data.state);
    if (data.kpi) setKpi(data.kpi);
    void loadHistory();
  }, [loadHistory, agentId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (state?.running) {
      timerRef.current = setInterval(() => {
        void api('step');
      }, 45_000);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [state?.running, api, agentId]);

  // reload when switching market pages
  useEffect(() => {
    setState(null);
    setKpi(null);
    setHistory([]);
    setParamHistory([]);
    void refresh();
  }, [agentId, refresh]);

  const running = Boolean(state?.running);
  const equity = state?.equity ?? state?.cash ?? 0;
  const pnlPct = state?.stats?.totalPnLPercent ?? 0;

  return (
    <div style={{ ...card, marginTop: '24px' }} className="qm-page">
      <div className="qm-actions" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h3 style={{ margin: 0, fontSize: '15px', color: '#f9fafb' }}>
            Autonomous Paper Agent
          </h3>
          <p style={{ margin: '4px 0 0', fontSize: '11px', color: '#9ca3af' }}>
            Modal paper <strong style={{ color: '#93c5fd' }}>${(kpi?.capitalStart ?? 1000).toLocaleString()}</strong>{' '}
            · agent <strong style={{ color: profileAccent(agentId) }}>{agentId}</strong> ·
            state terisolasi per halaman · history → Supabase. <strong style={{ color: '#fbbf24' }}>PAPER ONLY.</strong>
          </p>
        </div>
        <div className="qm-actions" style={{ flexWrap: 'wrap' }}>
          {!running ? (
            <button
              disabled={busy}
              style={{ ...btn, background: busy ? '#374151' : 'linear-gradient(135deg,#10b981,#3b82f6)' }}
              onClick={() => void api('start')}
            >
              ▶ Start Agent
            </button>
          ) : (
            <button
              disabled={busy}
              style={{ ...btn, background: busy ? '#374151' : '#ef4444' }}
              onClick={() => void api('stop')}
            >
              ■ Stop
            </button>
          )}
          <button
            disabled={busy || !running}
            style={{ ...btn, background: busy ? '#374151' : '#374151' }}
            onClick={() => void api('step')}
          >
            ⚡ Step Now
          </button>
          <button
            disabled={busy}
            style={{ ...btn, background: '#1f2937', border: '1px solid #374151' }}
            onClick={() => void api('reset')}
          >
            Reset
          </button>
        </div>
      </div>

      {/* Universe picker — crypto / commodities / multi */}
      <div className="qm-grid-universe" style={{ marginBottom: 14, padding: '12px 14px', borderRadius: 8, border: '1px solid #374151', background: '#0a0e17' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '12px' }}>
          <div>
            <div style={{ fontSize: '11px', color: '#9ca3af', marginBottom: '4px', fontWeight: 600 }}>
              Paper Universe
            </div>
            <select
              value={paperPresetId}
              onChange={(e) => {
                setPaperPresetId(e.target.value);
                setPaperSymbols('');
              }}
              style={{
                width: '100%',
                padding: '8px 10px',
                background: '#1f2937',
                border: '1px solid #374151',
                borderRadius: '6px',
                color: '#f9fafb',
                fontSize: '13px',
              }}
            >
              {(presets.length ? presets : [{ id: 'paper-cross-asset', name: 'Paper Cross-Asset', description: '', preferredInterval: '1d', assets: [] }]).map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            {selectedPreset ? (
              <div style={{ fontSize: '10px', color: '#6b7280', marginTop: '6px' }}>
                {selectedPreset.description}
                <div style={{ marginTop: '4px', color: '#9ca3af' }}>
                  {selectedPreset.assets.map((a) => a.label).join(' · ')}
                </div>
              </div>
            ) : null}
          </div>
          <div>
            <div style={{ fontSize: '11px', color: '#9ca3af', marginBottom: '4px', fontWeight: 600 }}>
              Custom symbols (opsional)
            </div>
            <input
              value={paperSymbols}
              onChange={(e) => setPaperSymbols(e.target.value)}
              placeholder="yahoo:GC=F,binance:ETHUSDT,hyperliquid:HYPE"
              style={{
                width: '100%',
                padding: '8px 10px',
                background: '#1f2937',
                border: '1px solid #374151',
                borderRadius: '6px',
                color: '#f9fafb',
                fontSize: '12px',
              }}
            />
          </div>
          <div>
            <div style={{ fontSize: '11px', color: '#9ca3af', marginBottom: '4px', fontWeight: 600 }}>
              Sides
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: '#d1d5db', marginTop: '18px' }}>
              <input
                type="checkbox"
                checked={allowShort}
                onChange={(e) => setAllowShort(e.target.checked)}
              />
              Allow short (long/short agent)
            </label>
            <div style={{ fontSize: '10px', color: '#6b7280', marginTop: '6px' }}>
              Interval otomatis: {effectiveInterval}
            </div>
          </div>
        </div>
      </div>

      {err && (
        <div style={{ color: '#ef4444', fontSize: '12px', marginBottom: '10px' }}>{err}</div>
      )}

      {/* LIVE STATUS */}
      <div style={{
        marginBottom: '14px',
        padding: '12px 14px',
        borderRadius: '8px',
        border: '1px solid rgba(16, 185, 129, 0.25)',
        background: 'rgba(16, 185, 129, 0.04)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '8px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: '#6ee7b7', textTransform: 'uppercase' }}>
            Live Agent Status
          </div>
          <div style={{ fontSize: '11px', color: '#6b7280' }}>
            {state?.updatedAt
              ? `last update ${new Date(state.updatedAt).toLocaleTimeString()}`
              : 'no update yet'}
            {running ? ' · watching live chart data' : ''}
          </div>
        </div>
        <div style={{ fontSize: '13px', color: '#f9fafb', marginBottom: '10px', lineHeight: 1.45 }}>
          <span style={{ color: '#6b7280', fontSize: '11px', textTransform: 'uppercase', marginRight: 8 }}>
            Now
          </span>
          {state?.activity || (running ? 'Waiting for first market scan…' : 'Agent not running')}
        </div>
        <div style={{ fontSize: '11px', color: '#9ca3af' }}>
          Universe: {(state?.universe || []).map((u) => u.replace(/^.*:/, '')).join(' · ') || '—'}
        </div>
      </div>

      {kpi && (
        <div style={{
          marginBottom: '14px',
          padding: '12px 14px',
          borderRadius: '8px',
          border: `1px solid ${kpi.status === 'ahead' || kpi.status === 'on_track' ? 'rgba(16,185,129,0.35)' : kpi.status === 'critical' || kpi.status === 'behind' ? 'rgba(239,68,68,0.35)' : 'rgba(59,130,246,0.3)'}`,
          background: 'rgba(59,130,246,0.05)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '8px' }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: '#93c5fd', textTransform: 'uppercase' }}>
              OKR / KPI · {kpi.status.replace('_', ' ')}
            </div>
            <div style={{ fontSize: '11px', color: '#9ca3af' }}>
              Target monthly +{(kpi.monthlyTargetLow * 100).toFixed(0)}% … +{(kpi.monthlyTargetHigh * 100).toFixed(0)}% on ${kpi.capitalStart}
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px,1fr))', gap: '8px' }}>
            <KpiMini label="Equity" value={`$${kpi.equity.toFixed(2)}`} />
            <KpiMini label="PnL%" value={`${kpi.pnlPercent}%`} color={kpi.pnlPercent >= 0 ? '#10b981' : '#ef4444'} />
            <KpiMini label="Pace /mo" value={`${kpi.paceMonthlyPercent}%`} color={kpi.paceMonthlyPercent >= 10 ? '#10b981' : kpi.paceMonthlyPercent < 0 ? '#ef4444' : '#f59e0b'} />
            <KpiMini label="Days" value={String(kpi.daysElapsed)} />
            <KpiMini label="Trades" value={String(kpi.totalTrades)} />
            <KpiMini label="Win%" value={`${kpi.winRate}%`} />
          </div>
        </div>
      )}

      <div className="qm-grid-metrics" style={{ marginBottom: 14 }}>
        <Stat label="Status" value={running ? (state?.halted ? 'DD HALTED' : 'RUNNING') : 'STOPPED'} color={running ? (state?.halted ? '#ef4444' : '#10b981') : '#6b7280'} />
        <Stat label="Equity ($)" value={equity.toFixed(2)} />
        <Stat label="Cash ($)" value={(state?.cash ?? 0).toFixed(2)} />
        <Stat label="Open" value={state?.openCount ?? state?.positions?.length ?? 0} />
        <Stat label="PnL%" value={`${pnlPct}%`} color={pnlPct >= 0 ? '#10b981' : '#ef4444'} />
        <Stat label="Trades" value={state?.stats?.totalTrades ?? 0} />
        <Stat label="Win%" value={`${(state?.stats?.winRate ?? 0).toFixed(1)}%`} />
        <Stat label="Interval" value={state?.risk?.interval ?? risk.interval} />
      </div>

      {(state?.watchlist?.length ?? 0) > 0 && (
        <div style={{ marginBottom: '14px' }}>
          <div style={{ fontSize: '11px', color: '#6b7280', fontWeight: 700, textTransform: 'uppercase', marginBottom: '6px' }}>
            Market Watchlist (live scan)
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #374151' }}>
                  <th style={th}>Asset</th>
                  <th style={th}>Price</th>
                  <th style={th}>Δ%</th>
                  <th style={th}>Vol×</th>
                  <th style={th}>Signal</th>
                  <th style={th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {state?.watchlist?.slice(0, 12).map((w) => (
                  <tr
                    key={w.symbol}
                    style={{
                      borderBottom: '1px solid #1f2937',
                      background: w.openPosition ? 'rgba(59,130,246,0.08)' : 'transparent',
                    }}
                  >
                    <td style={{ ...td, fontWeight: 600, color: '#f9fafb' }}>
                      {w.symbol.replace(/^.*:/, '')}
                    </td>
                    <td style={td}>{w.price.toFixed(4)}</td>
                    <td style={{ ...td, color: w.changePct >= 0 ? '#10b981' : '#ef4444' }}>
                      {w.changePct >= 0 ? '+' : ''}{w.changePct}%
                    </td>
                    <td style={td}>{w.volumeRatio != null ? `${w.volumeRatio}x` : '—'}</td>
                    <td style={{
                      ...td,
                      color: w.lastSignal === 'buy' ? '#10b981' : w.lastSignal === 'sell' ? '#ef4444' : '#6b7280',
                    }}>
                      {w.lastSignal
                        ? `${w.lastSignal.toUpperCase()}${w.lastSignalStrength != null ? ` ${w.lastSignalStrength.toFixed(1)}` : ''}`
                        : '—'}
                    </td>
                    <td style={{ ...td, color: w.openPosition ? '#93c5fd' : '#9ca3af' }}>{w.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="qm-two-col">
        <div>
          <div style={{ fontSize: '11px', color: '#6b7280', fontWeight: 700, textTransform: 'uppercase', marginBottom: '6px', display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <span>Open Positions ({state?.positions?.length ?? 0})</span>
            {(state?.totalUnrealizedPnl ?? 0) !== 0 && (
              <span style={{
                color: (state?.totalUnrealizedPnl ?? 0) >= 0 ? '#10b981' : '#ef4444',
                fontWeight: 700,
              }}>
                Running PnL: {(state?.totalUnrealizedPnl ?? 0) >= 0 ? '+' : ''}
                {(state?.totalUnrealizedPnl ?? 0).toFixed(2)} USD
              </span>
            )}
          </div>
          {(state?.positions?.length ?? 0) === 0 ? (
            <div style={{ fontSize: '12px', color: '#6b7280' }}>No open paper positions.</div>
          ) : (
            <div className="qm-table-wrap">
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #374151' }}>
                  <th style={th}>Asset</th>
                  <th style={th}>Side</th>
                  <th style={th}>Entry</th>
                  <th style={th}>Mark</th>
                  <th style={th}>uPnL</th>
                  <th style={th}>SL</th>
                  <th style={th}>TP</th>
                  <th style={th}>Bars</th>
                </tr>
              </thead>
              <tbody>
                {state?.positions?.map((p) => {
                  const u = p.unrealizedPnl ?? 0;
                  const up = p.unrealizedPnlPct ?? 0;
                  return (
                    <tr key={p.symbol + p.entryPrice} style={{ borderBottom: '1px solid #1f2937' }}>
                      <td style={{ ...td, fontWeight: 600, color: '#f9fafb' }}>
                        {p.symbol.replace(/^.*:/, '')}
                      </td>
                      <td style={{ ...td, color: p.side === 'long' ? '#10b981' : '#ef4444' }}>
                        {p.side.toUpperCase()}
                      </td>
                      <td style={td}>{p.entryPrice.toFixed(4)}</td>
                      <td style={td}>{(p.markPrice ?? p.entryPrice).toFixed(4)}</td>
                      <td style={{ ...td, color: u >= 0 ? '#10b981' : '#ef4444', fontWeight: 700 }}>
                        {u >= 0 ? '+' : ''}{u.toFixed(2)} ({up >= 0 ? '+' : ''}{up.toFixed(2)}%)
                      </td>
                      <td style={td}>{p.stopLoss.toFixed(4)}</td>
                      <td style={td}>{p.takeProfit.toFixed(4)}</td>
                      <td style={td}>{p.barsHeld}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          )}
        </div>

        <div>
          <div style={{ fontSize: '11px', color: '#6b7280', fontWeight: 700, textTransform: 'uppercase', marginBottom: '6px' }}>
            Recent Paper Trades
          </div>
          {(state?.trades?.length ?? 0) === 0 ? (
            <div style={{ fontSize: '12px', color: '#6b7280' }}>No closed trades yet.</div>
          ) : (
            <div className="qm-table-wrap">
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #374151' }}>
                  <th style={th}>Asset</th>
                  <th style={th}>Side</th>
                  <th style={th}>PnL</th>
                  <th style={th}>Exit</th>
                </tr>
              </thead>
              <tbody>
                {state?.trades?.slice(0, 8).map((t, i) => (
                  <tr key={`${t.symbol}-${t.exitTime}-${i}`} style={{ borderBottom: '1px solid #1f2937' }}>
                    <td style={td}>{t.symbol.replace(/^.*:/, '')}</td>
                    <td style={{ ...td, color: t.side === 'long' ? '#10b981' : '#ef4444' }}>
                      {t.side}
                    </td>
                    <td style={{ ...td, color: t.pnl >= 0 ? '#10b981' : '#ef4444' }}>
                      {t.pnl.toFixed(2)} ({t.pnlPercent.toFixed(2)}%)
                    </td>
                    <td style={td}>{t.exitReason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </div>
      </div>

      <div style={{ marginTop: '12px' }}>
        <div style={{ fontSize: '11px', color: '#6b7280', fontWeight: 700, textTransform: 'uppercase', marginBottom: '6px' }}>
          Agent Log
        </div>
        <div style={{
          background: '#0a0e17',
          borderRadius: '8px',
          padding: '10px 12px',
          maxHeight: 160,
          overflow: 'auto',
          fontFamily: 'ui-monospace, monospace',
          fontSize: '11px',
          color: '#9ca3af',
          lineHeight: 1.5,
        }}>
          {(state?.log ?? ['(empty)']).map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      </div>

      <div style={{ marginTop: '16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
          <div style={{ fontSize: '11px', color: '#6b7280', fontWeight: 700, textTransform: 'uppercase' }}>
            Trade History (Supabase)
          </div>
          <button
            onClick={() => void loadHistory()}
            style={{ background: 'none', border: 'none', color: '#3b82f6', fontSize: '11px', cursor: 'pointer' }}
          >
            refresh
          </button>
        </div>
        {history.length === 0 ? (
          <div style={{ fontSize: '12px', color: '#6b7280' }}>
            Belum ada closed trade tersimpan. Jalankan SQL migration 004 dulu, lalu Start/Step agent.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #374151' }}>
                  <th style={th}>Exit</th>
                  <th style={th}>Symbol</th>
                  <th style={th}>Side</th>
                  <th style={th}>Entry</th>
                  <th style={th}>Exit Px</th>
                  <th style={th}>PnL</th>
                  <th style={th}>Reason</th>
                </tr>
              </thead>
              <tbody>
                {history.slice(0, 15).map((t) => (
                  <tr key={t.id} style={{ borderBottom: '1px solid #1f2937' }}>
                    <td style={td}>{new Date(t.exit_time).toLocaleString()}</td>
                    <td style={td}>{String(t.symbol).replace(/^.*:/, '')}</td>
                    <td style={{ ...td, color: t.side === 'long' ? '#10b981' : '#ef4444' }}>{t.side}</td>
                    <td style={td}>{Number(t.entry_price).toFixed(4)}</td>
                    <td style={td}>{Number(t.exit_price).toFixed(4)}</td>
                    <td style={{ ...td, color: t.pnl >= 0 ? '#10b981' : '#ef4444' }}>
                      {Number(t.pnl).toFixed(2)} ({Number(t.pnl_percent).toFixed(2)}%)
                    </td>
                    <td style={td}>{t.exit_reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {paramHistory.length > 0 && (
        <div style={{ marginTop: '12px' }}>
          <div style={{ fontSize: '11px', color: '#6b7280', fontWeight: 700, textTransform: 'uppercase', marginBottom: '6px' }}>
            Auto-Tune Log (Supabase)
          </div>
          <div style={{ fontSize: '11px', color: '#9ca3af' }}>
            {paramHistory.slice(0, 5).map((p) => (
              <div key={p.id} style={{ marginBottom: 4 }}>
                {new Date(p.created_at).toLocaleTimeString()} — {p.reason}
              </div>
            ))}
          </div>
        </div>
      )}

      {running && (
        <div style={{ marginTop: '10px', fontSize: '11px', color: '#6b7280' }}>
          Agent polls ~45s, auto-tunes risk toward KPI, persists trades to Supabase. Paper only.
        </div>
      )}
    </div>
  );
}

function KpiMini({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ background: '#0a0e17', borderRadius: '6px', padding: '8px 10px' }}>
      <div style={{ fontSize: '10px', color: '#6b7280' }}>{label}</div>
      <div style={{ fontSize: '14px', fontWeight: 700, color: color || '#f9fafb' }}>{value}</div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div style={{ background: '#0a0e17', borderRadius: '8px', padding: '10px 12px' }}>
      <div style={{ fontSize: '10px', color: '#6b7280', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: '16px', fontWeight: 700, color: color || '#f9fafb', marginTop: 2 }}>{value}</div>
    </div>
  );
}

const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '6px 4px',
  fontSize: '9px',
  color: '#6b7280',
  fontWeight: 700,
  textTransform: 'uppercase',
};

const td: React.CSSProperties = {
  padding: '6px 4px',
  color: '#d1d5db',
};
