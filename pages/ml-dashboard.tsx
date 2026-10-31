import React, { useEffect, useState } from 'react';
import Layout from '../components/Layout/Layout';

interface ModelInfo {
  symbol: string;
  interval: string;
  trained_at?: string;
  forward_bars?: number;
  regime_filter?: string;
  prob_threshold?: number;
  gates_passed?: boolean;
  oos_metrics?: any;
  file_exists: boolean;
}

interface MlMeta {
  symbol?: string;
  interval?: string;
  trained_at?: string;
  forward_bars?: number;
  regime_filter?: string;
  prob_threshold?: number;
  feature_cols?: string[];
  feature_importance?: Record<string, number>;
  oos_metrics?: any;
  gates_passed?: boolean;
  model_type?: string;
  base_score?: number;
}

interface MlPredict {
  symbol: string;
  interval: string;
  prediction: number;
  probabilityUp: number;
  confidence: number;
  signal: 'long' | 'flat';
  regimePass: boolean;
  source: 'model' | 'fallback';
  modelVersion?: string;
  featuresUsed: string[];
  forwardBars?: number;
  probThreshold?: number;
  regimeFilter?: string;
  latestClose?: number;
  atrPct?: number;
  timestamp: number;
  error?: string;
}

interface MLBacktest {
  symbol: string;
  interval: string;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalReturnPercent: number;
  profitFactor: number;
  maxDrawdownPercent: number;
  expectancyR: number;
  avgBarsHeld: number;
  equityCurve: Array<{ time: number; equity: number }>;
  trades: any[];
  tradesByMonth: any[];
  error?: string;
}

function getSetupMessage(p: MlPredict | null): string {
  if (!p) return '—';
  if (p.signal === 'long' && p.regimePass) return '✅ Setup valid: LONG dengan regime BTC bull dan P(naik) di atas threshold';
  if (p.signal === 'flat') return '⚪ Tidak ada signal: probabilitas di bawah threshold atau regime tidak lolos';
  return '⚠️ Setup tidak valid';
}

export default function MlDashboard() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selected, setSelected] = useState<{ symbol: string; interval: string }>({
    symbol: 'SOLUSDT',
    interval: '4h',
  });
  const [meta, setMeta] = useState<MlMeta | null>(null);
  const [predict, setPredict] = useState<MlPredict | null>(null);
  const [backtest, setBacktest] = useState<MLBacktest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const mRes = await fetch('/api/ml-models');
        if (mRes.ok) {
          const ms: ModelInfo[] = await mRes.json();
          setModels(ms);
        }

        await loadSelected();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        if (!cancelled) setLoading(false);
      }

      return () => { cancelled = true; };
    }

    load();
  }, [selected.symbol, selected.interval]);

  async function loadSelected() {
    try {
      const metaRes = await fetch(`/ml/models/${selected.symbol}_${selected.interval}.meta.json`);
      if (metaRes.ok) {
        const m: MlMeta = await metaRes.json();
        setMeta(m);
      } else {
        setMeta(null);
      }

      const predRes = await fetch(`/api/ml-predict?symbol=${selected.symbol}&interval=${selected.interval}`);
      if (predRes.ok) {
        const p: MlPredict = await predRes.json();
        setPredict(p);
      } else {
        setPredict(null);
      }

      const btRes = await fetch(`/api/ml-backtest?symbol=${selected.symbol}&interval=${selected.interval}&lookback=2000`);
      if (btRes.ok) {
        const b: MLBacktest = await btRes.json();
        setBacktest(b);
      } else {
        setBacktest(null);
      }
    } catch {
      setMeta(null);
      setPredict(null);
      setBacktest(null);
    }
  }

  if (loading) {
    return (
      <Layout>
        <div style={{ padding: '40px 24px', maxWidth: '1400px', margin: '0 auto' }}>
          <h2 style={{ fontSize: '20px', fontWeight: '700', color: '#f9fafb', marginBottom: '16px' }}>
            🤖 ML Model Dashboard
          </h2>
          <p style={{ color: '#9ca3af' }}>Memuat model…</p>
        </div>
      </Layout>
    );
  }

  const availableModels = models.filter((m) => m.file_exists);
  const curMeta = meta;
  const curPred = predict;
  const curBt = backtest;
  const oos = curMeta?.oos_metrics || {};
  const imp = curMeta?.feature_importance || {};
  const impEntries = Object.entries(imp);
  const totalImp = impEntries.reduce((a, [, v]) => a + (v as number), 0);
  const sortedImp = impEntries
    .sort(([, a], [, b]) => (b as number) - (a as number))
    .slice(0, 8)
    .map(([name, val]) => ({
      name,
      val: val as number,
      pct: totalImp > 0 ? ((val as number) / totalImp) * 100 : 0,
    }));

  // --- Trade Setup calculations (latest prediction) ---
  const latestClose = curPred?.latestClose;
  const atrPct = curPred?.atrPct ?? 0;
  const entry = latestClose ?? 0;
  const atrAbs = entry * (atrPct / 100);
  const slMult = 2.0;
  const tpMult = 2.5;
  const slPrice = entry > 0 ? entry - slMult * atrAbs : 0;
  const tpPrice = entry > 0 ? entry + tpMult * atrAbs : 0;
  const riskReward = tpPrice > 0 && slPrice > 0 && entry > 0 ? (tpPrice - entry) / (entry - slPrice) : 0;
  const prob = curPred?.probabilityUp ?? 0.5;
  const kellyFraction = prob > 0.5 && riskReward > 0 ? Math.min(0.05, (prob * (riskReward + 1) - 1) / riskReward) : 0;

  const hasModel = curMeta != null || curPred != null;

  // --- Monte Carlo bootstrap from backtest trades ---
  let mcStats: { winProb: number; p5: number; median: number; p95: number; worst: number } | null = null;
  if (curBt?.trades && curBt.trades.length > 0) {
    const tradeReturns = curBt.trades.map((t) => t.pnlPercent / 100);
    const iterations = 300;
    const results: number[] = [];
    for (let iter = 0; iter < iterations; iter++) {
      let iterReturn = 0;
      const n = tradeReturns.length;
      for (let i = 0; i < n; i++) {
        const r = tradeReturns[Math.floor(Math.random() * n)];
        iterReturn += r;
      }
      results.push(iterReturn);
    }
    results.sort((a, b) => a - b);
    mcStats = {
      winProb: results.filter((r) => r > 0).length / iterations,
      p5: results[Math.floor(iterations * 0.05)],
      median: results[Math.floor(iterations * 0.5)],
      p95: results[Math.floor(iterations * 0.95)],
      worst: results[0],
    };
  }

  return (
    <Layout>
      <div style={{ padding: '24px', maxWidth: '1400px', margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
          <div>
            <h2 style={{ fontSize: '20px', fontWeight: '700', color: '#f9fafb', margin: 0 }}>
              🤖 ML Model Dashboard
            </h2>
            <p style={{ color: '#9ca3af', fontSize: '12px', marginTop: '4px' }}>
              XGBoost gradient boosting — inferensi murni TypeScript di Vercel
            </p>
          </div>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              border: '1px solid #3b82f6',
              background: 'transparent',
              color: '#3b82f6',
              fontSize: '12px',
              fontWeight: '600',
              cursor: 'pointer',
            }}
          >
            🔄 Refresh
          </button>
        </div>

        {/* Model selector */}
        <div style={{ marginBottom: '24px', background: 'rgba(31, 41, 55, 0.4)', border: '1px solid #374151', borderRadius: '8px', padding: '16px' }}>
          <div style={{ fontSize: '11px', color: '#9ca3af', textTransform: 'uppercase', marginBottom: '8px' }}>Pilih Model</div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {availableModels.map((m) => {
              const isSel = m.symbol === selected.symbol && m.interval === selected.interval;
              return (
                <button
                  key={`${m.symbol}_${m.interval}`}
                  onClick={() => setSelected({ symbol: m.symbol, interval: m.interval })}
                  style={{
                    padding: '6px 12px',
                    borderRadius: '6px',
                    border: isSel ? '2px solid #3b82f6' : '1px solid #374151',
                    background: isSel ? 'rgba(59, 130, 246, 0.2)' : 'transparent',
                    color: '#f9fafb',
                    fontSize: '12px',
                    fontWeight: isSel ? '700' : '500',
                    cursor: 'pointer',
                  }}
                >
                  {m.symbol} {m.interval} {m.gates_passed ? '✅' : '⚠️'}
                </button>
              );
            })}
          </div>
          {availableModels.length === 0 && (
            <p style={{ color: '#fca5a5', fontSize: '12px', marginTop: '8px' }}>
              Belum ada model yang tersedia. Jalankan training dulu.
            </p>
          )}
        </div>

        {error && !hasModel && (
          <div style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '8px', padding: '16px', color: '#fca5a5', marginBottom: '24px' }}>
            {error}
          </div>
        )}

        {!hasModel && availableModels.length > 0 && (
          <div style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '8px', padding: '16px', color: '#fca5a5', marginBottom: '24px' }}>
            Model {selected.symbol} {selected.interval} belum tersedia. Coba pilih model lain atau train dulu.
          </div>
        )}

        {hasModel && (
          <>
            {/* Status banner */}
            <div style={{ display: 'flex', gap: '12px', marginBottom: '24px', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: '200px', background: 'rgba(31, 41, 55, 0.5)', border: '1px solid #374151', borderRadius: '8px', padding: '16px' }}>
                <div style={{ fontSize: '11px', color: '#9ca3af', textTransform: 'uppercase', marginBottom: '8px' }}>Model</div>
                <div style={{ fontSize: '15px', fontWeight: '600', color: '#f9fafb' }}>{curMeta?.symbol} {curMeta?.interval}</div>
                <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '4px' }}>
                  {curMeta?.gates_passed ? '✅ Gates lolos' : '⚠️ Gates gagal'}
                </div>
                <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '4px' }}>
                  Terlatih: {curMeta?.trained_at ? new Date(curMeta.trained_at).toLocaleString() : '—'}
                </div>
              </div>

              <div style={{ flex: 1, minWidth: '200px', background: 'rgba(31, 41, 55, 0.5)', border: '1px solid #374151', borderRadius: '8px', padding: '16px' }}>
                <div style={{ fontSize: '11px', color: '#9ca3af', textTransform: 'uppercase', marginBottom: '8px' }}>Prediksi Terbaru</div>
                <div style={{ fontSize: '15px', fontWeight: '600', color: curPred?.signal === 'long' ? '#10b981' : '#f59e0b' }}>
                  {curPred?.signal === 'long' ? '🟢 LONG' : '⚪ FLAT'}
                </div>
                <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '4px' }}>
                  P(naik): {(curPred?.probabilityUp ?? 0.5 * 100).toFixed(1)}%
                </div>
                <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '4px' }}>
                  Regime: {curPred?.regimePass ? '✅ Bull' : '❌ Tidak lolos'}
                </div>
              </div>

              <div style={{ flex: 1, minWidth: '200px', background: 'rgba(31, 41, 55, 0.5)', border: '1px solid #374151', borderRadius: '8px', padding: '16px' }}>
                <div style={{ fontSize: '11px', color: '#9ca3af', textTransform: 'uppercase', marginBottom: '8px' }}>Sumber</div>
                <div style={{ fontSize: '15px', fontWeight: '600', color: curPred?.source === 'model' ? '#10b981' : '#f59e0b' }}>
                  {curPred?.source === 'model' ? '🤖 Model' : '⚠️ Fallback'}
                </div>
                <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '4px' }}>
                  Forward bars: {curMeta?.forward_bars ?? '—'}
                </div>
                <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '4px' }}>
                  Prob threshold: {((curMeta?.prob_threshold ?? 0.55) * 100).toFixed(0)}%
                </div>
              </div>
            </div>

            {/* Trade Setup Chart area */}
            <div style={{ background: 'rgba(31, 41, 55, 0.5)', border: '1px solid #374151', borderRadius: '8px', padding: '20px', marginBottom: '24px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '16px' }}>
                <h3 style={{ fontSize: '14px', fontWeight: '700', color: '#f9fafb', margin: 0 }}>📊 Trade Setup</h3>
                <span style={{ fontSize: '11px', color: '#9ca3af', fontFamily: 'monospace' }}>
                  Entry: {entry > 0 ? entry.toFixed(2) : '—'} · ATR: {atrAbs > 0 ? atrAbs.toFixed(2) : '—'}
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px' }}>
                {[
                  { label: 'Entry', val: entry > 0 ? entry.toFixed(2) : '—', color: '#f9fafb' },
                  { label: 'Stop Loss', val: slPrice > 0 ? slPrice.toFixed(2) : '—', color: '#f87171' },
                  { label: 'Take Profit', val: tpPrice > 0 ? tpPrice.toFixed(2) : '—', color: '#10b981' },
                  { label: 'R:R', val: riskReward > 0 ? riskReward.toFixed(2) : '—', color: '#f9fafb' },
                  { label: 'Kelly Size', val: kellyFraction > 0 ? (kellyFraction * 100).toFixed(1) + '%' : '—', color: '#3b82f6' },
                  { label: 'Win Prob', val: (prob * 100).toFixed(1) + '%', color: prob > 0.6 ? '#10b981' : '#f59e0b' },
                ].map((m) => (
                  <div key={m.label} style={{ background: 'rgba(17, 24, 39, 0.6)', border: '1px solid #374151', borderRadius: '6px', padding: '12px' }}>
                    <div style={{ fontSize: '10px', color: '#9ca3af', textTransform: 'uppercase', marginBottom: '4px' }}>{m.label}</div>
                    <div style={{ fontSize: '16px', fontWeight: '700', color: m.color, fontFamily: 'monospace' }}>{m.val}</div>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: '16px', fontSize: '11px', color: '#9ca3af', fontFamily: 'monospace', lineHeight: '1.6' }}>
                <div>SL ───────── {slPrice > 0 ? slPrice.toFixed(2) : '—'}</div>
                <div>ENTRY ───── {entry > 0 ? entry.toFixed(2) : '—'}</div>
                <div>TP ──────── {tpPrice > 0 ? tpPrice.toFixed(2) : '—'}</div>
                <div style={{ marginTop: '8px' }}>{getSetupMessage(curPred)}</div>
              </div>
            </div>

            {/* Backtest Results */}
            {curBt && !curBt.error && (
              <>
                {/* Backtest summary */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px', marginBottom: '24px' }}>
                  {[
                    { label: 'Total Return', val: curBt.totalReturnPercent > 0 ? `+${curBt.totalReturnPercent.toFixed(2)}%` : curBt.totalReturnPercent.toFixed(2) + '%', color: curBt.totalReturnPercent > 0 ? '#10b981' : '#f87171' },
                    { label: 'Profit Factor', val: curBt.profitFactor.toFixed(2), color: '#f9fafb' },
                    { label: 'Win Rate', val: curBt.winRate.toFixed(1) + '%', color: curBt.winRate > 50 ? '#10b981' : '#f59e0b' },
                    { label: 'Max Drawdown', val: `-${curBt.maxDrawdownPercent.toFixed(2)}%`, color: '#f87171' },
                    { label: 'Total Trades', val: curBt.totalTrades.toString(), color: '#f9fafb' },
                    { label: 'Expectancy R', val: curBt.expectancyR.toFixed(2) + 'R', color: curBt.expectancyR > 0 ? '#10b981' : '#f87171' },
                  ].map((m) => (
                    <div key={m.label} style={{ background: 'rgba(31, 41, 55, 0.5)', border: '1px solid #374151', borderRadius: '8px', padding: '16px' }}>
                      <div style={{ fontSize: '11px', color: '#9ca3af', textTransform: 'uppercase', marginBottom: '6px' }}>{m.label}</div>
                      <div style={{ fontSize: '18px', fontWeight: '700', color: m.color, fontFamily: 'monospace' }}>{m.val}</div>
                    </div>
                  ))}
                </div>

                {/* Trade List Table */}
                <div style={{ background: 'rgba(31, 41, 55, 0.5)', border: '1px solid #374151', borderRadius: '8px', padding: '20px', marginBottom: '24px' }}>
                  <h3 style={{ fontSize: '14px', fontWeight: '700', color: '#f9fafb', margin: '0 0 12px 0' }}>📋 Trade List ({curBt.totalTrades} trades)</h3>
                  <div style={{ overflowX: 'auto', marginBottom: '12px' }}>
                    <table style={{ width: '100%', minWidth: '900px', borderCollapse: 'collapse', fontSize: '11px' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid #374151' }}>
                          {['#', 'Masuk', 'Keluar', 'Arah', 'Entry → Exit', 'Hasil', 'Exit via', 'Bar', 'Saldo'].map((h) => (
                            <th key={h} style={{ padding: '8px 10px', textAlign: 'left', fontSize: '10px', fontWeight: '700', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.5px', whiteSpace: 'nowrap' }}>
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {curBt.trades.slice(-20).map((t) => {
                          const exitDate = t.exitTime ? new Date(t.exitTime * 1000).toISOString().slice(0, 10) : '—';
                          const entryDate = new Date(t.entryTime * 1000).toISOString().slice(0, 10);
                          const pnlColor = t.pnl > 0 ? '#10b981' : '#ef4444';
                          return (
                            <tr key={t.id} style={{ borderBottom: '1px solid #1f2937' }}>
                              <td style={{ padding: '8px 10px', color: '#9ca3af', fontSize: '11px' }}>{t.id}</td>
                              <td style={{ padding: '8px 10px', color: '#9ca3af', fontSize: '11px', whiteSpace: 'nowrap' }}>{entryDate}</td>
                              <td style={{ padding: '8px 10px', color: '#9ca3af', fontSize: '11px', whiteSpace: 'nowrap' }}>{exitDate}</td>
                              <td style={{ padding: '8px 10px', color: '#fbbf24', fontSize: '11px' }}>Long</td>
                              <td style={{ padding: '8px 10px', color: '#9ca3af', fontSize: '11px', whiteSpace: 'nowrap' }}>{t.entryPrice?.toFixed(2)} → {t.exitPrice?.toFixed(2)}</td>
                              <td style={{ padding: '8px 10px', color: pnlColor, fontSize: '11px', fontWeight: '700' }}>{t.pnl > 0 ? '+' : ''}{t.pnl.toFixed(2)} ({t.pnlPercent.toFixed(2)}%)</td>
                              <td style={{ padding: '8px 10px', color: '#9ca3af', fontSize: '11px' }}>{t.exitReason}</td>
                              <td style={{ padding: '8px 10px', color: '#9ca3af', fontSize: '11px' }}>{t.barsHeld}</td>
                              <td style={{ padding: '8px 10px', color: '#f9fafb', fontSize: '11px' }}>{t.pnl > 0 ? '+' : ''}${(1000 + curBt.trades.slice(0, t.id).reduce((a, x) => a + x.pnl, 0)).toFixed(2)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {curBt.totalTrades > 20 && (
                    <p style={{ fontSize: '11px', color: '#9ca3af', marginTop: '8px' }}>
                      Menampilkan 20 trade terakhir dari {curBt.totalTrades} total.
                    </p>
                  )}
                </div>

                {/* Monte Carlo */}
                {mcStats && (
                  <div style={{ background: 'rgba(31, 41, 55, 0.5)', border: '1px solid #374151', borderRadius: '8px', padding: '20px', marginBottom: '24px' }}>
                    <h3 style={{ fontSize: '14px', fontWeight: '700', color: '#f9fafb', margin: '0 0 12px 0' }}>🎲 Monte Carlo Bootstrap (300 iterasi, 1% risiko/trade)</h3>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: '8px' }}>
                      {[
                        { label: 'Peluang Profit', val: (mcStats.winProb * 100).toFixed(0) + '%', color: '#10b981' },
                        { label: 'Persentil 5', val: (mcStats.p5 * 100).toFixed(1) + '%', color: '#f9fafb' },
                        { label: 'Median', val: (mcStats.median * 100).toFixed(1) + '%', color: '#f9fafb' },
                        { label: 'Persentil 95', val: (mcStats.p95 * 100).toFixed(1) + '%', color: '#f9fafb' },
                        { label: 'Terburuk', val: (mcStats.worst * 100).toFixed(1) + '%', color: '#f87171' },
                      ].map((m) => (
                        <div key={m.label} style={{ background: 'rgba(17, 24, 39, 0.6)', border: '1px solid #374151', borderRadius: '6px', padding: '12px' }}>
                          <div style={{ fontSize: '10px', color: '#9ca3af', textTransform: 'uppercase', marginBottom: '4px' }}>{m.label}</div>
                          <div style={{ fontSize: '16px', fontWeight: '700', color: m.color, fontFamily: 'monospace' }}>{m.val}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Walk-forward OOS */}
                <div style={{ background: 'rgba(31, 41, 55, 0.5)', border: '1px solid #374151', borderRadius: '8px', padding: '20px', marginBottom: '24px' }}>
                  <h3 style={{ fontSize: '14px', fontWeight: '700', color: '#f9fafb', margin: '0 0 12px 0' }}>🔄 Walk-Forward Out-of-Sample</h3>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', minWidth: '700px', borderCollapse: 'collapse', fontSize: '11px' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid #374151' }}>
                          {['Jendela', 'Trade', 'Return', 'PF', 'DD', 'Expectancy'].map((h) => (
                            <th key={h} style={{ padding: '8px 10px', textAlign: 'left', fontSize: '10px', fontWeight: '700', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.5px', whiteSpace: 'nowrap' }}>
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(oos.windows || {}).map(([key, w]: [string, any]) => (
                          <tr key={key} style={{ borderBottom: '1px solid #1f2937' }}>
                            <td style={{ padding: '8px 10px', color: '#9ca3af', fontSize: '11px' }}>{w.label || key}</td>
                            <td style={{ padding: '8px 10px', color: '#9ca3af', fontSize: '11px' }}>{w.oos_trades ?? 0}</td>
                            <td style={{ padding: '8px 10px', color: w.oos_totalPnLPercent > 0 ? '#10b981' : '#f87171', fontSize: '11px' }}>{w.oos_totalPnLPercent?.toFixed(2) ?? 0}%</td>
                            <td style={{ padding: '8px 10px', color: '#9ca3af', fontSize: '11px' }}>{w.oos_pf?.toFixed(2) ?? 0}</td>
                            <td style={{ padding: '8px 10px', color: '#f87171', fontSize: '11px' }}>{w.oos_maxDrawdownPercent?.toFixed(2) ?? 0}%</td>
                            <td style={{ padding: '8px 10px', color: '#9ca3af', fontSize: '11px' }}>{w.oos_expectancyR?.toFixed(2) ?? 0}R</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Feature Importances */}
                <div style={{ background: 'rgba(31, 41, 55, 0.5)', border: '1px solid #374151', borderRadius: '8px', padding: '20px', marginBottom: '24px' }}>
                  <h3 style={{ fontSize: '14px', fontWeight: '700', color: '#f9fafb', margin: '0 0 12px 0' }}>📊 Feature Importances (top 8)</h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {sortedImp.map((f) => (
                      <div key={f.name} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span style={{ fontSize: '12px', color: '#9ca3af', width: '140px' }}>{f.name}</span>
                        <div style={{ flex: 1, height: '6px', background: '#374151', borderRadius: '3px', overflow: 'hidden' }}>
                          <div style={{ height: '100%', background: 'linear-gradient(90deg, #3b82f6, #8b5cf6)', width: `${f.pct.toFixed(1)}%` }}></div>
                        </div>
                        <span style={{ fontSize: '11px', color: '#9ca3af', fontFamily: 'monospace', width: '40px', textAlign: 'right' }}>{f.pct.toFixed(1)}%</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Raw JSON */}
                <div style={{ background: '#111827', border: '1px solid #374151', borderRadius: '8px', padding: '16px', fontSize: '11px', color: '#9ca3af', fontFamily: 'monospace', overflowX: 'auto' }}>
                  <div style={{ fontSize: '12px', color: '#f9fafb', fontWeight: '600', marginBottom: '8px' }}>Meta (raw)</div>
                  <div>{JSON.stringify(curMeta, null, 2)}</div>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Layout>
  );
}
