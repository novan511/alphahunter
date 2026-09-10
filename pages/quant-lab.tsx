import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Layout from '../components/Layout/Layout';
import { MARKET_PROFILES, MarketId } from '../lib/quant/marketProfiles';
import type { LabRunRow } from '../lib/quant/labEngine';

type LabTab = MarketId;

interface LabHistoryRow {
  id: string;
  created_at: string;
  best_label: string | null;
  best_score: number | null;
  best_metrics: Record<string, number | boolean> | null;
  combo_count: number;
  rows?: LabRunRow[] | null;
  source?: string | null;
}

interface LabHistoryResponse {
  runs: LabHistoryRow[];
  autoIntervalHours?: number;
  lastRunAt?: string | null;
  due?: boolean;
}

const TABS: { id: LabTab; label: string; accent: string }[] = [
  { id: 'crypto', label: 'Part 1 · Crypto', accent: '#3b82f6' },
  { id: 'commodities', label: 'Part 2 · Commodities', accent: '#f59e0b' },
  { id: 'gold-silver', label: 'Part 3 · Gold & Silver', accent: '#eab308' },
];

export default function QuantLabPage() {
  const [tab, setTab] = useState<LabTab>('crypto');
  const [rows, setRows] = useState<LabRunRow[]>([]);
  const [history, setHistory] = useState<LabHistoryRow[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [applyBest, setApplyBest] = useState(true);
  const [appliedNote, setAppliedNote] = useState<string | null>(null);
  const [detail, setDetail] = useState<LabRunRow | null>(null);
  const [autoStatus, setAutoStatus] = useState<{
    lastRunAt: string | null;
    due: boolean;
    hours: number;
  } | null>(null);
  const [autoTriggered, setAutoTriggered] = useState(false);
  const autoRanRef = useRef(false);
  const [boardSource, setBoardSource] = useState<'batch' | 'last_run' | null>(null);
  const [lastRunMeta, setLastRunMeta] = useState<{ at: string; label?: string | null } | null>(null);

  const accent = TABS.find((t) => t.id === tab)?.accent || '#3b82f6';
  const profile = MARKET_PROFILES[tab];

  const ranked = useMemo(() => {
    return [...rows].sort((a, b) => {
      const ac = a.metrics?.compositeScore ?? -999;
      const bc = b.metrics?.compositeScore ?? -999;
      if (bc !== ac) return bc - ac;
      return (b.metrics?.oosPF ?? 0) - (a.metrics?.oosPF ?? 0);
    });
  }, [rows]);

  const loadHistory = useCallback(async (marketId: LabTab) => {
    try {
      const res = await fetch(`/api/quant-lab?action=history&marketId=${marketId}`);
      const data = (await res.json()) as LabHistoryResponse;
      if (!res.ok) return;
      const runs = data.runs || [];
      setHistory(runs);
      setAutoStatus({
        lastRunAt: data.lastRunAt ?? runs[0]?.created_at ?? null,
        due: Boolean(data.due),
        hours: data.autoIntervalHours ?? 6,
      });

      // Always surface latest saved batch on the leaderboard when session has no live run
      const latest = runs[0];
      if (latest?.rows?.length) {
        setRows(latest.rows as LabRunRow[]);
        setBoardSource('last_run');
        setLastRunMeta({ at: latest.created_at, label: latest.best_label });
      } else {
        setRows([]);
        setBoardSource(null);
        setLastRunMeta(latest ? { at: latest.created_at, label: latest.best_label } : null);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    // Do not wipe leaderboard when only switching tabs — loadHistory will replace
    setDetail(null);
    setAppliedNote(null);
    void loadHistory(tab);
  }, [tab, loadHistory]);

  // Auto discovery: if due, hit cron once per page load (no manual Run needed)
  useEffect(() => {
    if (autoRanRef.current) return;
    if (!autoStatus?.due) return;
    autoRanRef.current = true;
    setAutoTriggered(true);
    (async () => {
      try {
        await fetch('/api/quant-lab-cron', { method: 'GET' });
        void loadHistory(tab);
      } catch {
        /* ignore */
      }
    })();
  }, [autoStatus?.due, tab, loadHistory]);

  const runBatch = useCallback(async () => {
    setRunning(true);
    setErr(null);
    setAppliedNote(null);
    setRows([]);
    setDetail(null);
    setProgress({ done: 0, total: 18 });
    try {
      const res = await fetch('/api/quant-lab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'run',
          marketId: tab,
          applyBestToDesk: applyBest,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'lab failed');
      setRows(data.ranked || []);
      setBoardSource('batch');
      setLastRunMeta({ at: new Date().toISOString(), label: data.ranked?.[0]?.label ?? null });
      setProgress({ done: data.ranked?.length || 0, total: data.ranked?.length || 0 });
      if (data.appliedBestToDesk) {
        const top = data.ranked?.find(
          (r: LabRunRow) => r.status === 'done' && r.metrics?.credible
        );
        setAppliedNote(
          top
            ? `Applied best credible combo to ${tab} desk: ${top.label} (score ${top.metrics?.compositeScore})`
            : `No credible combo to auto-apply on ${tab}`
        );
      }
      void loadHistory(tab);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'lab failed');
      setProgress(null);
    } finally {
      setRunning(false);
    }
  }, [tab, applyBest, loadHistory]);

  const applyRow = useCallback(
    async (row: LabRunRow) => {
      try {
        const res = await fetch('/api/quant-lab', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'apply',
            marketId: tab,
            risk: row.risk,
            label: row.label,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'apply failed');
        setAppliedNote(`Applied to ${tab} desk: ${row.label}`);
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'apply failed');
      }
    },
    [tab]
  );

  const best = ranked.find((r) => r.status === 'done' && r.metrics);

  return (
    <Layout>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#8b5cf6', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Discovery Lab
        </div>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: '#f9fafb', margin: '4px 0 0' }}>
          Quant Lab — Parameter Discovery
        </h2>
        <p style={{ fontSize: 12, color: '#9ca3af', margin: '6px 0 0', maxWidth: 720 }}>
          Three separate parts (not merged): run sequential OOS-heavy backtests,
          rank by composite (OOS PF + Sharpe − DD), then push best params to the live desk.
          Anti-overfit: small samples get penalized; only “credible” combos auto-apply.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              padding: '8px 14px',
              borderRadius: 8,
              border: `1px solid ${tab === t.id ? t.accent : '#374151'}`,
              background: tab === t.id ? t.accent + '22' : '#111827',
              color: tab === t.id ? t.accent : '#9ca3af',
              fontWeight: 700,
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div style={{
        background: '#111827',
        border: `1px solid ${accent}44`,
        borderRadius: 12,
        padding: 16,
        marginBottom: 16,
      }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 12, color: '#f9fafb', fontWeight: 700 }}>{profile.title}</div>
            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
              Default preset: {profile.defaultPresetId} · ~18 combos · sequential · walk-forward OOS
              {' · '}
              auto every {autoStatus?.hours ?? 6}h
              {autoStatus?.lastRunAt
                ? ` · last ${new Date(autoStatus.lastRunAt).toLocaleString()}`
                : ' · no saved run yet'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ fontSize: 11, color: '#9ca3af', display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={applyBest} onChange={(e) => setApplyBest(e.target.checked)} />
              Auto-apply best credible → {tab} desk
            </label>
            <button
              onClick={runBatch}
              disabled={running}
              style={{
                padding: '10px 18px',
                border: 'none',
                borderRadius: 8,
                background: running ? '#374151' : `linear-gradient(135deg, ${accent}, #10b981)`,
                color: 'white',
                fontWeight: 700,
                fontSize: 13,
                cursor: running ? 'not-allowed' : 'pointer',
                opacity: running ? 0.7 : 1,
              }}
            >
              {running
                ? `Running ${progress?.done ?? 0}/${progress?.total ?? '…'}…`
                : '▶ Run Discovery Batch'}
            </button>
          </div>
        </div>

        {err && (
          <div style={{ marginTop: 10, color: '#ef4444', fontSize: 12 }}>{err}</div>
        )}
        {appliedNote && (
          <div style={{ marginTop: 10, color: '#10b981', fontSize: 12 }}>{appliedNote}</div>
        )}
        {running && (
          <div style={{ marginTop: 10, fontSize: 11, color: '#6b7280' }}>
            Sequential server-side runs. Candle cache helps after first combo.
          </div>
        )}
      </div>

      {best && best.metrics && (
        <div style={{
          marginBottom: 16,
          padding: 14,
          borderRadius: 12,
          border: `1px solid ${best.metrics.credible ? 'rgba(16,185,129,0.4)' : 'rgba(245,158,11,0.35)'}`,
          background: best.metrics.credible ? 'rgba(16,185,129,0.06)' : 'rgba(245,158,11,0.06)',
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: best.metrics.credible ? '#6ee7b7' : '#fbbf24', textTransform: 'uppercase' }}>
            Best so far {best.metrics.credible ? '· credible' : '· caution (thin sample)'}
          </div>
          <div style={{ fontSize: 13, color: '#f9fafb', marginTop: 4 }}>{best.label}</div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10, marginTop: 12 }}>
            <MoneyTile
              label="Full-sample on $1,000"
              pct={best.metrics.fullPnL}
              capital={1000}
              hint="entire backtest window"
            />
            <MoneyTile
              label="OOS on $1,000"
              pct={best.metrics.oosPnL}
              capital={1000}
              hint="out-of-sample windows only"
              strong
            />
            <div style={{ background: '#0a0e17', borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase' }}>OOS metrics</div>
              <div style={{ fontSize: 12, color: '#d1d5db', marginTop: 4, lineHeight: 1.45 }}>
                PF {best.metrics.oosPF} · Sharpe {best.metrics.oosSharpe}<br />
                MaxDD {best.metrics.oosMaxDD}% ({money(1000 * best.metrics.oosMaxDD / 100)})<br />
                Trades {best.metrics.oosTrades} · Edge {best.metrics.oosPositiveWindows}/{best.metrics.oosWindowsTotal}
              </div>
            </div>
            <div style={{ background: '#0a0e17', borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase' }}>Composite</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: accent, marginTop: 4 }}>
                {best.metrics.compositeScore}
              </div>
              <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>
                OOS-first ranking score
              </div>
            </div>
          </div>

          <div style={{ marginTop: 10, fontSize: 10, color: '#6b7280', lineHeight: 1.45 }}>
            Dollar figures are research projections on paper capital $1,000 using the backtest PnL% —
            not guaranteed live returns. Fees/slippage already included in the engine when configured.
          </div>
        </div>
      )}

      <div style={{
        background: '#111827',
        border: '1px solid #374151',
        borderRadius: 12,
        overflow: 'hidden',
        marginBottom: 16,
      }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #374151' }}>
          <h3 style={{ fontSize: 14, color: '#f9fafb', margin: 0 }}>
            {boardSource === 'last_run'
              ? 'Leaderboard (latest saved batch)'
              : boardSource === 'batch'
                ? 'Leaderboard (this run)'
                : 'Leaderboard'}
          </h3>
          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
            Ranked by OOS-first composite. Not a live signal.
            {lastRunMeta?.at
              ? ` · loaded ${new Date(lastRunMeta.at).toLocaleString()}`
              : ''}
          </div>
        </div>
        {ranked.length === 0 ? (
          <div style={{ padding: 24, color: '#6b7280', fontSize: 12 }}>
            {running
              ? 'Batch running…'
              : 'No saved batch yet. Run Discovery once, or wait for auto-cron — results will show here next time.'}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #374151' }}>
                  {['#', 'Combo', 'Score', 'OOS PF', 'OOS Shp', 'OOS DD%', 'PnL $1k', 'Period', 'OOS trades', 'Credible', ''].map((h) => (
                    <th key={h} style={{ padding: '10px 10px', textAlign: 'left', fontSize: 9, color: '#6b7280', textTransform: 'uppercase', fontWeight: 700 }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ranked.map((r, i) => {
                  const oosUsd = r.metrics?.oosPnLUsd;
                  const oosPct = r.metrics?.oosPnL;
                  const days = r.metrics?.periodDays;
                  const start = r.metrics?.periodStart;
                  const end = r.metrics?.periodEnd;
                  const periodLabel = days
                    ? `${days}d${start && end ? ` (${fmtDate(start)}→${fmtDate(end)})` : ''}`
                    : '—';
                  return (
                  <tr
                    key={r.comboId}
                    style={{ borderBottom: '1px solid #1f2937', cursor: 'pointer' }}
                    onClick={() => setDetail(r)}
                  >
                    <td style={{ padding: '10px', color: '#d1d5db' }}>{i + 1}</td>
                    <td style={{ padding: '10px', color: '#f9fafb', maxWidth: 260 }}>{r.label}</td>
                    <td style={{ padding: '10px', color: accent, fontWeight: 700 }}>
                      {r.metrics?.compositeScore ?? '—'}
                    </td>
                    <td style={{ padding: '10px', color: (r.metrics?.oosPF ?? 0) >= 1 ? '#10b981' : '#ef4444' }}>
                      {r.metrics?.oosPF ?? '—'}
                    </td>
                    <td style={{ padding: '10px', color: '#d1d5db' }}>{r.metrics?.oosSharpe ?? '—'}</td>
                    <td style={{ padding: '10px', color: '#d1d5db' }}>{r.metrics?.oosMaxDD ?? '—'}</td>
                    <td style={{
                      padding: '10px',
                      color: (oosUsd ?? 0) >= 0 ? '#10b981' : '#ef4444',
                      fontWeight: 700,
                      whiteSpace: 'nowrap',
                    }}>
                      {oosUsd != null
                        ? `${oosUsd >= 0 ? '+' : ''}${oosUsd.toFixed(2)} (${oosPct != null ? `${oosPct >= 0 ? '+' : ''}${oosPct.toFixed(1)}%` : ''})`
                        : '—'}
                    </td>
                    <td style={{ padding: '10px', color: '#9ca3af', whiteSpace: 'nowrap', fontSize: 10 }}>
                      {periodLabel}
                    </td>
                    <td style={{ padding: '10px', color: '#d1d5db' }}>{r.metrics?.oosTrades ?? '—'}</td>
                    <td style={{ padding: '10px', color: r.metrics?.credible ? '#10b981' : '#f59e0b' }}>
                      {r.metrics?.credible ? 'yes' : 'thin'}
                    </td>
                    <td style={{ padding: '10px' }}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void applyRow(r);
                        }}
                        disabled={r.status !== 'done'}
                        style={{
                          padding: '4px 8px',
                          borderRadius: 6,
                          border: '1px solid #374151',
                          background: '#1f2937',
                          color: '#93c5fd',
                          fontSize: 10,
                          cursor: r.status === 'done' ? 'pointer' : 'not-allowed',
                        }}
                      >
                        Apply → desk
                      </button>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {detail?.metrics && (
        <div style={{
          background: '#111827',
          border: '1px solid #374151',
          borderRadius: 12,
          padding: 14,
          marginBottom: 16,
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#f9fafb', marginBottom: 8 }}>
            Detail · {detail.label}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px,1fr))', gap: 8, fontSize: 11, color: '#9ca3af' }}>
            <div>Full PF {detail.metrics.fullPF}</div>
            <div>Full PnL% {detail.metrics.fullPnL}</div>
            <div>Full trades {detail.metrics.fullTrades}</div>
            <div>OOS PF {detail.metrics.oosPF}</div>
            <div>OOS Sharpe {detail.metrics.oosSharpe}</div>
            <div>OOS DD% {detail.metrics.oosMaxDD}</div>
            <div>OOS PnL% {detail.metrics.oosPnL}</div>
            <div>OOS ExpR {detail.metrics.oosExpectancyR}</div>
            <div>Edge windows {detail.metrics.oosPositiveWindows}/{detail.metrics.oosWindowsTotal}</div>
            <div>Composite {detail.metrics.compositeScore}</div>
          </div>
          <pre style={{ marginTop: 10, fontSize: 10, color: '#6b7280', whiteSpace: 'pre-wrap' }}>
            {JSON.stringify(detail.risk, null, 2)}
          </pre>
        </div>
      )}

      <div style={{
        background: '#111827',
        border: '1px solid #374151',
        borderRadius: 12,
        overflow: 'hidden',
      }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #374151' }}>
          <h3 style={{ fontSize: 14, color: '#f9fafb', margin: 0 }}>Lab history (Supabase)</h3>
        </div>
        {history.length === 0 ? (
          <div style={{ padding: 16, fontSize: 12, color: '#6b7280' }}>
            No saved runs yet (run migration 005 if table missing).
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #374151' }}>
                  {['When', 'Combos', 'Best score', 'Best label'].map((h) => (
                    <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontSize: 9, color: '#6b7280', textTransform: 'uppercase', fontWeight: 700 }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id} style={{ borderBottom: '1px solid #1f2937' }}>
                    <td style={{ padding: '10px 12px', color: '#d1d5db' }}>
                      {new Date(h.created_at).toLocaleString()}
                    </td>
                    <td style={{ padding: '10px 12px', color: '#d1d5db' }}>{h.combo_count}</td>
                    <td style={{ padding: '10px 12px', color: accent, fontWeight: 700 }}>
                      {h.best_score ?? '—'}
                    </td>
                    <td style={{ padding: '10px 12px', color: '#9ca3af', maxWidth: 320 }}>
                      {h.best_label || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={{ marginTop: 16, fontSize: 11, color: '#6b7280', lineHeight: 1.5 }}>
        Research only. Composite favors consistent OOS (PF + Sharpe − DD) aligned with KPI,
        not max full-sample PF. Auto-apply only when combo is <em>credible</em> (enough OOS trades + majority positive windows).
        Live desks still run their own paper agents independently.
      </div>
    </Layout>
  );
}

function money(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function fmtDate(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function MoneyTile({
  label,
  pct,
  capital,
  hint,
  strong,
}: {
  label: string;
  pct: number;
  capital: number;
  hint?: string;
  strong?: boolean;
}) {
  const pnl = (capital * pct) / 100;
  const end = capital + pnl;
  const up = pnl >= 0;
  return (
    <div style={{
      background: '#0a0e17',
      borderRadius: 8,
      padding: '10px 12px',
      border: strong ? '1px solid rgba(16,185,129,0.25)' : undefined,
    }}>
      <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase' }}>{label}</div>
      <div style={{
        fontSize: 16,
        fontWeight: 700,
        color: up ? '#10b981' : '#ef4444',
        marginTop: 4,
      }}>
        {up ? '+' : ''}{pnl.toFixed(2)} USD
      </div>
      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
        {pct >= 0 ? '+' : ''}{pct.toFixed(2)}% → {money(end)}
      </div>
      {hint ? <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>{hint}</div> : null}
    </div>
  );
}
