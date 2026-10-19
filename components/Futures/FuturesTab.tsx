import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import type { FuturesAIOutput } from '../../lib/quant/futuresAI';

interface FuturesTabProps {
  /**
   * Sections stay mounted while hidden, so without this the tab would spend
   * ~39 venue calls on every page load for a view nobody opened — and the
   * venue starts refusing around 180 requests/min.
   */
  visible: boolean;
}

/** Timeframe locked to 4h: the cards now show all key timeframes at once, so
 *  the trader sees the holistic direction without picking one. */
const FIXED_TF = '4h';

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

function SignalCard({
  signal,
  aiAnalysis,
}: {
  signal: FuturesSignal;
  aiAnalysis?: FuturesAIOutput | null;
}) {
  const [open, setOpen] = useState(false);
  const v = VERDICT_STYLE[signal.verdict];
  const isWait = signal.verdict === 'wait';

  /** Direction dot per timeframe for the holistic MTF strip. */
  const tfDot = (tf: string, verdict: Verdict) => {
    const style = VERDICT_STYLE[verdict];
    return (
      <span
        key={tf}
        title={`${tf}: ${verdict.toUpperCase()}`}
        style={{
          fontSize: '9px',
          fontWeight: 800,
          padding: '2px 6px',
          borderRadius: '4px',
          background: style.bg,
          color: style.fg,
          letterSpacing: '0.02em',
        }}
      >
        {style.arrow} {tf.toUpperCase()}
      </span>
    );
  };

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

      <div style={{ padding: '6px 12px', borderBottom: '1px solid #1f2937', fontSize: '10px', color: '#6b7280', fontWeight: 800, letterSpacing: '0.04em', display: 'flex', gap: '6px', alignItems: 'center' }}>
        MULTI-TIMEFRAME
      </div>
      <div style={{ padding: '4px 12px 8px', display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
        {tfDot('4H', signal.verdict)}
        {signal.alignment.map((a) => tfDot(a.label.toUpperCase(), a.verdict))}
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

        {aiAnalysis && (
          <div style={{ marginTop: '8px', borderTop: '1px dashed #374151', paddingTop: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
              <div style={{ fontSize: '10px', fontWeight: 800, color: '#6b7280', letterSpacing: '0.04em' }}>
                ANALIS AI
              </div>
              <span
                style={{
                  fontSize: '10px',
                  fontWeight: 800,
                  color: aiAnalysis.source === 'llm' ? '#34d399' : '#fbbf24',
                }}
              >
                {aiAnalysis.source === 'llm' ? 'model' : 'fallback'}
              </span>
            </div>
            <div style={{ fontSize: '11px', color: '#d1d5db', lineHeight: 1.5, marginBottom: '4px' }}>
              <span style={{ fontWeight: 800, color: '#93c5fd' }}>Arah:</span>{' '}
              {aiAnalysis.direction === 'long'
                ? 'Long (cenderung naik)'
                : aiAnalysis.direction === 'short'
                  ? 'Short (cenderung turun)'
                  : 'Wait (tunggu konfirmasi)'}{' '}
              — confidensi {aiAnalysis.confidence}%
            </div>
            <div style={{ fontSize: '11px', color: '#d1d5db', lineHeight: 1.5, marginBottom: '4px' }}>
              <span style={{ fontWeight: 800, color: '#93c5fd' }}>Pattern:</span>{' '}
              {aiAnalysis.pattern}
            </div>
            <div style={{ fontSize: '11px', color: '#d1d5db', lineHeight: 1.5, marginBottom: '4px' }}>
              <span style={{ fontWeight: 800, color: '#93c5fd' }}>S/R:</span>{' '}
              {aiAnalysis.support != null
                ? `Support ${aiAnalysis.support.toFixed(2)}`
                : 'Support —'}{' · '}
              {aiAnalysis.resistance != null
                ? `Resistance ${aiAnalysis.resistance.toFixed(2)}`
                : 'Resistance —'}
            </div>
            <div style={{ fontSize: '11px', color: '#d1d5db', lineHeight: 1.5, marginBottom: '4px' }}>
              <span style={{ fontWeight: 800, color: '#93c5fd' }}>Sinyal:</span>{' '}
              {aiAnalysis.signal === 'buy'
                ? 'Beli (cenderung)'
                : aiAnalysis.signal === 'sell'
                  ? 'Jual (cenderung)'
                  : 'Tunggu'}
            </div>
            <div style={{ fontSize: '10px', color: '#9ca3af', lineHeight: 1.5 }}>
              {aiAnalysis.reasoning.join(' ')} {aiAnalysis.caveat}
            </div>
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
              TEKNIKAL (4H)
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
export default function FuturesTab({ visible }: FuturesTabProps) {
  const [data, setData] = useState<FuturesResponse | null>(null);
  const [aiResults, setAiResults] = useState<Record<string, FuturesAIOutput>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!visible) return;
    cancelledRef.current = false;
    setLoading(true);
    setError(null);
    fetch(`/api/futures?tf=${encodeURIComponent(FIXED_TF)}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
        return body as FuturesResponse;
      })
      .then((body) => {
        if (cancelledRef.current) return;
        setData(body);
        setLoading(false);
        fetchAiAnalysis(body);
      })
      .catch((err: Error) => {
        if (cancelledRef.current) return;
        setError(err.message);
        setLoading(false);
      });
    return () => {
      cancelledRef.current = true;
    };
  }, [visible]);

  async function fetchAiAnalysis(body: FuturesResponse): Promise<void> {
    const inputs = body.signals.map((s) => ({
      symbol: s.instrument.symbol,
      name: s.instrument.name,
      group: s.instrument.group,
      price: s.price,
      changePct: s.changePct,
      verdict: s.verdict,
      score: s.score,
      atrPct: s.atrPct,
      technicalReasons: s.reasons,
      alignment: s.alignment.map((a) => ({ tf: a.tf, label: a.label, verdict: a.verdict, score: a.score })),
      macroNote: s.macroNote,
      macro: { dxy: body.macro.dxy, vix: body.macro.vix, us10y: body.macro.us10y },
      candles: s.candles.slice(-60).map((c) => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      })),
    }));
    try {
      const res = await fetch('/api/futures-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(inputs),
      });
      if (!res.ok) throw new Error(`AI HTTP ${res.status}`);
      const { results } = (await res.json()) as { results: FuturesAIOutput[]; errors: string[] };
      if (!cancelledRef.current) {
        setAiResults(Object.fromEntries(results.map((r) => [r.symbol, r])));
      }
    } catch {
      // AI analisis opsional — tidak mengganggu tampilan utama.
    }
  }

  const grouped = useMemo(() => {
    if (!data) return [];
    return GROUP_ORDER.map((g) => ({
      group: g,
      items: data.signals.filter((s) => s.instrument.group === g),
    })).filter((g) => g.items.length > 0);
  }, [data]);

  return (
    <div>
      <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '8px', lineHeight: 1.5 }}>
        Timeframe acuan: 4H. Setiap kartu menampilkan arah 1H / 4H / 1D / 1W sekaligus.
      </div>

      <MacroStrip macro={data?.macro ?? null} />

      {loading && (
        <div style={{ padding: '28px', textAlign: 'center', color: '#6b7280', fontSize: '13px' }}>
          Memuat book futures 4H… ({FUTURES_BOOK.length} instrumen)
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
                  <SignalCard
                    key={s.instrument.id}
                    signal={s}
                    aiAnalysis={aiResults[s.instrument.symbol]}
                  />
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
