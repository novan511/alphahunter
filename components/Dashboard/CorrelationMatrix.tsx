import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CorrMatrix, CoinProfile, classifyStrength } from '../../lib/algorithms/correlationMatrix';
import PairChartPanel from '../Chart/PairChartPanel';

interface CorrelationMatrixProps {
  /** Currently selected asset from the rest of the dashboard, e.g. "SOLUSDT". */
  selectedAsset?: string | null;
}

/** Default basket. Chosen for liquidity plus narrative spread. */
export const DEFAULT_PANEL = [
  'binance:BTCUSDT',
  'binance:ETHUSDT',
  'binance:SOLUSDT',
  'binance:XRPUSDT',
  'binance:SUIUSDT',
  'hyperliquid:HYPE',
];

/** Offered for the add-coin picker. Anything in here joins all pairwise cells. */
export const CANDIDATE_PANEL = [
  'binance:BTCUSDT',
  'binance:ETHUSDT',
  'binance:SOLUSDT',
  'binance:XRPUSDT',
  'binance:SUIUSDT',
  'binance:BNBUSDT',
  'binance:AVAXUSDT',
  'binance:LINKUSDT',
  'binance:DOGEUSDT',
  'binance:ADAUSDT',
  'binance:DOTUSDT',
  'binance:NEARUSDT',
  'binance:ARBUSDT',
  'binance:APTUSDT',
  'binance:INJUSDT',
  'hyperliquid:HYPE',
];

const INTERVALS = ['1h', '4h', '1d'] as const;
const WINDOWS = [
  { bars: 30, label: '30 bar' },
  { bars: 60, label: '60 bar' },
  { bars: 90, label: '90 bar' },
] as const;

function short(sym: string): string {
  return sym.split(':').pop()!.replace(/USDT$|USDC$/, '');
}

/** Map an rs percentage to a background colour. Saturates past 15%. */
function rsColor(rs: number): string {
  const v = Math.max(-15, Math.min(15, rs));
  const t = v / 15;
  if (t >= 0) {
    const a = 0.08 + t * 0.55;
    return `rgba(16, 185, 129, ${a.toFixed(3)})`;
  }
  const a = 0.08 + Math.abs(t) * 0.55;
  return `rgba(239, 68, 68, ${a.toFixed(3)})`;
}

/** Map a correlation to a muted blue-grey scale. */
function corrColor(c: number): string {
  const t = Math.max(-1, Math.min(1, c));
  if (t >= 0) return `rgba(59, 130, 246, ${(t * 0.6).toFixed(3)})`;
  return `rgba(239, 68, 68, ${(Math.abs(t) * 0.5).toFixed(3)})`;
}

function fmtPct(x: number): string {
  return `${x > 0 ? '+' : ''}${x.toFixed(2)}%`;
}

function fmtSigned(x: number): string {
  return `${x > 0 ? '+' : ''}${x.toFixed(2)}`;
}

export default function CorrelationMatrix({ selectedAsset }: CorrelationMatrixProps) {
  const [symbols, setSymbols] = useState<string[]>(DEFAULT_PANEL);
  const [interval, setInterval_] = useState<string>('4h');
  const [windowBars, setWindowBars] = useState<number>(30);
  const [matrix, setMatrix] = useState<CorrMatrix | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'strength' | 'corr'>('strength');
  const [hover, setHover] = useState<{ i: number; j: number } | null>(null);
  const [pair, setPair] = useState<{ base: string; quote: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({
        symbols: symbols.join(','),
        interval,
        window: String(windowBars),
      });
      const res = await fetch(`/api/correlation?${qs.toString()}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      setMatrix((await res.json()) as CorrMatrix);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'gagal memuat matrix');
      setMatrix(null);
    } finally {
      setLoading(false);
    }
  }, [symbols, interval, windowBars]);

  useEffect(() => {
    void load();
  }, [load]);

  const available = CANDIDATE_PANEL.filter((s) => !symbols.includes(s));

  const addSymbol = (sym: string) => {
    if (symbols.includes(sym) || symbols.length >= 12) return;
    setSymbols((prev) => [...prev, sym]);
  };

  const removeSymbol = (sym: string) => {
    if (symbols.length <= 2) return;
    setSymbols((prev) => prev.filter((s) => s !== sym));
  };

  // Highlight the row/column of the coin selected elsewhere on the page.
  const selectedIdx = useMemo(() => {
    if (!matrix || !selectedAsset) return -1;
    const want = selectedAsset.toUpperCase();
    return matrix.symbols.findIndex((s) => short(s).toUpperCase() === want.replace(/USDT$|USDC$/, ''));
  }, [matrix, selectedAsset]);

  const sorted = useMemo(() => {
    if (!matrix) return [];
    return [...matrix.coins].sort((a, b) => a.dominanceRank - b.dominanceRank);
  }, [matrix]);

  const leaders = sorted.filter((c) => {
    const v = classifyStrength(c);
    return v.label === 'LEAD' || v.label === 'STRONG';
  });
  const laggards = sorted.filter((c) => {
    const v = classifyStrength(c);
    return v.label === 'LAGGARD' || v.label === 'WEAK';
  });

  const panel: React.CSSProperties = {
    background: '#111827',
    borderRadius: '12px',
    border: '1px solid #374151',
    overflow: 'hidden',
  };

  const head: React.CSSProperties = {
    padding: '12px 16px',
    borderBottom: '1px solid #374151',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: '12px',
  };

  const cellStyle = (fill: string, dim: boolean): React.CSSProperties => ({
    background: fill,
    padding: '7px 4px',
    textAlign: 'center',
    fontSize: '11px',
    fontVariantNumeric: 'tabular-nums',
    border: '1px solid #1f2937',
    opacity: dim ? 0.32 : 1,
    cursor: 'pointer',
    transition: 'opacity 120ms ease',
    whiteSpace: 'nowrap',
  });

  return (
    <div style={panel}>
      <div style={head}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <h3 style={{ fontSize: '14px', fontWeight: '600', color: '#f9fafb', margin: 0 }}>
            Pairwise Strength Matrix
          </h3>
          {loading && <span style={{ fontSize: '11px', color: '#6b7280' }}>memuat…</span>}
        </div>

        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: '2px' }}>
            {INTERVALS.map((it) => (
              <button
                key={it}
                onClick={() => setInterval_(it)}
                style={toggleStyle(interval === it)}
              >
                {it}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '2px' }}>
            {WINDOWS.map((w) => (
              <button
                key={w.bars}
                onClick={() => setWindowBars(w.bars)}
                style={toggleStyle(windowBars === w.bars)}
              >
                {w.label}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '2px' }}>
            <button onClick={() => setView('strength')} style={toggleStyle(view === 'strength')}>
              Strength
            </button>
            <button onClick={() => setView('corr')} style={toggleStyle(view === 'corr')}>
              Corr
            </button>
          </div>
          <button onClick={() => void load()} style={{ ...toggleStyle(false), cursor: 'pointer' }}>
            Refresh
          </button>
        </div>
      </div>

      <div style={{ padding: '16px' }}>
        {error && (
          <div style={{
            background: 'rgba(239,68,68,0.1)',
            border: '1px solid rgba(239,68,68,0.3)',
            borderRadius: '8px',
            padding: '12px',
            color: '#fca5a5',
            fontSize: '12px',
          }}>
            {error}
          </div>
        )}

        {!matrix && !error && (
          <div style={{ color: '#6b7280', fontSize: '12px', padding: '24px', textAlign: 'center' }}>
            {loading ? 'Mengambil candles…' : 'Belum ada data.'}
          </div>
        )}

        {matrix && (
          <>
            {/* Basket-level read */}
            <div style={{
              display: 'flex',
              gap: '16px',
              flexWrap: 'wrap',
              fontSize: '11px',
              color: '#9ca3af',
              marginBottom: '14px',
            }}>
              <span>
                window <b style={{ color: '#f9fafb' }}>{matrix.interval} × {matrix.bars}</b>
              </span>
              <span>
                korelasi rata-rata{' '}
                <b style={{ color: basketCorrColor(matrix.basketCorr) }}>
                  {matrix.basketCorr.toFixed(2)}
                </b>
                {matrix.basketCorr > 0.8 && ' — semua bergerak serempak, rotasi antar-coin terbatas'}
              </span>
              <span>
                update <b style={{ color: '#f9fafb' }}>{new Date(matrix.generatedAt).toLocaleTimeString()}</b>
              </span>
            </div>

            {/* Matrix */}
            <div style={{ overflowX: 'auto', marginBottom: '18px' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: matrix.symbols.length * 78 + 96 }}>
                <thead>
                  <tr>
                    <th style={labelCellStyle} />
                    {matrix.symbols.map((s, i) => (
                      <th key={s} style={{ ...labelCellStyle, color: i === selectedIdx ? '#3b82f6' : '#9ca3af' }}>
                        {short(s)}
                      </th>
                    ))}
                    <th style={{ ...labelCellStyle, color: '#6b7280' }} title="Rata-rata kekuatan vs seluruh basket">dom</th>
                  </tr>
                </thead>
                <tbody>
                  {matrix.symbols.map((rowSym, i) => (
                    <tr key={rowSym}>
                      <td style={{ ...labelCellStyle, color: i === selectedIdx ? '#3b82f6' : '#e5e7eb', fontWeight: 600 }}>
                        {short(rowSym)}
                      </td>
                      {matrix.symbols.map((colSym, j) => {
                        if (i === j) {
                          return (
                            <td key={colSym} style={cellStyle('#0b1220', false)}>
                              <span style={{ color: '#374151' }}>—</span>
                            </td>
                          );
                        }
                        const val = view === 'strength' ? matrix.rs[i][j] : matrix.corr[i][j];
                        const fill = view === 'strength' ? rsColor(val) : corrColor(val);
                        const isHover = hover?.i === i && hover?.j === j;
                        const isPairOpen =
                          pair !== null &&
                          pair.base === matrix.symbols[i] &&
                          pair.quote === matrix.symbols[j];
                        return (
                          <td
                            key={colSym}
                            role="button"
                            tabIndex={0}
                            aria-label={`Chart ${short(rowSym)} terhadap ${short(colSym)}`}
                            style={{
                              ...cellStyle(fill, selectedIdx >= 0 && selectedIdx !== i && selectedIdx !== j),
                              outline: isPairOpen
                                ? '2px solid #10b981'
                                : isHover
                                  ? '2px solid #3b82f6'
                                  : 'none',
                            }}
                            onMouseEnter={() => setHover({ i, j })}
                            onMouseLeave={() => setHover(null)}
                            onClick={() => setPair({ base: matrix.symbols[i], quote: matrix.symbols[j] })}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                setPair({ base: matrix.symbols[i], quote: matrix.symbols[j] });
                              }
                            }}
                            title={
                              view === 'strength'
                                ? `${short(rowSym)} ${fmtPct(val)} vs ${short(colSym)} — klik untuk chart`
                                : `corr ${fmtSigned(val)} · β ${fmtSigned(matrix.beta[i][j])} — klik untuk chart`
                            }
                          >
                            <span style={{ color: '#e5e7eb', fontWeight: 500 }}>
                              {view === 'strength' ? fmtPct(val) : fmtSigned(val)}
                            </span>
                          </td>
                        );
                      })}
                      <td style={{ ...cellStyle('#0b1220', false), fontWeight: 700, color: dominanceTone(matrix.coins[i].dominance) }}>
                        {fmtPct(matrix.coins[i].dominance)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '16px' }}>
              {view === 'strength'
                ? 'Setiap sel = strength coin baris dibanding coin kolom, dihitung dari selisih log-return. +5% berarti baris unggul 5% lebih dari kolom. Klik sel mana pun untuk chart ratio-nya.'
                : 'Korelasi return berpasangan. β menunjukkan seberapa besar coin baris bergerak terhadap 1 movement coin kolom. Klik sel mana pun untuk chart ratio-nya.'}
            </div>

            {pair && matrix.symbols.includes(pair.base) && matrix.symbols.includes(pair.quote) && (
              <PairChartPanel
                base={pair.base}
                quote={pair.quote}
                interval={matrix.interval}
                windowBars={matrix.window}
                windowChange={matrix.rs[matrix.symbols.indexOf(pair.base)][matrix.symbols.indexOf(pair.quote)]}
                onClose={() => setPair(null)}
              />
            )}

            {/* Per-coin read */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '10px' }}>
              {sorted.map((c) => {
                const v = classifyStrength(c);
                const stretched = c.extensionZ >= 2;
                return (
                  <div key={c.symbol} style={{
                    background: '#0b1220',
                    border: `1px solid ${stretched ? '#f59e0b' : '#1f2937'}`,
                    borderRadius: '8px',
                    padding: '10px 12px',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                      <span style={{ fontSize: '13px', fontWeight: 700, color: '#f9fafb' }}>
                        {short(c.symbol)}
                      </span>
                      <span style={{
                        fontSize: '10px',
                        fontWeight: 700,
                        color: v.tone,
                        border: `1px solid ${v.tone}55`,
                        borderRadius: '4px',
                        padding: '1px 6px',
                      }}>
                        {v.label}
                      </span>
                    </div>
                    <Row k="dominance" v={fmtPct(c.dominance)} tone={dominanceTone(c.dominance)} />
                    <Row k="ret" v={fmtPct(c.totalReturn)} tone={c.totalReturn >= 0 ? '#10b981' : '#ef4444'} />
                    <Row k="vol" v={`${c.vol.toFixed(2)}%`} tone="#9ca3af" />
                    <Row k="β basket" v={fmtSigned(c.basketBeta)} tone="#9ca3af" />
                    <Row
                      k="extension"
                      v={fmtSigned(c.extensionZ) + 'σ'}
                      tone={stretched ? '#f59e0b' : '#6b7280'}
                    />
                    <div style={{ fontSize: '10px', color: v.tone, marginTop: '5px' }}>{v.note}</div>
                  </div>
                );
              })}
            </div>

            {/* Action summary */}
            {(leaders.length > 0 || laggards.length > 0) && (
              <div style={{
                marginTop: '16px',
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                gap: '12px',
              }}>
                <VerdictBox
                  title="Kuat — kandidat masuk"
                  tone="#10b981"
                  symbols={leaders.map((c) => c.symbol)}
                  matrix={matrix}
                />
                <VerdictBox
                  title="Lemah — kandidat keluar"
                  tone="#ef4444"
                  symbols={laggards.map((c) => c.symbol)}
                  matrix={matrix}
                />
              </div>
            )}
          </>
          )}
      </div>

      {/* Basket controls */}
      <div style={{
        padding: '12px 16px',
        borderTop: '1px solid #374151',
        display: 'flex',
        gap: '8px',
        alignItems: 'center',
        flexWrap: 'wrap',
      }}>
        <span style={{ fontSize: '11px', color: '#6b7280' }}>Basket:</span>
        {symbols.map((s) => (
          <button
            key={s}
            onClick={() => removeSymbol(s)}
            disabled={symbols.length <= 2}
            style={{
              ...chipStyle,
              border: '1px solid #374151',
              color: '#e5e7eb',
              cursor: symbols.length <= 2 ? 'not-allowed' : 'pointer',
            }}
            title={symbols.length <= 2 ? 'minimal 2 coin' : 'klik untuk keluarkan'}
          >
            {short(s)} ×
          </button>
        ))}
        {available.length > 0 && symbols.length < 12 && (
          <select
            value=""
            onChange={(e) => e.target.value && addSymbol(e.target.value)}
            style={{
              background: '#0b1220',
              color: '#9ca3af',
              border: '1px solid #374151',
              borderRadius: '6px',
              fontSize: '11px',
              padding: '4px 8px',
            }}
          >
            <option value="">+ tambah coin…</option>
            {available.map((s) => (
              <option key={s} value={s}>{short(s)}</option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}

function Row({ k, v, tone }: { k: string; v: string; tone: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', padding: '1px 0' }}>
      <span style={{ color: '#6b7280' }}>{k}</span>
      <span style={{ color: tone, fontVariantNumeric: 'tabular-nums' }}>{v}</span>
    </div>
  );
}

function VerdictBox({
  title,
  tone,
  symbols,
  matrix,
}: {
  title: string;
  tone: string;
  symbols: string[];
  matrix: CorrMatrix;
}) {
  if (symbols.length === 0) {
    return (
      <div style={{ background: '#0b1220', border: '1px solid #1f2937', borderRadius: '8px', padding: '12px' }}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: tone, marginBottom: '6px' }}>{title}</div>
        <div style={{ fontSize: '11px', color: '#6b7280' }}>tidak ada</div>
      </div>
    );
  }

  return (
    <div style={{ background: '#0b1220', border: `1px solid ${tone}44`, borderRadius: '8px', padding: '12px' }}>
      <div style={{ fontSize: '12px', fontWeight: 700, color: tone, marginBottom: '8px' }}>{title}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
        {symbols.map((s) => {
          const idx = matrix.symbols.indexOf(s);
          const c = matrix.coins[idx];
          // Show who this coin is currently beating most, which is the
          // actual rotation answer rather than a bare name.
          const rivals = matrix.symbols
            .map((other, j) => ({ other, rs: matrix.rs[idx][j] }))
            .filter((x) => x.other !== s)
            .sort((a, b) => b.rs - a.rs);
          const top = rivals[0];
          const beaten = rivals.filter((r) => r.rs > 0).length;
          return (
            <div key={s} style={{ flex: '1 1 150px' }}>
              <div style={{ fontSize: '12px', fontWeight: 700, color: '#f9fafb' }}>
                {short(s)}{' '}
                <span style={{ color: dominanceTone(c.dominance), fontSize: '11px' }}>
                  {fmtPct(c.dominance)}
                </span>
              </div>
              <div style={{ fontSize: '10px', color: '#6b7280', marginTop: '2px' }}>
                beat {beaten}/{rivals.length}
                {top && top.rs > 0 && <> · vs {short(top.other)} {fmtPct(top.rs)}</>}
              </div>
              {c.extensionZ >= 2 && (
                <div style={{ fontSize: '10px', color: '#f59e0b', marginTop: '2px' }}>
                  ⚠ sudah {c.extensionZ.toFixed(1)}σ dari basket — jangan kejar
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function toggleStyle(active: boolean): React.CSSProperties {
  return {
    background: active ? '#1d4ed8' : '#0b1220',
    color: active ? '#f9fafb' : '#9ca3af',
    border: '1px solid #374151',
    borderRadius: '6px',
    fontSize: '11px',
    padding: '4px 10px',
    cursor: 'pointer',
  };
}

const chipStyle: React.CSSProperties = {
  background: '#1f2937',
  borderRadius: '6px',
  fontSize: '11px',
  padding: '3px 8px',
};

const labelCellStyle: React.CSSProperties = {
  padding: '6px 8px',
  fontSize: '11px',
  textAlign: 'left',
  whiteSpace: 'nowrap',
};

function dominanceTone(d: number): string {
  if (d >= 5) return '#10b981';
  if (d >= 1.5) return '#34d399';
  if (d > -1.5) return '#9ca3af';
  if (d > -5) return '#f87171';
  return '#ef4444';
}

function basketCorrColor(c: number): string {
  if (c >= 0.9) return '#ef4444';
  if (c >= 0.7) return '#f59e0b';
  if (c >= 0.4) return '#34d399';
  return '#3b82f6';
}