import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Layout from '../Layout/Layout';
import { QuantRunResult, QuantRiskConfig } from '../../lib/quant/types';
import type { RiskReviewResult } from '../../lib/quant/llmMonitor';
import {
  MarketId,
  getMarketProfile,
  adaptRiskToObservedVol,
  medianAtrPctFromCandles,
} from '../../lib/quant/marketProfiles';
import PaperTradingAgent from './PaperTradingAgent';

interface PresetSummary {
  id: string;
  name: string;
  description: string;
  preferredInterval: string;
  benchmarkId: string | null;
  assets: { id: string; label: string; source: string; klass: string }[];
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  background: '#1f2937',
  border: '1px solid #374151',
  borderRadius: '6px',
  color: '#f9fafb',
  fontSize: '13px',
  outline: 'none',
};

function MetricCard({
  label,
  value,
  color,
  hint,
}: {
  label: string;
  value: string | number;
  color?: string;
  hint?: string;
}) {
  return (
    <div style={{ background: '#111827', border: '1px solid #374151', borderRadius: '12px', padding: '14px 16px' }}>
      <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
        {label}
      </div>
      <div style={{ fontSize: '22px', fontWeight: 700, color: color || '#f9fafb' }}>{value}</div>
      {hint ? <div style={{ fontSize: '10px', color: '#6b7280', marginTop: '4px' }}>{hint}</div> : null}
    </div>
  );
}

export default function QuantMarketPage({ marketId }: { marketId: MarketId }) {
  const profile = useMemo(() => getMarketProfile(marketId), [marketId]);
  const [risk, setRisk] = useState<QuantRiskConfig>({ ...profile.baseRisk });
  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [presetId, setPresetId] = useState(profile.defaultPresetId);
  const [customSymbols, setCustomSymbols] = useState('');
  const [result, setResult] = useState<(QuantRunResult & { errors?: string[]; benchmark?: string | null }) | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<RiskReviewResult | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [volNote, setVolNote] = useState<string | null>(null);

  useEffect(() => {
    setRisk({ ...profile.baseRisk });
    setPresetId(profile.defaultPresetId);
    setResult(null);
    setReview(null);
    setVolNote(null);
  }, [profile]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/quant-presets');
        const data = await res.json();
        if (res.ok && data.presets) {
          setPresets((data.presets as PresetSummary[]).filter((p) => profile.allowedPresetIds.includes(p.id)));
        }
      } catch {
        /* ignore */
      }
    })();
  }, [profile]);

  const availablePresets = useMemo(() => {
    const filtered = presets.filter((p) => profile.allowedPresetIds.includes(p.id));
    return filtered.length ? filtered : presets;
  }, [presets, profile]);

  useEffect(() => {
    const p = availablePresets.find((x) => x.id === presetId);
    if (p?.preferredInterval) {
      setRisk((prev) => ({ ...prev, interval: p.preferredInterval }));
    }
  }, [presetId, availablePresets]);

  const update = (key: keyof QuantRiskConfig, value: string | boolean) => {
    setRisk((prev) => {
      if (typeof value === 'boolean') return { ...prev, [key]: value };
      if (key === 'interval' || key === 'allowShort') return { ...prev, [key]: value as string };
      const n = parseFloat(value);
      return { ...prev, [key]: Number.isFinite(n) ? n : (prev[key] as number) };
    });
  };

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    setVolNote(null);
    try {
      let effectiveRisk = { ...risk };

      // Auto-adapt params from live benchmark ATR before backtest when possible
      try {
        const probe = await fetch(
          `/api/quant?preset=${encodeURIComponent(presetId)}&interval=${risk.interval}&limit=120&walkForward=false&symbols=${encodeURIComponent(customSymbols)}`
        );
        // probe is heavy; skip full adapt if too slow — use lightweight klines instead
        void probe;
      } catch {
        /* ignore */
      }

      try {
        const bench =
          marketId === 'crypto'
            ? 'BTCUSDT'
            : marketId === 'gold-silver'
              ? 'GC=F'
              : 'CL=F';
        const klRes = await fetch(
          `/api/idx-klines?symbol=${encodeURIComponent(bench)}&interval=1d`
        ).catch(() => null);
        // crypto uses /api/klines
        const cryptoRes =
          marketId === 'crypto'
            ? await fetch(`/api/klines?symbol=BTCUSDT&interval=1d&limit=90`)
            : null;
        const candles: { open: number; high: number; low: number; close: number }[] | null = cryptoRes
          ? await cryptoRes.json().catch(() => null)
          : klRes
            ? await klRes.json().catch(() => null)
            : null;
        if (Array.isArray(candles) && candles.length > 20) {
          const atrPct = medianAtrPctFromCandles(
            candles.map((c) => c.close),
            candles.map((c) => c.high),
            candles.map((c) => c.low)
          );
          const adapted = adaptRiskToObservedVol(effectiveRisk, profile, atrPct);
          effectiveRisk = adapted.risk;
          setVolNote(adapted.note);
          setRisk(adapted.risk);
        }
      } catch {
        /* optional adapt */
      }

      const qs = new URLSearchParams({
        preset: presetId,
        initialCapital: String(effectiveRisk.initialCapital),
        riskPerTrade: String(effectiveRisk.riskPerTrade),
        stopLossATR: String(effectiveRisk.stopLossATR),
        takeProfitATR: String(effectiveRisk.takeProfitATR),
        maxHoldBars: String(effectiveRisk.maxHoldBars),
        feeRate: String(effectiveRisk.feeRate),
        slippage: String(effectiveRisk.slippage),
        maxConcurrentPositions: String(effectiveRisk.maxConcurrentPositions),
        maxExposurePct: String(effectiveRisk.maxExposurePct),
        maxPortfolioDrawdownPct: String(effectiveRisk.maxPortfolioDrawdownPct),
        minSignalStrength: String(effectiveRisk.minSignalStrength),
        allowShort: String(effectiveRisk.allowShort),
        interval: effectiveRisk.interval,
        walkForward: 'true',
        oosWindows: '3',
        limit: effectiveRisk.interval === '1d' ? '250' : '400',
      });
      if (customSymbols.trim()) qs.set('symbols', customSymbols.trim());

      const res = await fetch(`/api/quant?${qs.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setResult(data);
      setReview(null);
      setReviewError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Quant run failed');
    } finally {
      setLoading(false);
    }
  }, [risk, presetId, customSymbols, profile, marketId]);

  const runRiskReview = useCallback(async () => {
    if (!result) return;
    setReviewLoading(true);
    setReviewError(null);
    try {
      const res = await fetch('/api/quant-monitor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ result, benchmark: result.benchmark ?? null, persist: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setReview(data as RiskReviewResult);
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : 'Risk review failed');
    } finally {
      setReviewLoading(false);
    }
  }, [result]);

  const full = result?.full;
  const wf = result?.walkForward;

  return (
    <Layout>
      <div className="qm-page">
      {error && (
        <div style={{ padding: '12px 16px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '8px', color: '#ef4444', fontSize: '13px', marginBottom: '16px' }}>
          {error}
        </div>
      )}

      <div style={{ marginBottom: '12px' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: profile.accent, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>
          Market Desk · {marketId}
        </div>
        <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#f9fafb', margin: 0 }}>{profile.title}</h2>
        <p style={{ fontSize: '12px', color: '#9ca3af', margin: '6px 0 0' }}>{profile.subtitle}</p>
        <ul style={{ margin: '8px 0 0 18px', padding: 0, fontSize: '11px', color: '#6b7280' }}>
          {profile.behavior.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      </div>

      <div style={{ background: '#111827', border: '1px solid #374151', borderRadius: '12px', padding: '16px', marginBottom: '16px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '12px', marginBottom: '12px' }}>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={{ display: 'block', fontSize: '11px', color: '#9ca3af', marginBottom: '4px', fontWeight: 600 }}>
              Universe
            </label>
            <select style={inputStyle} value={presetId} onChange={(e) => setPresetId(e.target.value)}>
              {availablePresets.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={{ display: 'block', fontSize: '11px', color: '#9ca3af', marginBottom: '4px', fontWeight: 600 }}>
              Custom symbols
            </label>
            <input
              style={inputStyle}
              placeholder="yahoo:GC=F,binance:ETHUSDT"
              value={customSymbols}
              onChange={(e) => setCustomSymbols(e.target.value)}
            />
          </div>
        </div>

        <div className="qm-grid-params" style={{ marginTop: 14 }}>
          {(
            [
              ['riskPerTrade', 'Risk / trade'],
              ['maxConcurrentPositions', 'Max positions'],
              ['maxExposurePct', 'Max exposure'],
              ['maxPortfolioDrawdownPct', 'DD halt'],
              ['minSignalStrength', 'Min signal'],
              ['stopLossATR', 'SL ATR'],
              ['takeProfitATR', 'TP ATR'],
              ['maxHoldBars', 'Max hold'],
            ] as const
          ).map(([key, label]) => (
            <div key={key}>
              <label style={{ display: 'block', fontSize: '11px', color: '#9ca3af', marginBottom: '4px', fontWeight: 600 }}>{label}</label>
              <input
                style={inputStyle}
                type="number"
                step={key === 'riskPerTrade' || key === 'maxExposurePct' || key === 'maxPortfolioDrawdownPct' ? 0.001 : 0.1}
                value={risk[key] as number}
                onChange={(e) => update(key, e.target.value)}
              />
            </div>
          ))}
          <div>
            <label style={{ display: 'block', fontSize: '11px', color: '#9ca3af', marginBottom: '4px', fontWeight: 600 }}>Interval</label>
            <select style={inputStyle} value={risk.interval} onChange={(e) => update('interval', e.target.value)}>
              {marketId === 'crypto' ? (
                <>
                  <option value="1h">1h</option>
                  <option value="4h">4h</option>
                  <option value="1d">1d</option>
                </>
              ) : (
                <>
                  <option value="1d">1d</option>
                  <option value="1w">1w</option>
                </>
              )}
            </select>
          </div>
        </div>

        <div style={{ marginTop: '14px', display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            onClick={run}
            disabled={loading}
            style={{
              padding: '10px 22px',
              border: 'none',
              borderRadius: '8px',
              background: loading ? '#374151' : `linear-gradient(135deg, ${profile.accent}, #10b981)`,
              color: 'white',
              fontWeight: 700,
              fontSize: '13px',
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.7 : 1,
            }}
          >
            {loading ? 'Running…' : '▶ Run Quant Backtest'}
          </button>
          {full && (
            <button
              onClick={runRiskReview}
              disabled={reviewLoading}
              style={{
                padding: '9px 16px',
                border: '1px solid rgba(139,92,246,0.45)',
                borderRadius: '8px',
                background: reviewLoading ? '#374151' : 'rgba(139,92,246,0.12)',
                color: '#c4b5fd',
                fontWeight: 700,
                fontSize: '12px',
                cursor: reviewLoading ? 'not-allowed' : 'pointer',
              }}
            >
              {reviewLoading ? 'Reviewing…' : '◈ AI Risk Review'}
            </button>
          )}
          {volNote && <span style={{ fontSize: '11px', color: '#f59e0b' }}>{volNote}</span>}
        </div>

        {reviewError && <div style={{ marginTop: 10, fontSize: 11, color: '#ef4444' }}>{reviewError}</div>}
        {review && (
          <div style={{ marginTop: 14, padding: '12px 14px', borderRadius: 8, border: '1px solid rgba(139,92,246,0.3)', background: 'rgba(139,92,246,0.06)' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#e9d5ff', marginBottom: 8 }}>
              AI Risk Review · {review.credibility} · {review.source}
            </div>
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 12, color: '#d1d5db', lineHeight: 1.55 }}>
              {review.review}
            </pre>
          </div>
        )}
      </div>

      {full && (
        <>
        <div className="qm-grid-metrics" style={{ marginBottom: 20 }}>
            <MetricCard label="Profit Factor" value={full.profitFactor} color={full.profitFactor >= 1.3 ? '#10b981' : full.profitFactor >= 1 ? '#f59e0b' : '#ef4444'} />
            <MetricCard label="Sharpe (Ann.)" value={full.sharpeRatio} />
            <MetricCard label="Max DD%" value={`${full.maxDrawdownPercent}%`} color={full.maxDrawdownPercent <= 8 ? '#10b981' : '#ef4444'} />
            <MetricCard label="Net PnL%" value={`${full.totalPnLPercent}%`} color={full.totalPnLPercent >= 0 ? '#10b981' : '#ef4444'} />
            <MetricCard label="Trades" value={full.totalTrades} />
            <MetricCard label="Expectancy R" value={full.expectancyR} />
            <MetricCard label="Win Rate" value={`${full.winRate.toFixed(1)}%`} />
            <MetricCard label="Alpha" value={`${full.alpha}%`} color={full.alpha >= 0 ? '#10b981' : '#ef4444'} />
          </div>

          {wf && wf.windows.length > 0 && (
            <div style={{ background: '#111827', border: '1px solid #374151', borderRadius: 12, overflow: 'hidden', marginBottom: 20 }}>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid #374151' }}>
                <h3 style={{ fontSize: 14, color: '#f9fafb', margin: 0 }}>Walk-Forward (OOS)</h3>
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
                  OOS avg PF {wf.oosAggregate.avgProfitFactor} · Sharpe {wf.oosAggregate.avgSharpe} ·
                  Edge windows {wf.oosAggregate.windowsWithPositiveEdge}/{wf.oosAggregate.windowsTotal}
                </div>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #374151' }}>
                      {['Window', 'IS PF', 'OOS PF', 'OOS Sharpe', 'OOS PnL%', 'OOS DD%'].map((h) => (
                        <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontSize: 10, color: '#6b7280', textTransform: 'uppercase', fontWeight: 700 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {wf.windows.map((w) => (
                      <tr key={w.label} style={{ borderBottom: '1px solid #1f2937' }}>
                        <td style={{ padding: '10px 12px', color: '#d1d5db' }}>{w.label}</td>
                        <td style={{ padding: '10px 12px', color: '#d1d5db' }}>{w.inSample?.profitFactor ?? '—'}</td>
                        <td style={{ padding: '10px 12px', color: (w.outOfSample?.profitFactor ?? 0) >= 1 ? '#10b981' : '#ef4444' }}>{w.outOfSample?.profitFactor ?? '—'}</td>
                        <td style={{ padding: '10px 12px', color: '#d1d5db' }}>{w.outOfSample?.sharpeRatio ?? '—'}</td>
                        <td style={{ padding: '10px 12px', color: (w.outOfSample?.totalPnLPercent ?? 0) >= 0 ? '#10b981' : '#ef4444' }}>{w.outOfSample ? `${w.outOfSample.totalPnLPercent}%` : '—'}</td>
                        <td style={{ padding: '10px 12px', color: '#d1d5db' }}>{w.outOfSample ? `${w.outOfSample.maxDrawdownPercent}%` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      <PaperTradingAgent
        risk={risk}
        presetId={presetId}
        customSymbols={customSymbols}
        agentId={marketId}
      />
      </div>
    </Layout>
  );
}
