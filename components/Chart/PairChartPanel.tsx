import React, { useEffect, useMemo, useState } from 'react';
import RatioChart from './RatioChart';
import type { RatioResponse } from '../../pages/api/ratio';

interface PairChartPanelProps {
  base: string;
  quote: string;
  interval: string;
  windowBars: number;
  /** The matrix cell value for this pair over the matrix window. */
  windowChange: number;
  onClose: () => void;
}

function short(sym: string): string {
  return sym.split(':').pop()!.replace(/USDT$|USDC$/, '');
}

/**
 * One pair, one chart: base/quote with the matrix number alongside it.
 *
 * The panel shows two scopes and labels both, because they answer different
 * questions: the matrix window ("who won lately") and the chart range
 * ("is the trend still running"). Conflating them is how a fresh number gets
 * read as a durable trend.
 */
export default function PairChartPanel({
  base,
  quote,
  interval,
  windowBars,
  windowChange,
  onClose,
}: PairChartPanelProps) {
  const [data, setData] = useState<RatioResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const limit = Math.min(Math.max(windowBars * 4, 120), 400);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    const qs = new URLSearchParams({ base, quote, interval, limit: String(limit) });
    fetch(`/api/ratio?${qs.toString()}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        return (await res.json()) as RatioResponse;
      })
      .then((body) => {
        if (!cancelled) setData(body);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'gagal memuat chart');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [base, quote, interval, limit]);

  const read = useMemo(() => {
    if (!data || data.ratio.length < 21) return null;
    const last = data.ratio[data.ratio.length - 1];
    const ma20 = data.ratio.slice(-20).reduce((s, x) => s + x, 0) / 20;
    const aboveMA = last >= ma20;
    const dir = data.change > 1 ? 'menguat' : data.change < -1 ? 'melemah' : 'sideways';
    return { last, ma20, aboveMA, dir };
  }, [data]);

  const up = (data?.change ?? 0) >= 0;

  return (
    <div style={{
      background: '#0b1220',
      border: `1px solid ${up ? 'rgba(16,185,129,0.35)' : 'rgba(239,68,68,0.35)'}`,
      borderRadius: '10px',
      overflow: 'hidden',
      marginBottom: '18px',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '10px',
        padding: '10px 14px',
        borderBottom: '1px solid #1f2937',
        flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '14px', fontWeight: 800, color: '#f9fafb' }}>
            {short(base)} <span style={{ color: '#6b7280', fontWeight: 400 }}>/</span> {short(quote)}
          </span>
          {data && (
            <span style={{
              fontSize: '12px',
              fontWeight: 700,
              color: up ? '#10b981' : '#ef4444',
              fontVariantNumeric: 'tabular-nums',
            }}>
              {data.change >= 0 ? '+' : ''}{data.change.toFixed(2)}%
            </span>
          )}
          <span style={{ fontSize: '11px', color: '#6b7280' }}>
            chart {interval} × {data?.bars ?? '…'} · matrix {interval} × {windowBars}:{' '}
            <b style={{ color: '#9ca3af' }}>
              {windowChange >= 0 ? '+' : ''}{windowChange.toFixed(2)}%
            </b>
          </span>
        </div>
        <button
          onClick={onClose}
          aria-label="Tutup chart pair"
          style={{
            background: 'transparent',
            border: '1px solid #374151',
            borderRadius: '6px',
            color: '#9ca3af',
            fontSize: '11px',
            padding: '3px 10px',
            cursor: 'pointer',
          }}
        >
          ✕ tutup
        </button>
      </div>

      {loading && (
        <div style={{ padding: '40px', textAlign: 'center', color: '#6b7280', fontSize: '12px' }}>
          Mengambil {short(base)}/{short(quote)}…
        </div>
      )}

      {error && (
        <div style={{ padding: '20px', color: '#fca5a5', fontSize: '12px' }}>{error}</div>
      )}

      {data && (
        <>
          <RatioChart times={data.times} ratio={data.ratio} up={up} />
          {read && (
            <div style={{ padding: '10px 14px', borderTop: '1px solid #1f2937', fontSize: '11px', color: '#9ca3af' }}>
              {short(base)} {read.dir} terhadap {short(quote)} sebesar{' '}
              <b style={{ color: up ? '#10b981' : '#ef4444' }}>
                {data.change >= 0 ? '+' : ''}{data.change.toFixed(2)}%
              </b>{' '}
              dalam {data.bars} bar. Ratio {read.aboveMA ? 'di atas' : 'di bawah'} MA20 (
              {read.ma20.toFixed(2)}) —{' '}
              {read.aboveMA
                ? 'momentum jangka pendek masih searah tren.'
                : 'momentum jangka pendek berbalik — tren melemah walau total masih ' + (up ? 'positif.' : 'negatif.')}
              {' '}Garis 100 = titik awal: di atasnya berarti {short(base)} unggul sejak awal periode.
            </div>
          )}
        </>
      )}
    </div>
  );
}
