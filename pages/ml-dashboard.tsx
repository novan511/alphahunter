import React, { useEffect, useState } from 'react';
import Layout from '../components/Layout/Layout';

interface ModelInfo {
  symbol: string;
  interval: string;
  trained_at?: string;
  forward_bars?: number;
  regime_filter?: string;
  prob_threshold?: number;
  leverage?: number;
  allow_short?: boolean;
  rr_ratio?: number;
  risk_per_trade?: number;
  stop_loss_atr?: number;
  take_profit_atr?: number;
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
  leverage?: number;
  allow_short?: boolean;
  rr_ratio?: number;
  risk_per_trade?: number;
  stop_loss_atr?: number;
  take_profit_atr?: number;
  max_hold_bars?: number;
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
  probabilityDown: number;
  confidence: number;
  signal: 'long' | 'short' | 'flat';
  regimePass: boolean;
  source: 'model' | 'fallback';
  leverage?: number;
  allowShort?: boolean;
  rrRatio?: number;
  riskPerTrade?: number;
  stopLossATR?: number;
  takeProfitATR?: number;
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
  leverage: number;
  allowShort: boolean;
  rrRatio: number;
  riskPerTrade: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalReturnPercent: number;
  profitFactor: number;
  maxDrawdownPercent: number;
  expectancyR: number;
  avgR: number;
  sharpe: number;
  avgBarsHeld: number;
  equityCurve: Array<{ time: number; equity: number }>;
  trades: any[];
  tradesByMonth: any[];
  initialCapital: number;
  finalCapital: number;
  error?: string;
}

function getSetupMessage(p: MlPredict | null): string {
  if (!p) return '—';
  if (p.signal === 'long' && p.regimePass) return '✅ Setup valid: LONG — regime BTC bull, P(naik) di atas threshold';
  if (p.signal === 'short' && p.regimePass) return '✅ Setup valid: SHORT — regime BTC bear/neutral, P(turun) di atas threshold';
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
  const [uiConfig, setUiConfig] = useState({
    leverage: 1,
    allowShort: true,
    riskPerTrade: 0.01,
    stopLossATR: 2.0,
    takeProfitATR: 5.0,
    maxHoldBars: 30,
    probThreshold: 0.55,
  });
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
        setUiConfig({
          leverage: m.leverage ?? 1,
          allowShort: m.allow_short ?? true,
          riskPerTrade: m.risk_per_trade ?? 0.01,
          stopLossATR: m.stop_loss_atr ?? 2.0,
          takeProfitATR: m.take_profit_atr ?? 5.0,
          maxHoldBars: m.max_hold_bars ?? 30,
          probThreshold: m.prob_threshold ?? 0.55,
        });
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

      const btRes = await fetch(
        `/api/ml-backtest?symbol=${selected.symbol}&interval=${selected.interval}&lookback=2000` +
        `&leverage=${uiConfig.leverage}&allowShort=${uiConfig.allowShort}` +
        `&riskPerTrade=${uiConfig.riskPerTrade}&stopLossATR=${uiConfig.stopLossATR}` +
        `&takeProfitATR=${uiConfig.takeProfitATR}&maxHoldBars=${uiConfig.maxHoldBars}` +
        `&probThreshold=${uiConfig.probThreshold}`
      );
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

  // Re-run backtest when UI config changes
  useEffect(() => {
    if (!meta || !predict) return;
    const timer = setTimeout(async () => {
      try {
        const btRes = await fetch(
          `/api/ml-backtest?symbol=${selected.symbol}&interval=${selected.interval}&lookback=2000` +
          `&leverage=${uiConfig.leverage}&allowShort=${uiConfig.allowShort}` +
          `&riskPerTrade=${uiConfig.riskPerTrade}&stopLossATR=${uiConfig.stopLossATR}` +
          `&takeProfitATR=${uiConfig.takeProfitATR}&maxHoldBars=${uiConfig.maxHoldBars}` +
          `&probThreshold=${uiConfig.probThreshold}`
        );
        if (btRes.ok) {
          const b: MLBacktest = await btRes.json();
          setBacktest(b);
        }
      } catch {
        // ignore
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [uiConfig, selected.symbol, selected.interval, meta, predict]);

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

  // --- Trade Setup calculations ---
  const latestClose = curPred?.latestClose;
  const atrPct = curPred?.atrPct ?? 0;
  const entry = latestClose ?? 0;
  const atrAbs = entry * (atrPct / 100);
  const slDist = uiConfig.stopLossATR * atrAbs;
  const rrRatio = uiConfig.takeProfitATR / uiConfig.stopLossATR;
  const tpDist = slDist * rrRatio;
  const slPrice = entry > 0 ? entry - slDist : 0;
  const tpPrice = entry > 0 ? entry + tpDist : 0;
  const slPriceShort = entry > 0 ? entry + slDist : 0;
  const tpPriceShort = entry > 0 ? entry - tpDist : 0;
  const riskReward = rrRatio;
  const prob = curPred?.probabilityUp ?? 0.5;
  const probDown = curPred?.probabilityDown ?? 0.5;
  const kellyFraction = prob > 0.5 && riskReward > 0 ? Math.min(0.05, (prob * (riskReward + 1) - 1) / riskReward) : 0;

  const hasModel = curMeta != null || curPred != null;

  return (
    <Layout>
      <div style={{ padding: '24px', maxWidth: '1400px', margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
          <div>
            <h2 style={{ fontSize: '20px', fontWeight: '700', color: '#f9fafb', margin: 0 }}>
              🤖 ML Model Dashboard
            </h2>
            <p style={{ color: '#9ca3af', fontSize: '12px', marginTop: '4px' }}>
              XGBoost Long/Short — leverage, compounded R, professional RR
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
        <div style={{ marginBottom: '20px', background: 'rgba(31, 41, 55, 0.4)', border: '1px solid #374151', borderRadius: '8px', padding: '16px' }}>
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
            <div style={{ display: 'flex', gap: '12px', marginBottom: '20px', flexWrap: 'wrap' }}>
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
                <div style={{ fontSize: '16px', fontWeight: '700', color: curPred?.signal === 'long' ? '#10b981' : curPred?.signal === 'short' ? '#f59e0b' : '#9ca3af' }}>
                  {curPred?.signal === 'long' ? '🟢 LONG' : curPred?.signal === 'short' ? '🔴 SHORT' : '⚪ FLAT'}
                </div>
                <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '4px' }}>
                  P(naik): {(curPred?.probabilityUp ?? 0.5 * 100).toFixed(1)}% ·
                  P(turun): {(curPred?.probabilityDown ?? 0.5 * 100).toFixed(1)}%
                </div>
                <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '4px' }}>
                  Regime: {curPred?.regimePass ? '✅ Lolos' : '❌ Tidak lolos'}
                </div>
              </div>

              <div style={{ flex: 1, minWidth: '200px', background: 'rgba(31, 41, 55, 0.5)', border: '1px solid #374151', borderRadius: '8px', padding: '16px' }}>
                <div style={{ fontSize: '11px', color: '#9ca3af', textTransform: 'uppercase', marginBottom: '8px' }}>Sumber</div>
                <div style={{ fontSize: '15px', fontWeight: '600', color: curPred?.source === 'model' ? '#10b981' : '#f59e0b' }}>
                  {curPred?.source === 'model' ? '🤖 Model' : '⚠️ Fallback'}
                </div>
                <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '4px' }}>
                  Leverage: {curPred?.leverage ?? 1}×
                </div>
                <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '4px' }}>
                  Short: {curPred?.allowShort ? '✅' : '❌'} · RR: 1:{curPred?.rrRatio ?? 2}
                </div>
              </div>
            </div>

            {/* Risk config */}
            <div style={{ background: 'rgba(31, 41, 55, 0.3)', border: '1px solid #374151', borderRadius: '8px', padding: '16px', marginBottom: '20px' }}>
              <div style={{ fontSize: '11px', color: '#9ca3af', textTransform: 'uppercase', marginBottom: '10px' }}>Risk Setup (overrides model defaults)</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px' }}>
                <div>
                  <label style={{ fontSize: '10px', color: '#9ca3af', display: 'block', marginBottom: '4px' }}>Leverage</label>
                  <input
                    type="number"
                    value={uiConfig.leverage}
                    onChange={(e) => setUiConfig({ ...uiConfig, leverage: parseFloat(e.target.value) || 1 })}
                    min="1"
                    max="100"
                    step="1"
                    style={{ width: '100%', padding: '6px', background: '#111827', border: '1px solid #374151', borderRadius: '4px', color: '#f9fafb', fontSize: '12px' }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: '10px', color: '#9ca3af', display: 'block', marginBottom: '4px' }}>Risk / Trade</label>
                  <input
                    type="number"
                    value={uiConfig.riskPerTrade}
                    onChange={(e) => setUiConfig({ ...uiConfig, riskPerTrade: parseFloat(e.target.value) || 0.01 })}
                    min="0.001"
                    max="0.1"
                    step="0.001"
                    style={{ width: '100%', padding: '6px', background: '#111827', border: '1px solid #374151', borderRadius: '4px', color: '#f9fafb', fontSize: '12px' }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: '10px', color: '#9ca3af', display: 'block', marginBottom: '4px' }}>Stop Loss (ATR)</label>
                  <input
                    type="number"
                    value={uiConfig.stopLossATR}
                    onChange={(e) => setUiConfig({ ...uiConfig, stopLossATR: parseFloat(e.target.value) || 2 })}
                    min="0.5"
                    max="10"
                    step="0.1"
                    style={{ width: '100%', padding: '6px', background: '#111827', border: '1px solid #374151', borderRadius: '4px', color: '#f9fafb', fontSize: '12px' }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: '10px', color: '#9ca3af', display: 'block', marginBottom: '4px' }}>RR Ratio (TP:SL)</label>
                  <input
                    type="number"
                    value={uiConfig.takeProfitATR / uiConfig.stopLossATR}
                    onChange={(e) => {
                      const rr = parseFloat(e.target.value) || 2;
                      setUiConfig({ ...uiConfig, takeProfitATR: uiConfig.stopLossATR * rr });
                    }}
                    min="0.5"
                    max="10"
                    step="0.1"
                    style={{ width: '100%', padding: '6px', background: '#111827', border: '1px solid #374151', borderRadius: '4px', color: '#f9fafb', fontSize: '12px' }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: '10px', color: '#9ca3af', display: 'block', marginBottom: '4px' }}>Max Hold (bars)</label>
                  <input
                    type="number"
                    value={uiConfig.maxHoldBars}
                    onChange={(e) => setUiConfig({ ...uiConfig, maxHoldBars: parseInt(e.target.value) || 30 })}
                    min="1"
                    max="100"
                    step="1"
                    style={{ width: '100%', padding: '6px', background: '#111827', border: '1px solid #374151', borderRadius: '4px', color: '#f9fafb', fontSize: '12px' }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: '10px', color: '#9ca3af', display: 'block', marginBottom: '4px' }}>Prob Threshold</label>
                  <input
                    type="number"
                    value={uiConfig.probThreshold}
                    onChange={(e) => setUiConfig({ ...uiConfig, probThreshold: parseFloat(e.target.value) || 0.55 })}
                    min="0.1"
                    max="0.95"
                    step="0.05"
                    style={{ width: '100%', padding: '6px', background: '#111827', border: '1px solid #374151', borderRadius: '4px', color: '#f9fafb', fontSize: '12px' }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'end', gap: '8px' }}>
                  <label style={{ fontSize: '10px', color: '#9ca3af' }}>
                    <input
                      type="checkbox"
                      checked={uiConfig.allowShort}
                      onChange={(e) => setUiConfig({ ...uiConfig, allowShort: e.target.checked })}
                      style={{ accentColor: '#3b82f6' }}
                    />
                    Allow Short
                  </label>
                </div>
              </div>
            </div>

            {/* Trade Setup */}
            <div style={{ background: 'rgba(31, 41, 55, 0.5)', border: '1px solid #374151', borderRadius: '8px', padding: '20px', marginBottom: '24px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '16px' }}>
                <h3 style={{ fontSize: '14px', fontWeight: '700', color: '#f9fafb', margin: 0 }}>📊 Trade Setup</h3>
                <span style={{ fontSize: '11px', color: '#9ca3af', fontFamily: 'monospace' }}>
                  Entry: {entry > 0 ? entry.toFixed(2) : '—'} · ATR: {atrAbs > 0 ? atrAbs.toFixed(2) : '—'} · Leverage: {uiConfig.leverage}×
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px' }}>
                {[
                  { label: 'Entry (LONG)', val: entry > 0 ? entry.toFixed(2) : '—', color: '#10b981' },
                  { label: 'SL (LONG)', val: slPrice > 0 ? slPrice.toFixed(2) : '—', color: '#f87171' },
                  { label: 'TP (LONG)', val: tpPrice > 0 ? tpPrice.toFixed(2) : '—', color: '#10b981' },
                  { label: 'Entry (SHORT)', val: entry > 0 ? entry.toFixed(2) : '—', color: '#f59e0b' },
                  { label: 'SL (SHORT)', val: slPriceShort > 0 ? slPriceShort.toFixed(2) : '—', color: '#f87171' },
                  { label: 'TP (SHORT)', val: tpPriceShort > 0 ? tpPriceShort.toFixed(2) : '—', color: '#10b981' },
                  { label: 'R:R', val: riskReward.toFixed(2), color: '#f9fafb' },
                  { label: 'Kelly Size', val: kellyFraction > 0 ? (kellyFraction * 100).toFixed(1) + '%' : '—', color: '#3b82f6' },
                  { label: 'Win Prob L', val: (prob * 100).toFixed(1) + '%', color: prob > 0.6 ? '#10b981' : '#f59e0b' },
                  { label: 'Win Prob S', val: (probDown * 100).toFixed(1) + '%', color: probDown > 0.6 ? '#10b981' : '#f59e0b' },
                ].map((m) => (
                  <div key={m.label} style={{ background: 'rgba(17, 24, 39, 0.6)', border: '1px solid #374151', borderRadius: '6px', padding: '12px' }}>
                    <div style={{ fontSize: '10px', color: '#9ca3af', textTransform: 'uppercase', marginBottom: '4px' }}>{m.label}</div>
                    <div style={{ fontSize: '16px', fontWeight: '700', color: m.color, fontFamily: 'monospace' }}>{m.val}</div>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: '16px', fontSize: '11px', color: '#9ca3af', fontFamily: 'monospace', lineHeight: '1.6' }}>
                <div>LONG:  SL {slPrice > 0 ? slPrice.toFixed(2) : '—'} | ENTRY {entry > 0 ? entry.toFixed(2) : '—'} | TP {tpPrice > 0 ? tpPrice.toFixed(2) : '—'}</div>
                <div>SHORT: SL {slPriceShort > 0 ? slPriceShort.toFixed(2) : '—'} | ENTRY {entry > 0 ? entry.toFixed(2) : '—'} | TP {tpPriceShort > 0 ? tpPriceShort.toFixed(2) : '—'}</div>
                <div style={{ marginTop: '8px' }}>{getSetupMessage(curPred)}</div>
              </div>
            </div>

            {/* Backtest Results */}
            {curBt && !curBt.error && (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px', marginBottom: '24px' }}>
                  {[
                    { label: 'Total Return', val: curBt.totalReturnPercent > 0 ? `+${curBt.totalReturnPercent.toFixed(2)}%` : curBt.totalReturnPercent.toFixed(2) + '%', color: curBt.totalReturnPercent > 0 ? '#10b981' : '#f87171' },
                    { label: 'Final Capital', val: `$${curBt.finalCapital.toFixed(2)}`, color: '#f9fafb' },
                    { label: 'Profit Factor', val: curBt.profitFactor.toFixed(2), color: '#f9fafb' },
                    { label: 'Win Rate', val: curBt.winRate.toFixed(1) + '%', color: curBt.winRate > 50 ? '#10b981' : '#f59e0b' },
                    { label: 'Max Drawdown', val: `-${curBt.maxDrawdownPercent.toFixed(2)}%`, color: '#f87171' },
                    { label: 'Expectancy R', val: `${curBt.expectancyR.toFixed(3)}R`, color: curBt.expectancyR > 0 ? '#10b981' : '#f87171' },
                    { label: 'Avg R', val: `${curBt.avgR.toFixed(3)}R`, color: '#f9fafb' },
                    { label: 'Sharpe', val: curBt.sharpe.toFixed(2), color: '#f9fafb' },
                    { label: 'Total Trades', val: curBt.totalTrades.toString(), color: '#f9fafb' },
                    { label: 'Avg Bars Held', val: curBt.avgBarsHeld.toString(), color: '#f9fafb' },
                  ].map((m) => (
                    <div key={m.label} style={{ background: 'rgba(31, 41, 55, 0.5)', border: '1px solid #374151', borderRadius: '8px', padding: '14px' }}>
                      <div style={{ fontSize: '10px', color: '#9ca3af', textTransform: 'uppercase', marginBottom: '5px' }}>{m.label}</div>
                      <div style={{ fontSize: '17px', fontWeight: '700', color: m.color, fontFamily: 'monospace' }}>{m.val}</div>
                    </div>
                  ))}
                </div>

                {/* Trade List */}
                <div style={{ background: 'rgba(31, 41, 55, 0.5)', border: '1px solid #374151', borderRadius: '8px', padding: '20px', marginBottom: '24px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                    <h3 style={{ fontSize: '14px', fontWeight: '700', color: '#f9fafb', margin: 0 }}>📋 Trade List ({curBt.totalTrades} trades)</h3>
                    <span style={{ fontSize: '11px', color: '#9ca3af' }}>
                      L={curBt.trades.filter((t: any) => t.side === 'long').length} · S={curBt.trades.filter((t: any) => t.side === 'short').length}
                    </span>
                  </div>
                  <div style={{ overflowX: 'auto', marginBottom: '12px' }}>
                    <table style={{ width: '100%', minWidth: '1000px', borderCollapse: 'collapse', fontSize: '11px' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid #374151' }}>
                          {['#', 'Masuk', 'Keluar', 'Side', 'Entry → Exit', 'R Multiple', 'PnL', 'Exit', 'Bars', 'Saldo'].map((h) => (
                            <th key={h} style={{ padding: '8px 10px', textAlign: 'left', fontSize: '10px', fontWeight: '700', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.5px', whiteSpace: 'nowrap' }}>
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {curBt.trades.slice(-30).map((t: any) => {
                          const exitDate = t.exitTime ? new Date(t.exitTime * 1000).toISOString().slice(0, 10) : '—';
                          const entryDate = new Date(t.entryTime * 1000).toISOString().slice(0, 10);
                          const pnlColor = t.pnl > 0 ? '#10b981' : '#ef4444';
                          const sideColor = t.side === 'long' ? '#10b981' : '#f59e0b';
                          return (
                            <tr key={t.id} style={{ borderBottom: '1px solid #1f2937' }}>
                              <td style={{ padding: '8px 10px', color: '#9ca3af', fontSize: '11px' }}>{t.id}</td>
                              <td style={{ padding: '8px 10px', color: '#9ca3af', fontSize: '11px', whiteSpace: 'nowrap' }}>{entryDate}</td>
                              <td style={{ padding: '8px 10px', color: '#9ca3af', fontSize: '11px', whiteSpace: 'nowrap' }}>{exitDate}</td>
                              <td style={{ padding: '8px 10px', color: sideColor, fontSize: '11px', fontWeight: '600' }}>{t.side === 'long' ? 'LONG' : 'SHORT'}</td>
                              <td style={{ padding: '8px 10px', color: '#9ca3af', fontSize: '11px', whiteSpace: 'nowrap' }}>{t.entryPrice?.toFixed(2)} → {t.exitPrice?.toFixed(2)}</td>
                              <td style={{ padding: '8px 10px', color: t.rMultiple > 0 ? '#10b981' : '#ef4444', fontSize: '11px', fontWeight: '700' }}>{t.rMultiple > 0 ? '+' : ''}{t.rMultiple.toFixed(3)}R</td>
                              <td style={{ padding: '8px 10px', color: pnlColor, fontSize: '11px', fontWeight: '700' }}>{t.pnl > 0 ? '+' : ''}${t.pnl.toFixed(2)}</td>
                              <td style={{ padding: '8px 10px', color: '#9ca3af', fontSize: '11px' }}>{t.exitReason}</td>
                              <td style={{ padding: '8px 10px', color: '#9ca3af', fontSize: '11px' }}>{t.barsHeld}</td>
                              <td style={{ padding: '8px 10px', color: '#f9fafb', fontSize: '11px' }}>{t.pnl > 0 ? '+' : ''}${(curBt.initialCapital + curBt.trades.slice(0, t.id - 1).reduce((a: number, x: any) => a + x.pnl, 0)).toFixed(2)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {curBt.totalTrades > 30 && (
                    <p style={{ fontSize: '11px', color: '#9ca3af', marginTop: '8px' }}>
                      Menampilkan 30 trade terakhir dari {curBt.totalTrades} total.
                    </p>
                  )}
                </div>

                {/* Monte Carlo */}
                {(curBt.trades && curBt.trades.length > 0) && (
                  <div style={{ background: 'rgba(31, 41, 55, 0.5)', border: '1px solid #374151', borderRadius: '8px', padding: '20px', marginBottom: '24px' }}>
                    <h3 style={{ fontSize: '14px', fontWeight: '700', color: '#f9fafb', margin: '0 0 12px 0' }}>🎲 Monte Carlo Bootstrap (300 iterasi)</h3>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '8px' }}>
                      {[
                        { label: 'Peluang Profit', val: '—', color: '#10b981' },
                        { label: 'Persentil 5', val: '—', color: '#f9fafb' },
                        { label: 'Median', val: '—', color: '#f9fafb' },
                        { label: 'Persentil 95', val: '—', color: '#f9fafb' },
                        { label: 'Terburuk', val: '—', color: '#f87171' },
                      ].map((m) => (
                        <div key={m.label} style={{ background: 'rgba(17, 24, 39, 0.6)', border: '1px solid #374151', borderRadius: '6px', padding: '12px' }}>
                          <div style={{ fontSize: '10px', color: '#9ca3af', textTransform: 'uppercase', marginBottom: '4px' }}>{m.label}</div>
                          <div style={{ fontSize: '16px', fontWeight: '700', color: m.color, fontFamily: 'monospace' }}>{m.val}</div>
                        </div>
                      ))}
                    </div>
                    <p style={{ fontSize: '11px', color: '#9ca3af', marginTop: '8px' }}>
                      Monte Carlo per-trade bootstrap memerlukan data return per trade yang tersimpan. Saat ini menampilkan metrik walk-forward di bawah.
                    </p>
                  </div>
                )}

                {/* Walk-forward OOS */}
                <div style={{ background: 'rgba(31, 41, 55, 0.5)', border: '1px solid #374151', borderRadius: '8px', padding: '20px', marginBottom: '24px' }}>
                  <h3 style={{ fontSize: '14px', fontWeight: '700', color: '#f9fafb', margin: '0 0 12px 0' }}>🔄 Walk-Forward Out-of-Sample</h3>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', minWidth: '700px', borderCollapse: 'collapse', fontSize: '11px' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid #374151' }}>
                          {['Jendela', 'Trade', 'Return %', 'PF', 'DD %', 'Expectancy R'].map((h) => (
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
                            <td style={{ padding: '8px 10px', color: (w.oos_totalPnLPercent ?? 0) > 0 ? '#10b981' : '#f87171', fontSize: '11px' }}>{(w.oos_totalPnLPercent ?? 0).toFixed(2)}%</td>
                            <td style={{ padding: '8px 10px', color: '#9ca3af', fontSize: '11px' }}>{(w.oos_pf ?? 0).toFixed(2)}</td>
                            <td style={{ padding: '8px 10px', color: '#f87171', fontSize: '11px' }}>{(w.oos_maxDrawdownPercent ?? 0).toFixed(2)}%</td>
                            <td style={{ padding: '8px 10px', color: '#9ca3af', fontSize: '11px' }}>{(w.oos_expectancyR ?? 0).toFixed(3)}R</td>
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
