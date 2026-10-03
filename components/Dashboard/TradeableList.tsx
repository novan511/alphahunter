import React, { useMemo, useState } from 'react';
import { MultiTimeframeResult } from '../../lib/algorithms/multiTimeframe';
import { SectorHeat } from '../../lib/algorithms/narrativeHeat';
import {
  TradeableCoin,
  TradeableResult,
  TradeDirection,
  RiskTier,
  buildTradeableList,
  HORIZON_LABEL,
  HORIZON_NOTE,
} from '../../lib/algorithms/tradeable';

interface TradeableListProps {
  rankings: MultiTimeframeResult[];
  sectors: SectorHeat[];
  onSelectAsset: (symbol: string) => void;
  selectedAsset: string;
  loading?: boolean;
}

const RISK_META: Record<RiskTier, { label: string; color: string }> = {
  low: { label: 'Risiko rendah', color: '#10b981' },
  medium: { label: 'Risiko sedang', color: '#f59e0b' },
  high: { label: 'Risiko tinggi', color: '#ef4444' },
};

type DirFilter = 'all' | TradeDirection;
type RiskFilter = 'all' | 'low_medium' | 'low';

const DIR_FILTERS: Array<{ key: DirFilter; label: string }> = [
  { key: 'all', label: 'Semua' },
  { key: 'long', label: 'Long' },
  { key: 'short', label: 'Short' },
];

const RISK_FILTERS: Array<{ key: RiskFilter; label: string }> = [
  { key: 'all', label: 'Semua risiko' },
  { key: 'low_medium', label: 'Rendah + sedang' },
  { key: 'low', label: 'Rendah saja' },
];

function formatUsd(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function formatCap(v: number | null): string {
  if (v == null || !Number.isFinite(v) || v <= 0) return '—';
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  return `$${(v / 1e3).toFixed(0)}K`;
}

function passesRisk(t: TradeableCoin, f: RiskFilter): boolean {
  if (f === 'all') return true;
  if (f === 'low_medium') return t.riskTier !== 'high';
  return t.riskTier === 'low';
}

export default function TradeableList({
  rankings,
  sectors,
  onSelectAsset,
  selectedAsset,
  loading,
}: TradeableListProps) {
  const [dirFilter, setDirFilter] = useState<DirFilter>('all');
  const [riskFilter, setRiskFilter] = useState<RiskFilter>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showWatchlist, setShowWatchlist] = useState(true);
  const [showAudit, setShowAudit] = useState(false);

  const result: TradeableResult = useMemo(
    () => buildTradeableList(rankings, { sectors }),
    [rankings, sectors]
  );

  const counts = useMemo(() => {
    let long = 0;
    let short = 0;
    let safe = 0;
    for (const t of result.trades) {
      if (t.direction === 'long') long++;
      else short++;
      if (t.riskTier !== 'high') safe++;
    }
    return { long, short, safe, total: result.trades.length };
  }, [result]);

  const visible = useMemo(
    () =>
      result.trades
        .filter((t) => dirFilter === 'all' || t.direction === dirFilter)
        .filter((t) => passesRisk(t, riskFilter)),
    [result.trades, dirFilter, riskFilter]
  );

  if (rankings.length === 0) {
    return (
      <div style={{
        background: '#111827',
        borderRadius: '12px',
        border: '1px solid #374151',
        padding: '32px',
        textAlign: 'center',
        color: '#6b7280',
        fontSize: '13px',
      }}>
        {loading ? 'Menyaring koin yang bisa ditrade…' : 'Menunggu hasil scan untuk menyusun daftar trade.'}
      </div>
    );
  }

  return (
    <div style={{ background: '#111827', borderRadius: '12px', border: '1px solid #374151', overflow: 'hidden' }}>
      <div className="ah-panel-head" style={{
        padding: '12px 16px',
        borderBottom: '1px solid #374151',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '15px' }}>🎯</span>
          <div>
            <h3 style={{ fontSize: '14px', fontWeight: '600', color: '#f9fafb', margin: 0 }}>
              Coin yang Bisa Ditrade
            </h3>
            <p style={{ fontSize: '10px', color: '#6b7280', margin: 0 }}>
              {counts.total} lolos dari {rankings.length.toLocaleString()} koin ·{' '}
              {counts.safe} tanpa profil risiko tinggi
            </p>
          </div>
        </div>
        <div className="ah-chip-row">
          {DIR_FILTERS.map((f) => {
            const n = f.key === 'all' ? counts.total : f.key === 'long' ? counts.long : counts.short;
            const on = dirFilter === f.key;
            return (
              <button key={f.key} onClick={() => setDirFilter(f.key)} style={chip(on, f.key === 'short' ? '#ef4444' : '#10b981', n)}>
                {f.label}
              </button>
            );
          })}
          <span style={{ width: 1, background: '#374151', margin: '0 4px' }} />
          {RISK_FILTERS.map((f) => {
            const on = riskFilter === f.key;
            return (
              <button key={f.key} onClick={() => setRiskFilter(f.key)} style={chip(on, '#a78bfa')}>
                {f.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Gate transparency: the panel should say what it excluded, not silently do it. */}
      <div style={{
        padding: '8px 16px',
        borderBottom: '1px solid #374151',
        fontSize: '10px',
        color: '#6b7280',
        display: 'flex',
        gap: '10px',
        alignItems: 'center',
        flexWrap: 'wrap',
      }}>
        <span>
          Gate: volume ≥ {formatUsd(result.gates.minQuoteVolume)}/24h (liq ≥ {Math.round(result.gates.minLiquidity * 100)}%) ·
          confluence ≥ {result.gates.minConfluence} · harus ada signal · bukan aset peg
        </span>
        {result.gates.excludedPegAssets > 0 && (
          <span title="Stablecoin dan aset terpeg tidak dimasukkan: sinyalnya adalah depeg, bukan arah.">
            · {result.gates.excludedPegAssets} stablecoin dikecualikan
          </span>
        )}
        <button
          onClick={() => setShowAudit((v) => !v)}
          style={{ background: 'none', border: 'none', color: '#3b82f6', cursor: 'pointer', fontSize: '10px', fontWeight: 600, padding: 0 }}
        >
          {showAudit ? 'Sembunyikan' : 'Lihat'} {result.rejects.length} yang gugur
        </button>
      </div>

      {showAudit && (
        <div style={{ padding: '10px 16px', borderBottom: '1px solid #374151', background: '#0a0e17', fontSize: '10px', color: '#6b7280' }}>
          {result.rejects.length === 0 ? (
            'Tidak ada koin yang gugur — seluruh scan punya volume cukup dan signal.'
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '4px 16px', maxHeight: 140, overflowY: 'auto' }}>
              {result.rejects.slice(0, 200).map((rj) => (
                <span key={rj.asset}>
                  <b style={{ color: '#9ca3af' }}>{rj.asset}</b> — {rj.reasons.join(', ')}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {visible.length === 0 ? (
        <div style={{ padding: '32px', textAlign: 'center', color: '#6b7280', fontSize: '12px' }}>
          Tidak ada koin yang lolos filter ini. Coba longgarkan filter risiko, atau tunggu scan berikutnya —
          daftar ini sengaja tidak memuat koin yang book-nya tidak layak eksekusi.
        </div>
      ) : (
        <div className="ah-trade-grid" style={{ padding: '12px 16px' }}>
          {visible.map((t) => (
            <TradeCard
              key={t.asset}
              trade={t}
              selected={t.asset === selectedAsset}
              expanded={expanded === t.asset}
              onSelect={() => onSelectAsset(t.asset)}
              onToggle={() => setExpanded(expanded === t.asset ? null : t.asset)}
            />
          ))}
        </div>
      )}

      {/* Watchlist — the earliest honest warning: trend present, trigger absent. */}
      {result.watchlist.length > 0 && (
        <div style={{ borderTop: '1px solid #374151' }}>
          <button
            onClick={() => setShowWatchlist((v) => !v)}
            style={{
              width: '100%',
              padding: '10px 16px',
              background: 'transparent',
              border: 'none',
              color: '#9ca3af',
              fontSize: '12px',
              fontWeight: '600',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              textAlign: 'left',
            }}
          >
            <span>{showWatchlist ? '▾' : '▸'}</span>
            👀 Pantau ({result.watchlist.length} coin) — tren sudah ada, pemicunya belum
          </button>
          {showWatchlist && (
            <div style={{ padding: '0 16px 12px' }}>
              {result.watchlist.map((w) => (
                <div
                  key={w.asset}
                  onClick={() => onSelectAsset(w.asset)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    flexWrap: 'wrap',
                    padding: '7px 10px',
                    marginBottom: '4px',
                    background: '#0a0e17',
                    border: '1px solid #374151',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '11px',
                  }}
                >
                  <span style={{ fontWeight: '700', color: '#f9fafb', minWidth: '54px' }}>{w.ticker}</span>
                  <span style={{
                    padding: '1px 6px', borderRadius: '4px', fontSize: '9px', fontWeight: 700,
                    background: `${w.categoryColor}20`, color: w.categoryColor, whiteSpace: 'nowrap',
                  }}>
                    {w.categoryIcon} {w.categoryLabel}
                  </span>
                  <span style={{ color: '#10b981', fontWeight: '600', whiteSpace: 'nowrap' }}>
                    bias +{Math.round(w.netBias * 100)}%
                  </span>
                  <span style={{ color: '#6b7280', fontSize: '10px' }}>
                    confluence {w.confluenceScore} ·{' '}
                    <span style={{ color: RISK_META[w.riskTier].color }}>{RISK_META[w.riskTier].label}</span>
                  </span>
                  <span style={{ color: '#4b5563', fontSize: '10px', marginLeft: 'auto' }}>klik untuk chart →</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ padding: '8px 16px', borderTop: '1px solid #374151', fontSize: '9px', color: '#4b5563', lineHeight: 1.6 }}>
        Angka risiko/budget di sini adalah batas manajemen risiko dari skor scan, bukan rekomendasi posisi.
        Ukuran posisi sebenarnya butuh harga entry & jarak stop, yang tidak bisa dihitung dari satu snapshot.
      </div>
    </div>
  );
}

function chip(on: boolean, color: string, count?: number): React.CSSProperties {
  return {
    padding: '4px 10px',
    borderRadius: '6px',
    border: `1px solid ${on ? color + '66' : '#374151'}`,
    background: on ? `${color}22` : 'transparent',
    color: on ? color : '#9ca3af',
    fontSize: '10px',
    fontWeight: 600,
    cursor: 'pointer',
  };
}

interface TradeCardProps {
  trade: TradeableCoin;
  selected: boolean;
  expanded: boolean;
  onSelect: () => void;
  onToggle: () => void;
}

function TradeCard({ trade: t, selected, expanded, onSelect, onToggle }: TradeCardProps) {
  const dirColor = t.direction === 'long' ? '#10b981' : '#ef4444';
  const risk = RISK_META[t.riskTier];

  return (
    <div
      onClick={onSelect}
      style={{
        background: '#0a0e17',
        border: `1px solid ${selected ? dirColor : t.counterTrend ? '#ef444455' : '#374151'}`,
        borderRadius: '10px',
        padding: '12px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
          <span style={{
            padding: '3px 7px', borderRadius: '5px', fontSize: '9px', fontWeight: 700,
            background: `${dirColor}22`, color: dirColor,
          }}>
            {t.direction === 'long' ? '▲ LONG' : '▼ SHORT'}
          </span>
          <span style={{ fontSize: '14px', fontWeight: '700', color: '#f9fafb' }}>{t.ticker}</span>
        </div>
        <span style={{ fontSize: '9px', color: '#6b7280' }}>{t.capTier}</span>
      </div>

      <div style={{ display: 'flex', gap: '5px', margin: '9px 0', flexWrap: 'wrap' }}>
        <span style={{
          padding: '2px 6px', borderRadius: '4px', fontSize: '9px', fontWeight: 700,
          background: `${dirColor}20`, color: dirColor,
        }}>
          {t.signal.replace('_', ' ').toUpperCase()}
        </span>
        <span style={{
          padding: '2px 6px', borderRadius: '4px', fontSize: '9px', fontWeight: 700,
          background: `${t.categoryColor}20`, color: t.categoryColor,
        }}>
          {t.categoryIcon} {t.categoryLabel}
        </span>
        <span style={{
          padding: '2px 6px', borderRadius: '4px', fontSize: '9px', fontWeight: 700,
          background: `${risk.color}20`, color: risk.color,
        }}>
          {risk.label}
        </span>
        {t.counterTrend && (
          <span
            title="Arah daily bertentangan dengan arah trade — ini yang membuat short rawan squeeze."
            style={{
              padding: '2px 6px', borderRadius: '4px', fontSize: '9px', fontWeight: 700,
              background: 'rgba(239,68,68,0.2)', color: '#ef4444',
            }}
          >
            ⚠ daily berlawanan
          </span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '9px', color: '#6b7280', marginBottom: '3px' }}>
            Kualitas eksekusi · confluence {t.confluenceScore}
          </div>
          <div style={{ height: '6px', background: '#1f2937', borderRadius: '3px', overflow: 'hidden' }}>
            <div style={{
              width: `${t.tradability}%`,
              height: '100%',
              background: t.tradability >= 70 ? '#10b981' : t.tradability >= 50 ? '#f59e0b' : '#6b7280',
              borderRadius: '3px',
            }} />
          </div>
        </div>
        <span style={{
          fontSize: '13px', fontWeight: '700',
          color: t.tradability >= 70 ? '#10b981' : t.tradability >= 50 ? '#f59e0b' : '#6b7280',
        }}>
          {t.tradability}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '3px 10px', fontSize: '10px', color: '#9ca3af' }}>
        <span>Horizon <b style={{ color: '#d1d5db' }}>{HORIZON_LABEL[t.horizon]}</b></span>
        <span>Risk budget <b style={{ color: risk.color }}>≤ {t.riskBudgetPct}%</b></span>
        <span>Volume 24h <b>{t.quoteVolume != null ? formatUsd(t.quoteVolume) : `liq ${Math.round(t.liquidityFactor * 100)}%`}</b></span>
        <span>Cap <b>{formatCap(t.marketCap)}</b></span>
      </div>

      {/* 1h / 4h / 1d signed evidence */}
      <div style={{ display: 'flex', gap: '6px', marginTop: '9px', alignItems: 'center' }}>
        {['1h', '4h', '1d'].map((tf, i) => {
          const v = t.tfTilt[i] ?? 0;
          const aligned = v * (t.direction === 'long' ? 1 : -1) > 0;
          return (
            <span key={tf} style={{
              flex: 1,
              padding: '3px 6px',
              background: '#111827',
              border: `1px solid ${aligned ? dirColor + '44' : '#374151'}`,
              borderRadius: '5px',
              fontSize: '9px',
              color: '#6b7280',
              display: 'flex',
              justifyContent: 'space-between',
            }}>
              <span>{tf}</span>
              <b style={{ color: v > 0 ? '#10b981' : v < 0 ? '#ef4444' : '#6b7280' }}>
                {v > 0 ? '+' : ''}{v.toFixed(2)}
              </b>
            </span>
          );
        })}
      </div>

      <button
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
        style={{
          marginTop: '9px',
          width: '100%',
          padding: '5px',
          background: 'transparent',
          border: '1px solid #374151',
          borderRadius: '6px',
          color: '#6b7280',
          fontSize: '10px',
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        {expanded ? '▲ Sembunyikan' : '▼ Kenapa & kapan invalid'}
      </button>

      {expanded && (
        <div style={{ marginTop: '8px', borderTop: '1px solid #374151', paddingTop: '8px' }} onClick={(e) => e.stopPropagation()}>
          <div style={{ fontSize: '10px', color: '#10b981', fontWeight: '700', marginBottom: '4px' }}>Kenapa masuk daftar</div>
          {t.why.map((w, i) => (
            <div key={i} style={{ fontSize: '10px', color: '#9ca3af', lineHeight: 1.5, marginBottom: '3px' }}>· {w}</div>
          ))}
          <div style={{ fontSize: '10px', color: '#f59e0b', fontWeight: '700', margin: '8px 0 4px' }}>Kalau tidak, cancel</div>
          {t.invalidation.map((w, i) => (
            <div key={i} style={{ fontSize: '10px', color: '#9ca3af', lineHeight: 1.5, marginBottom: '3px' }}>· {w}</div>
          ))}
          <div style={{ fontSize: '10px', color: '#4b5563', lineHeight: 1.5, marginTop: '6px' }}>
            {HORIZON_NOTE[t.horizon]}
          </div>
        </div>
      )}
    </div>
  );
}
