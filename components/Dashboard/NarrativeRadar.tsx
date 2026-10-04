import React, { useMemo } from 'react';
import { SectorHeat, SectorPhase, buildSectorHeat } from '../../lib/algorithms/narrativeHeat';
import { MultiTimeframeResult } from '../../lib/algorithms/multiTimeframe';

interface NarrativeRadarProps {
  rankings: MultiTimeframeResult[];
  /** Sector currently focused in the ranking table, if any. */
  focusCategory?: string | null;
  onFocusCategoryChange?: (id: string | null) => void;
}

const PHASE_META: Record<SectorPhase, { label: string; color: string; icon: string; hint: string }> = {
  early: {
    label: 'Mulai naik',
    color: '#f59e0b',
    icon: '🔥',
    hint: '1h/4h sudah naik, harian belum — fase paling awal & paling berisiko salah waktu.',
  },
  confirmed: {
    label: 'Terkonfirmasi',
    color: '#10b981',
    icon: '✅',
    hint: 'Harian ikut berputar. Tren berjalan, tapi harga sudah jauh dari titik awal.',
  },
  building: {
    label: 'Bangun',
    color: '#38bdf8',
    icon: '📶',
    hint: 'Ada kekuatan tapi belum cukup untuk disebut narasi.',
  },
  rotating_out: {
    label: 'Uang keluar',
    color: '#fb923c',
    icon: '💸',
    hint: 'Short-timeframe sudah melemah lebih dulu — jangan masuk baru.',
  },
  falling: {
    label: 'Turun',
    color: '#ef4444',
    icon: '🔻',
    hint: 'Dominan bearish di hampir semua timeframe.',
  },
  weak: {
    label: 'Datar',
    color: '#6b7280',
    icon: '—',
    hint: 'Belum ada bukti arah.',
  },
};

function signed(v: number): string {
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
}

function formatCap(v: number): string {
  if (v >= 1e12) return `$${(v / 1e12).toFixed(1)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${(v / 1e3).toFixed(0)}K`;
}

export default function NarrativeRadar({ rankings, focusCategory, onFocusCategoryChange }: NarrativeRadarProps) {
  const sectors = useMemo(() => buildSectorHeat(rankings), [rankings]);

  const populated = useMemo(() => sectors.filter((s) => s.members > 0), [sectors]);
  const early = useMemo(
    () => populated.filter((s) => s.phase === 'early'),
    [populated]
  );
  const confirmed = useMemo(
    () => populated.filter((s) => s.phase === 'confirmed'),
    [populated]
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
        Narasi belum bisa dihitung — menunggu hasil scan.
      </div>
    );
  }

  return (
    <div style={{ background: '#111827', borderRadius: '12px', border: '1px solid #374151', overflow: 'hidden' }}>
      {/* ---- Early notification banner ---- */}
      <div className="ah-panel-head" style={{
        padding: '12px 16px',
        borderBottom: '1px solid #374151',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '15px' }}>📡</span>
          <div>
            <h3 style={{ fontSize: '14px', fontWeight: '600', color: '#f9fafb', margin: 0 }}>
              Radar Narasi
            </h3>
            <p style={{ fontSize: '10px', color: '#6b7280', margin: 0 }}>
              Dihitung dari {rankings.length.toLocaleString()} koin hasil scan
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          <span style={{
            padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: '700',
            background: early.length > 0 ? 'rgba(245, 158, 11, 0.15)' : 'rgba(107, 114, 128, 0.12)',
            border: `1px solid ${early.length > 0 ? 'rgba(245,158,11,0.4)' : '#374151'}`,
            color: early.length > 0 ? '#f59e0b' : '#6b7280',
          }}>
            🔥 {early.length} mulai naik
          </span>
          <span style={{
            padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: '700',
            background: 'rgba(16, 185, 129, 0.12)', border: '1px solid rgba(16,185,129,0.3)',
            color: '#10b981',
          }}>
            ✅ {confirmed.length} terkonfirmasi
          </span>
        </div>
      </div>

      {/* ---- The alert itself: only renders when something is actually early ---- */}
      {early.length > 0 ? (
        <div style={{
          padding: '12px 16px',
          background: 'linear-gradient(90deg, rgba(245,158,11,0.12), rgba(245,158,11,0.02))',
          borderBottom: '1px solid #374151',
        }}>
          <div style={{ fontSize: '10px', fontWeight: '700', color: '#f59e0b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
            ⚠️ Early notification — narasi yang akan mulai naik
          </div>
          {early.map((s) => (
            <div key={s.id} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', marginBottom: '6px', fontSize: '12px', color: '#d1d5db' }}>
              <span style={{ flexShrink: 0 }}>{s.icon}</span>
              <span>
                <strong style={{ color: s.color }}>{s.label}</strong>
                {' — '}
                {s.headline}
                {s.thinSample && (
                  <span style={{ color: '#ef4444', fontWeight: '600' }}> · sampel tipis, jangan terlalu percaya</span>
                )}
              </span>
            </div>
          ))}
          <p style={{ fontSize: '10px', color: '#6b7280', margin: '8px 0 0', lineHeight: 1.5 }}>
            Sinyal “mulai naik” = kekuatan 1h/4h sudah positif sementara tren harian belum. Ini pola rotasi
            awal, bukan tren yang sudah matang: kalau harian berbalik turun, call ini batal.
          </p>
        </div>
      ) : (
        <div style={{ padding: '10px 16px', borderBottom: '1px solid #374151', fontSize: '11px', color: '#6b7280' }}>
          Tidak ada narasi di fase awal saat ini. Kalau panel ini kosong, artinya belum ada rotasi yang
          cukup kuat untuk dilacak — biasanya lebih aman menunggu daripada memaksa entry.
        </div>
      )}

      {/* ---- Sector cards ---- */}
      <div style={{ padding: '14px 16px' }}>
        <div className="ah-narrative-grid">
          {populated.map((s) => {
            const meta = PHASE_META[s.phase];
            const focused = focusCategory === s.id;
            return (
              <SectorCard
                key={s.id}
                sector={s}
                phaseMeta={meta}
                focused={focused}
                onClick={() => onFocusCategoryChange?.(focused ? null : s.id)}
              />
            );
          })}
        </div>
        {populated.length === 0 && (
          <div style={{ fontSize: '11px', color: '#6b7280' }}>Belum ada koin yang bisa dikelompokkan.</div>
        )}
      </div>
    </div>
  );
}

interface SectorCardProps {
  sector: SectorHeat;
  phaseMeta: typeof PHASE_META[SectorPhase];
  focused: boolean;
  onClick: () => void;
}

function SectorCard({ sector: s, phaseMeta, focused, onClick }: SectorCardProps) {
  return (
    <div
      onClick={onClick}
      tabIndex={0}
      role="button"
      aria-pressed={focused}
      aria-label={`${s.label}, fase ${phaseMeta.label}, ${s.members} koin`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className="ah-row"
      title={focused ? 'Klik untuk lepas filter tabel di bawah' : 'Klik untuk filter tabel di bawah ke sektor ini'}
      style={{
        background: '#0a0e17',
        border: `1px solid ${focused ? s.color : '#374151'}`,
        borderLeft: `3px solid ${s.color}`,
        borderRadius: '10px',
        padding: '12px 14px',
        cursor: 'pointer',
        opacity: s.heat < 15 ? 0.75 : 1,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ fontSize: '14px' }}>{s.icon}</span>
          <span style={{ fontSize: '13px', fontWeight: '700', color: '#f9fafb' }}>{s.label}</span>
          <span style={{ fontSize: '10px', color: '#6b7280' }}>{s.members} koin</span>
        </div>
        <span style={{
          padding: '2px 7px', borderRadius: '4px', fontSize: '9px', fontWeight: '700',
          background: `${phaseMeta.color}20`, color: phaseMeta.color, whiteSpace: 'nowrap',
        }}>
          {phaseMeta.icon} {phaseMeta.label}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '10px 0 8px' }}>
        <div style={{ flex: 1, height: '6px', background: '#1f2937', borderRadius: '3px', overflow: 'hidden' }}>
          <div style={{
            width: `${s.heat}%`,
            height: '100%',
            background: `linear-gradient(90deg, ${phaseMeta.color}, ${s.color})`,
            borderRadius: '3px',
            transition: 'width 0.4s ease',
          }} />
        </div>
        <span style={{ fontSize: '11px', fontWeight: '700', color: phaseMeta.color, minWidth: '22px', textAlign: 'right' }}>
          {s.heat}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '4px 10px', fontSize: '10px', color: '#9ca3af', marginBottom: '8px' }}>
        <span>Short 1h+4h <b style={{ color: s.shortTerm >= 0 ? '#10b981' : '#ef4444' }}>{signed(s.shortTerm)}</b></span>
        <span>Harian 1d <b style={{ color: s.longTerm >= 0 ? '#10b981' : '#ef4444' }}>{signed(s.longTerm)}</b></span>
        <span title="Selisih short-term vs harian. Positif = sudah naik lebih dulu dari tren hariannya.">
          Thrust <b style={{ color: s.thrust > 0 ? '#f59e0b' : '#6b7280' }}>{signed(s.thrust)}</b>
        </span>
        <span>Early score <b style={{ color: s.earlyScore >= 45 ? '#f59e0b' : '#6b7280' }}>{s.earlyScore}</b></span>
        <span>Conviction <b>{Math.round(s.conviction * 100)}%</b></span>
        <span>Agree <b>{Math.round(s.agreement * 100)}%</b></span>
        <span>Buy / Sell <b style={{ color: '#10b981' }}>{s.buyCount}</b> / <b style={{ color: '#ef4444' }}>{s.sellCount}</b></span>
        <span>{s.knownCap > 0 ? `Cap ${formatCap(s.knownCap)}` : 'Cap tidak terdata'}</span>
      </div>

      <p style={{ fontSize: '11px', color: '#d1d5db', lineHeight: 1.5, margin: '0 0 6px' }}>
        {s.headline}
      </p>
      <p style={{ fontSize: '10px', color: '#6b7280', lineHeight: 1.5, margin: 0 }}>
        {s.read}
      </p>

      {s.leaders.length > 0 && (
        <div style={{ fontSize: '10px', color: '#6b7280', marginTop: '8px' }}>
          Pemimpin: {s.leaders.join(', ')}
        </div>
      )}
      {s.thinSample && (
        <div style={{ fontSize: '9px', color: '#ef4444', marginTop: '6px', fontWeight: '600' }}>
          ⚠ Hanya {s.members} koin — sampel terlalu tipis untuk kesimpulan yang yakin.
        </div>
      )}
    </div>
  );
}
