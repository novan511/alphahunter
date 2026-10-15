import React, { useCallback, useEffect, useMemo, useState } from 'react';
import FuturesChart from './FuturesChart';
// lib/futuresBook, never lib/futures: the engine imports server-only modules
// (fs-backed candle cache) that cannot be bundled for the browser.
import {
  FUTURES_BOOK,
  FUTURES_TIMEFRAMES,
  GROUP_LABEL,
  GROUP_ORDER,
  type FuturesGroup,
  type FuturesResponse,
  type FuturesSignal,
  type MacroSnapshot,
  type Verdict,
} from '../../lib/futuresBook';

interface FuturesTabProps {
  /** Seeded from the URL so a shared link lands on the same timeframe. */
  initialTf: string;
  onTfChange: (tf: string) => void;
  /**
   * Sections stay mounted while hidden, so without this the tab would spend
   * ~39 venue calls on every page load for a view nobody opened — and the
   * venue starts refusing around 180 requests/min.
   */
  visible: boolean;
}

const VERDICT_STYLE: Record<Verdict, { bg: string; fg: string; label: string; arrow: string }> = {
  long: { bg: 'rgba(16, 185, 129, 0.15)', fg: '#34d399', label: 'LONG', arrow: '▲' },
  short: { bg: 'rgba(239, 68, 68, 0.15)', fg: '#f87171', label: 'SHORT', arrow: '▼' },
  wait: { bg: 'rgba(107, 114, 128, 0.15)', fg: '#9ca3af', label: 'WAIT', arrow: '●' },
};

function fmt(n: number | null, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtPrice(n: number): string {
  const digits = n >= 1000 ? 1 : n >= 10 ? 2 : 3;
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Macro strip. Read at a glance, never a scoring input — see macroNoteFor(). */
function MacroStrip({ macro }: { macro: MacroSnapshot | null }) {
  const items = useMemo(() => {
    if (!macro) return [];
    return [
      {
        label: 'DXY',
        value: macro.dxy == null ? '—' : fmt(macro.dxy, 2),
        change: macro.dxyChangePct,
        hint: 'Dollar index. Menguat = tekanan ke commodity & aset ber risiko.',
      },
      {
        label: 'VIX',
        value: macro.vix == null ? '—' : fmt(macro.vix, 2),
        change: macro.vixChangePct,
        hint: 'Fear index. ≥20 = risk-off.',
      },
      {
        label: 'US10Y',
        value: macro.us10y == null ? '—' : `${fmt(macro.us10y, 2)}%`,
        change: null,
        hint: 'Yield 10 tahun AS (FRED). ≥4.2% = emas & saham tertekan.',
      },
      {
        label: 'Fed Funds',
        value: macro.fedFunds == null ? '—' : `${fmt(macro.fedFunds, 2)}%`,
        change: null,
        hint: 'Suku bunga acuan AS (FRED).',
      },
      {
        label: 'CPI YoY',
        value: macro.cpiYoY == null ? '—' : `${fmt(macro.cpiYoY, 1)}%`,
        change: null,
        hint: 'Inflasi AS year-over-year (FRED).',
      },
    ];
  }, [macro]);

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '8px' }}>
      {items.map((it) => {
        const up = (it.change ?? 0) > 0.05;
        const down = (it.change ?? 0) < -0.05;
        return (
          <div
            key={it.label}
            title={it.hint}
            style={{
              background: '#111827',
              border: '1px solid #374151',
              borderRadius: '8px',
              padding: '7px 12px',
              minWidth: '92px',
            }}
          >
            <div style={{ fontSize: '10px', color: '#6b7280', fontWeight: 700, letterSpacing: '0.04em' }}>
              {it.label}
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
              <span style={{ fontSize: '15px', color: '#f9fafb', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                {it.value}
              </span>
              {it.change != null && (
                <span style={{ fontSize: '11px', fontWeight: 700, color: up ? '#34d399' : down ? '#f87171' : '#6b7280' }}>
                  {up ? '+' : ''}{it.change.toFixed(2)}%
                </span>
              )}
            </div>
          </div>
        );
      })}
      {macro?.asOf && (
        <div style={{ alignSelf: 'flex-end', fontSize: '10px', color: '#6b7280', paddingBottom: '6px' }}>
          data FRED: {macro.asOf}
        </div>
      )}
    </div>
  );
}

function AlignmentDots({ signal }: { signal: FuturesSignal }) {
  return (
    <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
      {signal.alignment.map((a) => (
        <span
          key={a.tf}
          title={`${a.label}: ${a.verdict.toUpperCase()}${a.score ? ` (${Math.round(a.score * 100)})` : ''}`}
          style={{
            fontSize: '9px',
            fontWeight: 800,
            padding: '1px 4px',
            borderRadius: '3px',
            background: VERDICT_STYLE[a.verdict].bg,
            color: VERDICT_STYLE[a.verdict].fg,
            letterSpacing: '0.02em',
          }}
        >
          {a.label}
        </span>
      ))}
    </div>
  );
}

function SignalCard({ signal, tf }: { signal: FuturesSignal; tf: string }) {
  const [open, setOpen] = useState(false);
  const v = VERDICT_STYLE[signal.verdict];
  const isWait = signal.verdict === 'wait';

  return (
    <div style={{ background: '#111827', border: '1px solid #374151', borderRadius: '10px', overflow: 'hidden' }}>
      <div style={{ padding: '10px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '7px' }}>
            <span style={{ fontSize: '14px', fontWeight: 800, color: '#f9fafb' }}>{signal.instrument.symbol}</span>
            <span style={{ fontSize: '11px', color: '#6b7280' }}>{signal.instrument.name}</span>
          </div>
          <div style={{ fontSize: '16px', color: '#f9fafb', fontWeight: 700, fontVariantNumeric: 'tabular-nums', marginTop: '2px' }}>
            {fmtPrice(signal.price)}
            <span style={{ fontSize: '11px', fontWeight: 600, color: signal.changePct >= 0 ? '#34d399' : '#f87171', marginLeft: '7px' }}>
              {signal.changePct >= 0 ? '+' : ''}{(signal.changePct * 100).toFixed(2)}%
            </span>
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ background: v.bg, color: v.fg, borderRadius: '6px', padding: '3px 8px', fontSize: '11px', fontWeight: 800, letterSpacing: '0.05em' }}>
            {v.arrow} {v.label}
          </div>
          <div style={{ fontSize: '10px', color: '#6b7280', marginTop: '3px', fontVariantNumeric: 'tabular-nums' }}>
            conviction {signal.score}
          </div>
        </div>
      </div>

      <FuturesChart candles={signal.candles} marker={signal.lastSignal} />

      <div style={{ padding: '8px 12px 10px', borderTop: '1px solid #1f2937' }}>
        {!isWait ? (
          <div style={{ display: 'flex', gap: '12px', fontSize: '11px', fontVariantNumeric: 'tabular-nums', marginBottom: '6px' }}>
            <span style={{ color: '#f87171' }}>SL {fmtPrice(signal.stop)}</span>
            <span style={{ color: '#34d399' }}>TP {fmtPrice(signal.target)}</span>
            <span style={{ color: '#6b7280' }}>ATR {signal.atrPct.toFixed(2)}%</span>
          </div>
        ) : (
          <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '6px' }}>
            Tidak ada sisi — SL/TP tidak ditampilkan.
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <AlignmentDots signal={signal} />
          <button
            onClick={() => setOpen((o) => !o)}
            style={{
              background: 'transparent',
              border: '1px solid #374151',
              color: '#9ca3af',
              borderRadius: '5px',
              padding: '2px 8px',
              fontSize: '10px',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            {open ? 'Tutup alasan' : 'Kenapa?'}
          </button>
        </div>

        {open && (
          <div style={{ marginTop: '8px', borderTop: '1px dashed #374151', paddingTop: '8px' }}>
            <div style={{ fontSize: '10px', fontWeight: 800, color: '#6b7280', letterSpacing: '0.04em', marginBottom: '4px' }}>
              TEKNIKAL ({tf.toUpperCase()})
            </div>
            <ul style={{ margin: 0, paddingLeft: '16px' }}>
              {signal.reasons.map((r, i) => (
                <li key={i} style={{ fontSize: '11px', color: '#d1d5db', lineHeight: 1.5 }}>{r}</li>
              ))}
            </ul>
            <div style={{ fontSize: '10px', fontWeight: 800, color: '#6b7280', letterSpacing: '0.04em', margin: '8px 0 4px' }}>
              MACRO
            </div>
            <div style={{ fontSize: '11px', color: '#9ca3af', lineHeight: 1.5 }}>{signal.macroNote}</div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Futures desk: fixed book, one verdict per instrument, explained in technical
 * and macro terms.
 *
 * The timeframe is a deliberate input, not a zoom: 5m/15m time entries, 1h/4h
 * set direction, 1d filters, 1w sizes down. The reason list on every card says
 * which of those jobs the active timeframe is doing.
 */
export default function FuturesTab({ initialTf, onTfChange, visible }: FuturesTabProps) {
  const [tf, setTf] = useState(initialTf);
  const [data, setData] = useState<FuturesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/futures?tf=${encodeURIComponent(tf)}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
        return body as FuturesResponse;
      })
      .then((body) => {
        if (cancelled) return;
        setData(body);
        setLoading(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tf, visible]);

  const changeTf = useCallback(
    (next: string) => {
      setTf(next);
      onTfChange(next);
    },
    [onTfChange]
  );

  const grouped = useMemo(() => {
    if (!data) return [];
    return GROUP_ORDER.map((g) => ({
      group: g,
      items: data.signals.filter((s) => s.instrument.group === g),
    })).filter((g) => g.items.length > 0);
  }, [data]);

  const activeDef = FUTURES_TIMEFRAMES.find((t) => t.tf === tf) ?? FUTURES_TIMEFRAMES[2];

  return (
    <div>
      <div style={{
        display: 'flex', gap: '4px', marginBottom: '8px', flexWrap: 'wrap',
      }} role="group" aria-label="Timeframe">
        {FUTURES_TIMEFRAMES.map((t) => (
          <button
            key={t.tf}
            onClick={() => changeTf(t.tf)}
            aria-pressed={t.tf === tf}
            title={t.use}
            style={{
              padding: '6px 14px',
              background: t.tf === tf ? 'rgba(59,130,246,0.2)' : 'transparent',
              border: `1px solid ${t.tf === tf ? '#3b82f6' : '#374151'}`,
              color: t.tf === tf ? '#93c5fd' : '#9ca3af',
              borderRadius: '6px',
              fontSize: '12px',
              fontWeight: 800,
              cursor: 'pointer',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '14px', lineHeight: 1.5 }}>
        {activeDef.use}
      </div>

      <MacroStrip macro={data?.macro ?? null} />

      {loading && (
        <div style={{ padding: '28px', textAlign: 'center', color: '#6b7280', fontSize: '13px' }}>
          Memuat book futures {tf.toUpperCase()}… ({FUTURES_BOOK.length} instrumen)
        </div>
      )}

      {error && !loading && (
        <div style={{
          padding: '12px 16px', background: 'rgba(239,68,68,0.1)',
          border: '1px solid rgba(239,68,68,0.3)', borderRadius: '8px',
          color: '#f87171', fontSize: '13px',
        }}>
          {error}
        </div>
      )}

      {!loading && !error && data && (
        <>
          {grouped.map(({ group, items }) => (
            <div key={group} style={{ marginBottom: '20px' }}>
              <div style={{ fontSize: '11px', fontWeight: 800, color: '#6b7280', letterSpacing: '0.06em', marginBottom: '8px' }}>
                {GROUP_LABEL[group].toUpperCase()}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '12px' }}>
                {items.map((s) => (
                  <SignalCard key={s.instrument.id} signal={s} tf={tf} />
                ))}
              </div>
            </div>
          ))}

          {!data.complete && (
            <div style={{
              padding: '10px 14px', marginBottom: '14px',
              background: 'rgba(245, 158, 11, 0.1)',
              border: '1px solid rgba(245, 158, 11, 0.35)',
              borderRadius: '8px', color: '#fbbf24', fontSize: '12px',
            }}>
              ⚠ Book tidak lengkap: {data.missing.join(', ')} gagal dimuat.
              Sinyal di bawah hanya untuk {data.signals.length} instrumen yang tersedia — jangan pakai sebagai daftar posisi.
            </div>
          )}

          {data.errors.length > 0 && (
            <details style={{ fontSize: '11px', color: '#6b7280', marginTop: '8px' }}>
              <summary style={{ cursor: 'pointer' }}>{data.errors.length} permintaan gagal</summary>
              <ul style={{ marginTop: '6px' }}>
                {data.errors.slice(0, 20).map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}
