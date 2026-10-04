import React, { useMemo } from 'react';
import {
  ScanHistoryEntry,
  buyStreak,
} from '../../lib/scanHistory';

interface ScanHistoryProps {
  entries: ScanHistoryEntry[];
  /** Current live scan's regime, so the panel can flag a change. */
  currentRegime?: string | null;
}

/**
 * "What has the market been doing over the last N scans?" — a sparkline of
 * signal counts, the regime timeline, and coins that keep reappearing.
 *
 * Persistence is the useful signal here: a coin that shows up on three
 * consecutive scans is a rotating narrative, not a one-bar fluke.
 */
export default function ScanHistory({ entries, currentRegime }: ScanHistoryProps) {
  // Oldest → newest for plotting.
  const timeline = useMemo(() => [...entries].reverse(), [entries]);
  const latest = entries[0];

  /** Assets still buying in the newest scan, longest streak first. */
  const persisting = useMemo(() => {
    if (!latest) return [];
    return latest.buys
      .map((asset) => ({ asset, streak: buyStreak(entries, asset) }))
      .filter((x) => x.streak >= 2)
      .sort((a, b) => b.streak - a.streak)
      .slice(0, 8);
  }, [entries, latest]);

  /** Regimes seen, oldest → newest, collapsed into runs. */
  const regimeRuns = useMemo(() => {
    const runs: Array<{ label: string; count: number }> = [];
    for (const e of timeline) {
      const label = e.regimeLabel ?? 'unknown';
      const last = runs[runs.length - 1];
      if (last && last.label === label) last.count++;
      else runs.push({ label, count: 1 });
    }
    return runs.slice(-5);
  }, [timeline]);

  if (entries.length === 0) return null;

  const maxSignals = Math.max(1, ...timeline.map((e) => e.signalsCount));
  const prev = entries[1];
  const delta = prev ? latest!.signalsCount - prev.signalsCount : null;
  const regimeChanged =
    currentRegime &&
    latest?.regimeLabel &&
    latest.regimeLabel !== currentRegime;

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
            📈 Riwayat Scan
          </h3>
          <p style={{ fontSize: '10px', color: '#6b7280', margin: 0 }}>
            {entries.length} scan terakhir · {latest ? formatWhen(latest.scannedAt) : '—'}
          </p>
        </div>
        <div className="ah-chip-row">
          <span style={{
            padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
            background: 'rgba(59,130,246,0.14)', border: '1px solid rgba(59,130,246,0.35)',
            color: '#3b82f6',
          }}>
            {latest?.signalsCount ?? 0} sinyal
          </span>
          {delta != null && delta !== 0 && (
            <span style={{
              padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
              background: delta > 0 ? 'rgba(16,185,129,0.14)' : 'rgba(239,68,68,0.14)',
              border: `1px solid ${delta > 0 ? 'rgba(16,185,129,0.35)' : 'rgba(239,68,68,0.35)'}`,
              color: delta > 0 ? '#10b981' : '#ef4444',
            }}>
              {delta > 0 ? '▲' : '▼'} {Math.abs(delta)} vs scan lalu
            </span>
          )}
          {regimeChanged && (
            <span style={{
              padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
              background: 'rgba(245,158,11,0.14)', border: '1px solid rgba(245,158,11,0.4)',
              color: '#f59e0b',
            }}>
              ⚠️ Regime berubah → {String(currentRegime).replace(/_/g, ' ')}
            </span>
          )}
        </div>
      </div>

      <div style={{ padding: '14px 16px' }}>
        {/* Sparkline — bar counts, not a line: easy to read at a glance on mobile. */}
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: '3px', height: '56px', marginBottom: '6px' }}>
          {timeline.map((e) => {
            const h = Math.max(4, Math.round((e.signalsCount / maxSignals) * 56));
            return (
              <div
                key={e.scannedAt}
                title={`${formatWhen(e.scannedAt)} — ${e.signalsCount} sinyal${e.regimeLabel ? ` · ${e.regimeLabel}` : ''}`}
                style={{
                  flex: '1 1 0',
                  minWidth: '3px',
                  maxWidth: '22px',
                  height: `${h}px`,
                  borderRadius: '3px 3px 0 0',
                  background: e.regimeLabel && /trend/i.test(e.regimeLabel)
                    ? 'linear-gradient(180deg, #10b981, #059669)'
                    : e.regimeLabel && /volatile/i.test(e.regimeLabel)
                      ? 'linear-gradient(180deg, #f59e0b, #d97706)'
                      : 'linear-gradient(180deg, #3b82f6, #2563eb)',
                  opacity: e === latest ? 1 : 0.75,
                }}
              />
            );
          })}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9px', color: '#4b5563' }}>
          <span>{timeline.length > 0 ? formatWhen(timeline[0].scannedAt) : ''}</span>
          <span>{timeline.length > 1 ? formatWhen(timeline[timeline.length - 1].scannedAt) : ''}</span>
        </div>

        {/* Regime timeline */}
        {regimeRuns.length > 0 && (
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', margin: '12px 0 0', fontSize: '10px' }}>
            {regimeRuns.map((r, i) => (
              <span key={`${r.label}-${i}`} style={{
                padding: '3px 8px', borderRadius: '5px',
                background: '#0a0e17', border: '1px solid #374151', color: '#9ca3af',
              }}>
                {r.label.replace(/_/g, ' ')}
                {r.count > 1 && <span style={{ opacity: 0.6 }}> ×{r.count}</span>}
              </span>
            ))}
          </div>
        )}

        {/* Persistence — the actual insight */}
        {persisting.length > 0 ? (
          <div style={{ marginTop: '14px' }}>
            <div style={{
              fontSize: '9px', fontWeight: 700, color: '#6b7280',
              textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px',
            }}>
              🔁 Muncul beruntun (sinyal bertahan, bukan noise sekali jalan)
            </div>
            <div className="ah-chips" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {persisting.map(({ asset, streak }) => (
                <span key={asset} style={{
                  display: 'inline-flex', alignItems: 'center', gap: '5px',
                  padding: '4px 9px', borderRadius: '6px',
                  background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.3)',
                  color: '#10b981', fontSize: '11px', fontWeight: 700,
                }}>
                  {asset}
                  <span style={{
                    background: '#10b981', color: '#04121a',
                    borderRadius: '4px', padding: '0 5px', fontSize: '9px',
                  }}>
                    {streak}×
                  </span>
                </span>
              ))}
            </div>
          </div>
        ) : (
          <p style={{ fontSize: '10px', color: '#6b7280', margin: '12px 0 0', lineHeight: 1.6 }}>
            Belum ada sinyal buy yang bertahan 2 scan berturut-turut — pasar belum membentuk narasi
            yang konsisten. Dua scan lagi biasanya sudah cukup untuk mulai percaya.
          </p>
        )}
      </div>
    </div>
  );
}

function formatWhen(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay
    ? d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }) +
      ' ' +
      d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}
