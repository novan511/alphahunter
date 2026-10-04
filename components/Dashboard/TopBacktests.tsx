import React from 'react';
import { BacktestResult } from '../../lib/types';

export interface TopBacktestRow {
  asset: string;
  score: number;
  signal: string;
  result: BacktestResult | null;
}

interface TopBacktestsProps {
  rows: TopBacktestRow[];
  running: boolean;
  done: number;
  total: number;
  onRun: () => void;
  disabled: boolean;
}

/**
 * "Are the top calls historically real?" — runs the backtest engine over the
 * leading signals as a set instead of making the user click through them one
 * by one, then shows which ones actually held up.
 *
 * Deliberately separate from BacktestResults: that panel describes *one*
 * selected asset in depth (trades, equity, alpha), this one compares *several*
 * at a glance.
 */
export default function TopBacktests({
  rows,
  running,
  done,
  total,
  onRun,
  disabled,
}: TopBacktestsProps) {
  const finished = rows.filter((r) => r.result !== null);
  const profitable = finished.filter((r) => (r.result as BacktestResult).totalPnL > 0);

  return (
    <div style={{
      background: '#111827',
      borderRadius: '12px',
      border: '1px solid #374151',
      overflow: 'hidden',
      marginBottom: '20px',
    }}>
      <div className="ah-panel-head" style={{
        padding: '12px 16px',
        borderBottom: '1px solid #374151',
      }}>
        <div>
          <h3 style={{ fontSize: '14px', fontWeight: '600', color: '#f9fafb', margin: 0 }}>
            🧪 Backtest Top Sinyal
          </h3>
          <p style={{ fontSize: '10px', color: '#6b7280', margin: 0 }}>
            Uji 5 sinyal confluence tertinggi lewat 500 bar terakhir
          </p>
        </div>
        <div className="ah-chip-row">
          {finished.length > 0 && !running && (
            <span style={{
              padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
              background: profitable.length > finished.length / 2
                ? 'rgba(16,185,129,0.14)' : 'rgba(239,68,68,0.14)',
              border: `1px solid ${profitable.length > finished.length / 2
                ? 'rgba(16,185,129,0.35)' : 'rgba(239,68,68,0.35)'}`,
              color: profitable.length > finished.length / 2 ? '#10b981' : '#ef4444',
            }}>
              {profitable.length}/{finished.length} profitable
            </span>
          )}
          <button
            onClick={onRun}
            disabled={disabled || running}
            className="ah-action"
            style={{
              padding: '6px 14px',
              border: '1px solid rgba(139,92,246,0.45)',
              borderRadius: '6px',
              background: running ? '#1f2937' : 'rgba(139,92,246,0.14)',
              color: running ? '#6b7280' : '#a78bfa',
              fontSize: '11px',
              fontWeight: 600,
              cursor: disabled || running ? 'not-allowed' : 'pointer',
              opacity: disabled && !running ? 0.5 : 1,
              whiteSpace: 'nowrap',
            }}
          >
            {running ? `⏳ ${done}/${total}` : '▶ Jalankan'}
          </button>
        </div>
      </div>

      {running && (
        <div style={{ height: '3px', background: '#1f2937' }}>
          <div style={{
            width: `${total > 0 ? (done / total) * 100 : 0}%`,
            height: '100%',
            background: 'linear-gradient(90deg, #3b82f6, #8b5cf6)',
            transition: 'width 0.3s ease',
          }} />
        </div>
      )}

      {rows.length === 0 && !running && (
        <div style={{ padding: '16px', fontSize: '11px', color: '#6b7280', lineHeight: 1.6 }}>
          {disabled
            ? 'Belum ada sinyal non-neutral untuk diuji — jalankan scan dulu.'
            : 'Belum dijalankan. Tekan “Jalankan” untuk menguji 5 sinyal teratas: hasilnya menunjukkan mana yang bertahan di 500 bar terakhir, bukan hanya skor tertinggi hari ini.'}
        </div>
      )}

      {rows.length > 0 && (
        <div className="ah-scroll">
          <table style={{ width: '100%', minWidth: '520px', borderCollapse: 'collapse', fontSize: '11px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #374151' }}>
                <th style={thStyle}>Asset</th>
                <th style={thStyle}>Score</th>
                <th style={thStyle}>P&L</th>
                <th style={thStyle}>Win Rate</th>
                <th style={thStyle}>Profit Factor</th>
                <th style={thStyle}>Sharpe</th>
                <th style={thStyle}>Max DD</th>
                <th style={thStyle}>Trades</th>
                <th style={thStyle}>vs B&H</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.asset} style={{ borderBottom: '1px solid #1f2937' }}>
                  <td style={{ ...tdStyle, fontWeight: 600, color: '#f9fafb', whiteSpace: 'nowrap' }}>
                    {r.asset.replace('USDT', '')}
                  </td>
                  <td style={tdStyle}>{r.score}</td>
                  {r.result ? (
                    <>
                      <NumCell v={r.result.totalPnLPercent} suffix="%" />
                      <NumCell v={r.result.winRate} suffix="%" good={50} />
                      <NumCell
                        v={r.result.profitFactor === Infinity ? 999 : r.result.profitFactor}
                        fixed={2}
                        good={1.5}
                        bad={1}
                      />
                      <NumCell v={r.result.sharpeRatio} fixed={2} good={1} bad={0} />
                      <td style={{ ...tdStyle, color: '#ef4444' }}>
                        {r.result.maxDrawdownPercent}%
                      </td>
                      <td style={tdStyle}>{r.result.totalTrades}</td>
                      <NumCell
                        v={r.result.alpha}
                        suffix="%"
                        good={0}
                        bad={-Infinity}
                      />
                    </>
                  ) : (
                    <td colSpan={7} style={{ ...tdStyle, color: '#6b7280', fontStyle: 'italic' }}>
                      gagal diambil
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ padding: '8px 16px', fontSize: '9px', color: '#4b5563', lineHeight: 1.6 }}>
        Backtest memakai parameter yang sama dengan skor scan. Hasil lampau bukan jaminan —
        ini penyaring kualitas sinyal, bukan prediksi.
      </div>
    </div>
  );
}

function NumCell({
  v,
  suffix = '',
  fixed,
  good,
  bad,
}: {
  v: number;
  suffix?: string;
  fixed?: number;
  good?: number;
  bad?: number;
}) {
  const ok = good !== undefined && v >= good;
  const no = bad !== undefined && v < bad;
  const color = ok ? '#10b981' : no ? '#ef4444' : '#9ca3af';
  const shown = fixed !== undefined ? v.toFixed(fixed) : v.toFixed(2);
  return (
    <td style={{ ...tdStyle, color, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {v > 0 && !String(shown).startsWith('-') ? '+' : ''}
      {shown === '999.00' ? '∞' : shown}
      {suffix}
    </td>
  );
}

const thStyle: React.CSSProperties = {
  padding: '8px 10px',
  textAlign: 'left',
  fontSize: '9px',
  fontWeight: '700',
  color: '#6b7280',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  whiteSpace: 'nowrap',
};

const tdStyle: React.CSSProperties = {
  padding: '8px 10px',
  color: '#9ca3af',
  fontSize: '11px',
};
