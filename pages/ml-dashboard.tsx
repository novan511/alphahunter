import React, { useEffect, useState } from 'react';
import Layout from '../components/Layout/Layout';

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
  timestamp: number;
  error?: string;
}

export default function MlDashboard() {
  const [meta, setMeta] = useState<MlMeta | null>(null);
  const [predict, setPredict] = useState<MlPredict | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const SYMBOL = 'SOLUSDT';
  const INTERVAL = '4h';

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        // Load meta file directly from public path (bundled at build)
        const metaRes = await fetch(`/ml/models/${SYMBOL}_${INTERVAL}.meta.json`);
        if (metaRes.ok) {
          const m: MlMeta = await metaRes.json();
          setMeta(m);
        } else {
          setError(`Model meta not found for ${SYMBOL}_${INTERVAL}. Train first.`);
        }

        // Load latest prediction from API
        const predRes = await fetch(`/api/ml-predict?symbol=${SYMBOL}&interval=${INTERVAL}`);
        if (predRes.ok) {
          const p: MlPredict = await predRes.json();
          setPredict(p);
        } else {
          setError(`Prediction API failed: ${predRes.status}`);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        if (!cancelled) setLoading(false);
      }

      return () => { cancelled = true; };
    }

    load();
  }, [SYMBOL, INTERVAL]);

  if (loading) {
    return (
      <Layout>
        <div style={{ padding: '40px 24px', maxWidth: '1400px', margin: '0 auto' }}>
          <h2 style={{ fontSize: '20px', fontWeight: '700', color: '#f9fafb', marginBottom: '16px' }}>
            🤖 ML Model Dashboard
          </h2>
          <p style={{ color: '#9ca3af' }}>Memuat model dan prediksi terbaru…</p>
        </div>
      </Layout>
    );
  }

  if (error && !meta && !predict) {
    return (
      <Layout>
        <div style={{ padding: '40px 24px', maxWidth: '1400px', margin: '0 auto' }}>
          <h2 style={{ fontSize: '20px', fontWeight: '700', color: '#f9fafb', marginBottom: '16px' }}>
            🤖 ML Model Dashboard
          </h2>
          <div style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '8px', padding: '16px', color: '#fca5a5' }}>
            {error}
          </div>
          <p style={{ marginTop: '12px', color: '#9ca3af', fontSize: '12px' }}>
            Jalankan training dulu: <code>python ml/train/train_model.py --symbol SOLUSDT --interval 4h</code>
          </p>
        </div>
      </Layout>
    );
  }

  const oos = meta?.oos_metrics || {};
  const imp = meta?.feature_importance || {};
  const sortedImp = Object.entries(imp)
    .sort(([, a], [, b]) => (b as number) - (a as number))
    .slice(0, 8);

  return (
    <Layout>
      <div style={{ padding: '24px', maxWidth: '1400px', margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
          <div>
            <h2 style={{ fontSize: '20px', fontWeight: '700', color: '#f9fafb', margin: 0 }}>🤖 ML Model Dashboard</h2>
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

        {/* Status banner */}
        <div style={{ display: 'flex', gap: '12px', marginBottom: '24px', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: '200px', background: 'rgba(31, 41, 55, 0.5)', border: '1px solid #374151', borderRadius: '8px', padding: '16px' }}>
            <div style={{ fontSize: '11px', color: '#9ca3af', textTransform: 'uppercase', marginBottom: '8px' }}>Model</div>
            <div style={{ fontSize: '15px', fontWeight: '600', color: '#f9fafb' }}>{meta?.symbol} {meta?.interval}</div>
            <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '4px' }}>
              {meta?.gates_passed ? '✅ Gates lolos' : '⚠️ Gates gagal'}
            </div>
            <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '4px' }}>
              Terlatih: {meta?.trained_at ? new Date(meta.trained_at).toLocaleString() : '—'}
            </div>
          </div>

          <div style={{ flex: 1, minWidth: '200px', background: 'rgba(31, 41, 55, 0.5)', border: '1px solid #374151', borderRadius: '8px', padding: '16px' }}>
            <div style={{ fontSize: '11px', color: '#9ca3af', textTransform: 'uppercase', marginBottom: '8px' }}>Prediksi Terbaru</div>
            <div style={{ fontSize: '15px', fontWeight: '600', color: predict?.signal === 'long' ? '#10b981' : '#f59e0b' }}>
              {predict?.signal === 'long' ? '🟢 LONG' : '⚪ FLAT'}
            </div>
            <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '4px' }}>
              P(naik): {(predict?.probabilityUp ?? 0.5 * 100).toFixed(1)}%
            </div>
            <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '4px' }}>
              Regime: {predict?.regimePass ? '✅ Bull' : '❌ Tidak lolos'}
            </div>
          </div>

          <div style={{ flex: 1, minWidth: '200px', background: 'rgba(31, 41, 55, 0.5)', border: '1px solid #374151', borderRadius: '8px', padding: '16px' }}>
            <div style={{ fontSize: '11px', color: '#9ca3af', textTransform: 'uppercase', marginBottom: '8px' }}>Sumber</div>
            <div style={{ fontSize: '15px', fontWeight: '600', color: predict?.source === 'model' ? '#10b981' : '#f59e0b' }}>
              {predict?.source === 'model' ? '🤖 Model' : '⚠️ Fallback'}
            </div>
            <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '4px' }}>
              Forward bars: {meta?.forward_bars ?? '—'}
            </div>
            <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '4px' }}>
              Prob threshold: {(meta?.prob_threshold ?? 0.55 * 100).toFixed(0)}%
            </div>
          </div>
        </div>

        {/* OOS Metrics */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', marginBottom: '24px' }}>
          {[['Sharpe (OOS)', oos.oos_sharpe, '0.00'], ['Profit Factor', oos.oos_pf, '0.00'], ['Max Drawdown', oos.oos_maxdd, '0.00%'], ['Win Rate', oos.oos_winrate, '0.00%'], ['Signals Taken', `${oos.oos_signals_taken}/${oos.oos_trades}`, ''], ['Avg Confidence', oos.oos_avg_confidence, '0.00']].map(([label, val, fmt]) => (
            <div key={label} style={{ background: 'rgba(31, 41, 55, 0.5)', border: '1px solid #374151', borderRadius: '8px', padding: '16px' }}>
              <div style={{ fontSize: '11px', color: '#9ca3af', textTransform: 'uppercase', marginBottom: '6px' }}>{label}</div>
              <div style={{ fontSize: '18px', fontWeight: '700', color: '#f9fafb', fontFamily: 'monospace' }}>{typeof val === 'number' ? val.toFixed(fmt.replace('%', '').replace('0.', '0.').length > 1 ? 2 : 0) : val}</div>
            </div>
          ))}
        </div>

        {/* Feature Importances */}
        <div style={{ background: 'rgba(31, 41, 55, 0.5)', border: '1px solid #374151', borderRadius: '8px', padding: '20px', marginBottom: '24px' }}>
          <h3 style={{ fontSize: '14px', fontWeight: '700', color: '#f9fafb', margin: '0 0 12px 0' }}>Feature Importances (top 8)</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {sortedImp.map(([name, val]) => {
              const pct = ((val as number) / Object.values(imp).reduce((a, b) => a + (b as number), 0) * 100).toFixed(1);
              return (
                <div key={name} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ fontSize: '12px', color: '#9ca3af', width: '140px' }}>{name}</span>
                  <div style={{ flex: 1, height: '6px', background: '#374151', borderRadius: '3px', overflow: 'hidden' }}>
                    <div style={{ height: '100%', background: 'linear-gradient(90deg, #3b82f6, #8b5cf6)', width: `${pct}%` }}></div>
                  </div>
                  <span style={{ fontSize: '11px', color: '#9ca3af', fontFamily: 'monospace', width: '40px', textAlign: 'right' }}>{pct}%</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Raw JSON */}
        <div style={{ background: '#111827', border: '1px solid #374151', borderRadius: '8px', padding: '16px', fontSize: '11px', color: '#9ca3af', fontFamily: 'monospace', overflowX: 'auto' }}>
          <div style={{ fontSize: '12px', color: '#f9fafb', fontWeight: '600', marginBottom: '8px' }}">Meta (raw)</div>
          <div>{JSON.stringify(meta, null, 2)}</div>
        </div>
      </div>
    </Layout>
  );
}
