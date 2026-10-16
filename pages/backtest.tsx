import React, { useCallback, useState } from 'react';
import Layout from '../components/Layout/Layout';
import { TOP_CRYPTO_SYMBOLS } from '../lib/config';
import { type MonteCarloCombo } from '../lib/algorithms/mcBacktest';

type Combo = MonteCarloCombo;

const INTERVALS: { value: '1h' | '4h' | '1d'; label: string }[] = [
  { value: '1d', label: '1 Hari' },
  { value: '4h', label: '4 Jam' },
  { value: '1h', label: '1 Jam' },
];

export default function BacktestPage() {
  const [asset, setAsset] = useState('ETHUSDT');
  const [customAsset, setCustomAsset] = useState('');
  const [interval, setInterval] = useState<'1h' | '4h' | '1d'>('1d');
  const [bars, setBars] = useState(300);
  const [forwardBars, setForwardBars] = useState(5);
  const [combos, setCombos] = useState<Combo[]>([]);
  const [best, setBest] = useState<Combo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    const symbol = (customAsset.trim() || asset).toUpperCase();
    setLoading(true);
    setError(null);
    setCombos([]);
    setBest(null);
    try {
      const res = await fetch(
        `/api/backtest-mc?assetSymbol=${encodeURIComponent(symbol)}&indexSymbol=BTCUSDT&interval=${interval}&bars=${bars}&forwardBars=${forwardBars}`
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setCombos(data.combos || []);
      setBest(data.best ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Monte Carlo backtest gagal');
    } finally {
      setLoading(false);
    }
  }, [asset, customAsset, interval, bars, forwardBars]);

  const fmtPct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;

  const pfCell = (pf: number) => {
    if (!Number.isFinite(pf) || pf === 0) return '—';
    return pf === Infinity ? '∞' : pf.toFixed(2);
  };

  const equityPath = (eq: { time: number; equity: number }[]) => {
    if (!eq.length) return '';
    const min = Math.min(...eq.map((e) => e.equity));
    const max = Math.max(...eq.map((e) => e.equity));
    const range = max - min || 1;
    const pts = eq.map((e, i) => {
      const x = (i / Math.max(eq.length - 1, 1)) * 100;
      const y = 100 - ((e.equity - min) / range) * 100;
      return `${x},${y}`;
    });
    return pts.join(' ');
  };

  const reason = () => {
    if (!best) return '';
    const b = best;
    const parts = [
      `Sinyal terdeteksi ${b.signalCount}x dalam ${bars} candle.`,
      `Win rate ${b.winRate.toFixed(1)}% dengan return rata-rata ${fmtPct(b.avgFwdReturn)} per sinyal.`,
      `Profit factor ${pfCell(b.profitFactor)}, max drawdown ${b.maxDD.toFixed(1)}%.`,
    ];
    if (b.edge > 0) {
      parts.push('Parameter ini konsisten menghasilkan return positif ke depan — rumus efektif pada aset ini.');
    } else {
      parts.push('Tidak ada kombinasi parameter yang konsisten menguntungkan historis — perhitungan perlu disesuaikan.');
    }
    return parts.join(' ');
  };

  return (
    <Layout>
      <div style={{ padding: '0 24px 40px', maxWidth: '1400px', margin: '0 auto' }}>
        <h2 style={{ fontSize: '18px', fontWeight: '700', color: '#f9fafb', marginBottom: '8px' }}>
          🧪 Backtest Monte Carlo — RS Confluence (Crypto Only)
        </h2>
        <p style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '20px' }}>
          Uji apakah parameter perhitungan di tab Ranking benar-benar efektif. Untuk tiap kombinasi parameter,
          mundur hingga {bars} candle ke belakang di {interval}; di setiap bar skor dihitung dari data hingga bar
          itu (tanpa lookahead). Jika sinyal Buy/Sell nyala, catat return ke depan {forwardBars} candle. Index
          selalu BTCUSDT (crypto only).
        </p>

        <div style={{
          background: '#111827', border: '1px solid #374151', borderRadius: '12px',
          padding: '16px', marginBottom: '20px', display: 'flex', gap: '12px', flexWrap: 'wrap',
          alignItems: 'center',
        }}>
          <div style={{ fontSize: '11px', color: '#6b7280', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.5px', marginRight: '8px' }}>
            Aset
          </div>
          <select
            value={asset}
            onChange={(e) => { setAsset(e.target.value); setCustomAsset(''); }}
            style={{ padding: '7px 10px', background: '#1f2937', border: '1px solid #374151', borderRadius: '6px', color: '#f9fafb', fontSize: '12px', outline: 'none' }}
          >
            {TOP_CRYPTO_SYMBOLS.map((s) => (
              <option key={s} value={s}>{s.replace('USDT', '')}</option>
            ))}
          </select>
          <input
            type="text"
            placeholder="Custom symbol (contoh SUIUSDT)"
            value={customAsset}
            onChange={(e) => setCustomAsset(e.target.value)}
            onBlur={() => { if (customAsset.trim()) setAsset(customAsset.trim().toUpperCase()); }}
            style={{ padding: '7px 10px', background: '#1f2937', border: '1px solid #374151', borderRadius: '6px', color: '#f9fafb', fontSize: '12px', outline: 'none', minWidth: '150px' }}
          />
          <div style={{ fontSize: '11px', color: '#6b7280', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '0 8px' }}>
            Index
          </div>
          <span style={{ fontSize: '12px', color: '#f9fafb', fontWeight: '600' }}>BTCUSDT</span>
          <div style={{ fontSize: '11px', color: '#6b7280', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '0 8px' }}>
            Timeframe
          </div>
          <select
            value={interval}
            onChange={(e) => setInterval(e.target.value as '1h' | '4h' | '1d')}
            style={{ padding: '7px 10px', background: '#1f2937', border: '1px solid #374151', borderRadius: '6px', color: '#f9fafb', fontSize: '12px', outline: 'none' }}
          >
            {INTERVALS.map((it) => (
              <option key={it.value} value={it.value}>{it.label}</option>
            ))}
          </select>
          <div style={{ fontSize: '11px', color: '#6b7280', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '0 8px' }}>
            Candle ke belakang
          </div>
          <input
            type="number" value={bars} onChange={(e) => setBars(parseInt(e.target.value, 10) || 300)}
            min="100" max="600" style={{ width: '70px', padding: '7px 10px', background: '#1f2937', border: '1px solid #374151', borderRadius: '6px', color: '#f9fafb', fontSize: '12px', outline: 'none' }}
          />
          <div style={{ fontSize: '11px', color: '#6b7280', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '0 8px' }}>
            Return ke depan (bar)
          </div>
          <input
            type="number" value={forwardBars} onChange={(e) => setForwardBars(parseInt(e.target.value, 10) || 5)}
            min="1" max="50" style={{ width: '70px', padding: '7px 10px', background: '#1f2937', border: '1px solid #374151', borderRadius: '6px', color: '#f9fafb', fontSize: '12px', outline: 'none' }}
          />
          <button
            onClick={run}
            disabled={loading}
            style={{
              padding: '8px 18px', background: loading ? '#4b5563' : 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
              border: 'none', borderRadius: '8px', color: 'white', fontSize: '12px', fontWeight: '600',
              cursor: loading ? 'not-allowed' : 'pointer',
            }}
          >
            {loading ? 'Menghitung…' : 'Jalankan Monte Carlo'}
          </button>
        </div>

        {error && (
          <div style={{
            padding: '12px 16px', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)',
            borderRadius: '8px', color: '#ef4444', fontSize: '13px', marginBottom: '16px',
          }}>{error}</div>
        )}

        {combos.length > 0 && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', marginBottom: '20px' }}>
              {[
                { label: 'Kombinasi terbaik', value: best ? best.label : '—' },
                { label: 'Sinyal total', value: best ? best.signalCount.toString() : '—' },
                { label: 'Win rate', value: best ? `${best.winRate.toFixed(1)}%` : '—' },
                { label: 'Return rata-rata / sinyal', value: best ? fmtPct(best.avgFwdReturn) : '—' },
              ].map((m) => (
                <div key={m.label} style={{ background: '#111827', border: '1px solid #374151', borderRadius: '8px', padding: '12px 16px' }}>
                  <div style={{ fontSize: '11px', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>{m.label}</div>
                  <div style={{ fontSize: '15px', fontWeight: '700', color: '#f9fafb' }}>{m.value}</div>
                </div>
              ))}
            </div>

            {best && (
              <div style={{ background: '#111827', border: '1px solid #374151', borderRadius: '12px', padding: '16px', marginBottom: '20px', display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: '260px' }}>
                  <h3 style={{ fontSize: '14px', fontWeight: '600', color: '#f9fafb', margin: '0 0 8px 0' }}>Kesimpulan</h3>
                  <p style={{ fontSize: '13px', color: '#9ca3af', lineHeight: '1.6', margin: '0 0 12px 0' }}>{reason()}</p>
                  <p style={{ fontSize: '12px', color: '#6b7280', margin: 0 }}>
                    Parameter: {best.label}. Skor konfluensi dari tab Ranking dihitung dengan bobot RS 40% /
                    tren 35% / sinyal 25%, agregasi 3 timeframe, lalu damping likuiditas. Monte Carlo memverifikasi
                    apakah skor tinggi itu benar-benar diikuti return ke depan.
                  </p>
                </div>
                <div style={{ flex: 1, minWidth: '340px' }}>
                  <h3 style={{ fontSize: '14px', fontWeight: '600', color: '#f9fafb', margin: '0 0 8px 0' }}>Kurva Equity (kombinasi terbaik)</h3>
                  <div style={{ width: '100%', height: '180px', background: '#0b1120', border: '1px solid #374151', borderRadius: '8px', position: 'relative', overflow: 'hidden' }}>
                    <svg width="100%" height="100%" style={{ display: 'block' }}>
                      <polyline
                        points={equityPath(best.equity)}
                        fill="none"
                        stroke="#3b82f6"
                        strokeWidth="2"
                      />
                    </svg>
                    <div style={{ position: 'absolute', left: '10px', top: '8px', fontSize: '11px', color: '#6b7280' }}>
                      Start = 1.00 · End = {best.equity[best.equity.length - 1]?.equity.toFixed(3) ?? '—'}
                    </div>
                    <div style={{ position: 'absolute', left: '10px', bottom: '8px', fontSize: '11px', color: '#6b7280' }}>
                      Max drawdown {best.maxDD.toFixed(1)}%
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div style={{ background: '#111827', border: '1px solid #374151', borderRadius: '12px', overflow: 'hidden' }}>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid #374151' }}>
                <h3 style={{ fontSize: '14px', fontWeight: '600', color: '#f9fafb', margin: 0 }}>
                  Hasil Monte Carlo — diurutkan menurun menurut efekti­vitas (edge = win rate × return/sinyal)
                </h3>
              </div>
              <div className="ah-scroll">
                <table style={{ width: '100%', minWidth: '980px', borderCollapse: 'collapse', fontSize: '12px' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #374151' }}>
                      <th style={{ ...thStyle, width: '40px' }}>#</th>
                      <th style={thStyle}>Parameter (label)</th>
                      <th style={{ ...thStyle, width: '70px' }}>Sinyal</th>
                      <th style={{ ...thStyle, width: '75px' }}>Win Rate</th>
                      <th style={{ ...thStyle, width: '90px' }}>Avg Return</th>
                      <th style={{ ...thStyle, width: '90px' }}>Median Return</th>
                      <th style={{ ...thStyle, width: '80px' }}>Profit Factor</th>
                      <th style={{ ...thStyle, width: '85px' }}>Expectancy</th>
                      <th style={{ ...thStyle, width: '80px' }}>Max DD</th>
                      <th style={{ ...thStyle, width: '80px' }}>Edge</th>
                    </tr>
                  </thead>
                  <tbody>
                    {combos.map((c, i) => {
                      const isBest = best && c.params === best.params;
                      return (
                        <tr
                          key={i}
                          style={{
                            borderBottom: '1px solid #1f2937',
                            background: isBest ? 'rgba(59, 130, 246, 0.1)' : 'transparent',
                          }}
                        >
                          <td style={{ ...tdStyle, fontWeight: '700', color: isBest ? '#3b82f6' : '#9ca3af' }}>{i + 1}</td>
                          <td style={{ ...tdStyle, color: '#f9fafb', fontWeight: isBest ? '700' : '400' }}>{c.label}</td>
                          <td style={{ ...tdStyle, color: '#9ca3af' }}>{c.signalCount}</td>
                          <td style={{ ...tdStyle, color: c.winRate >= 50 ? '#10b981' : '#ef4444' }}>{c.winRate.toFixed(1)}%</td>
                          <td style={{ ...tdStyle, color: c.avgFwdReturn >= 0 ? '#10b981' : '#ef4444' }}>{fmtPct(c.avgFwdReturn)}</td>
                          <td style={{ ...tdStyle, color: c.medianFwdReturn >= 0 ? '#10b981' : '#ef4444' }}>{fmtPct(c.medianFwdReturn)}</td>
                          <td style={{ ...tdStyle, color: '#f59e0b' }}>{pfCell(c.profitFactor)}</td>
                          <td style={{ ...tdStyle, color: c.expectancy >= 0 ? '#10b981' : '#ef4444' }}>{fmtPct(c.expectancy)}</td>
                          <td style={{ ...tdStyle, color: '#ef4444' }}>{c.maxDD.toFixed(1)}%</td>
                          <td style={{ ...tdStyle, fontWeight: '700', color: c.edge > 0 ? '#10b981' : '#9ca3af' }}>{c.edge.toFixed(4)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ padding: '10px 16px', fontSize: '11px', color: '#6b7280' }}>
                Edge = win rate × return rata-rata per sinyal. Semakin tinggi, semakin konsisten parameter itu
                menghasilkan keuntungan ke depan. Ini adalah validasi historis, bukan jaminan performa di masa depan,
                dan bukan rekomendasi investasi — crypto sangat volatil.
              </div>
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}

const thStyle: React.CSSProperties = {
  padding: '10px 12px', textAlign: 'left', fontSize: '10px', fontWeight: '700',
  color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.5px',
};

const tdStyle: React.CSSProperties = {
  padding: '10px 12px', color: '#9ca3af', fontSize: '12px',
};
