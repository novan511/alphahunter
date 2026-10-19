import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Laboratorium Monte Carlo otonom.
 *
 * Tiga hal yang harus terlihat jujur:
 *  - Progres iterasi (AI memilih → engine menjalankan → putusan), bukan spinner
 *    tanpa arti.
 *  - Riwayat lengkap dengan angka OOS dan MC, bukan hanya "hasil terbaik".
 *  - Batas: jumlah sampel, rentang data, dan fakta bahwa ini uji historis.
 */

interface SegmentMetrics {
  trades: number;
  winRate: number;
  profitFactor: number;
  expectancyR: number;
  totalReturnPct: number;
  cagrPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  buyHoldPct: number;
  exposurePct: number;
  bars: number;
}

interface McResult {
  iterations: number;
  probProfit: number;
  p5Pct: number;
  p50Pct: number;
  p95Pct: number;
  worstPct: number;
  bestPct: number;
}

interface StoredTrade {
  entryTime: number;
  exitTime: number;
  side: 'buy' | 'sell';
  entry: number;
  exit: number;
  stop: number;
  target: number;
  bars: number;
  r: number;
  balance: number;
  reason: string;
}

interface LabMetrics {
  full?: SegmentMetrics;
  oos?: SegmentMetrics[];
  oosPositive?: number;
  mc?: McResult;
  params?: Record<string, number | boolean>;
  trades?: StoredTrade[];
  tradesTotal?: number;
  tradesTruncated?: boolean;
  filterBlockedPct?: number;
  dataFrom?: number;
  dataTo?: number;
  bars?: number;
  notes?: string[];
  benchmark?: string | null;
}

interface LabRun {
  id: string;
  created_at: string;
  status: 'running' | 'done' | 'failed';
  stage: string | null;
  progress: number | null;
  asset: string | null;
  interval: string | null;
  family: string | null;
  macro_filter: string | null;
  verdict: string | null;
  score: number | null;
  reasons: string[] | null;
  rationale: string | null;
  source: string | null;
  metrics: LabMetrics | null;
  error: string | null;
}

interface GroupSummary {
  id: string;
  label: string;
  assets: string[];
  summary: { tested: number; promising: number; best: LabRun | null } | null;
}

interface LabPayload {
  ok: boolean;
  configured: boolean;
  reason?: string;
  warning?: string;
  cooldownMinutes: number;
  latest: LabRun | null;
  runs: LabRun[];
  due: boolean;
  nextDueAt: number | null;
  groups: GroupSummary[];
}

const STAGES = [
  { key: 'menyiapkan', label: 'AI memilih hipotesis', at: 5 },
  { key: 'Memuat data harga', label: 'Memuat data harga', at: 10 },
  { key: 'Menghitung indikator', label: 'Menghitung indikator', at: 25 },
  { key: 'Membangun sinyal', label: 'Membangun sinyal', at: 40 },
  { key: 'Menerapkan filter makro', label: 'Filter makro (FRED)', at: 50 },
  { key: 'Backtest penuh', label: 'Backtest penuh', at: 60 },
  { key: 'Walk-forward out-of-sample', label: 'Walk-forward OOS', at: 72 },
  { key: 'Monte Carlo bootstrap', label: 'Monte Carlo bootstrap', at: 85 },
  { key: 'menilai hasil', label: 'Putusan', at: 95 },
];

const VERDICT_STYLE: Record<string, { label: string; color: string }> = {
  strong: { label: 'Kuat', color: '#10b981' },
  promising: { label: 'Menjanjikan', color: '#3b82f6' },
  weak: { label: 'Lemah', color: '#f59e0b' },
  none: { label: 'Tidak ada edge', color: '#ef4444' },
};

const FAMILY_LABEL: Record<string, string> = {
  trend: 'Trend (EMA cross)',
  momentum: 'Momentum (ROC+RSI)',
  breakout: 'Breakout (Donchian)',
  meanrev: 'Mean reversion (z-score)',
  rs: 'RS decoupling',
  pattern: 'Pattern level',
};

function fmtPct(v: number | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

function fmtDate(t: number | undefined): string {
  if (!t) return '—';
  return new Date(t * 1000).toISOString().slice(0, 10);
}

function prettyAsset(id: string | null): string {
  if (!id) return '—';
  return id.replace(/^(binance|hyperliquid|yahoo):/, '').replace('USDT', '');
}

/**
 * fetch + parse yang tidak meledak pada respons kosong/304 (browser memaksa
 * revalidate meski server mengirim no-store di beberapa jalur CDN) dan
 * menerjemahkan pesan error API jadi kalimat yang bisa dibaca.
 */
async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text.trim()) {
    throw new Error(res.ok ? 'respons kosong dari server' : `server menjawab ${res.status} tanpa isi`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(res.ok ? 'respons server tidak bisa dibaca' : `server menjawab ${res.status}`);
  }
  if (!res.ok) {
    const msg = (json as { error?: string; reason?: string }).error || (json as { reason?: string }).reason;
    throw new Error(msg || `server menjawab ${res.status}`);
  }
  return json as Record<string, unknown>;
}

export default function McLabPanel() {
  const [data, setData] = useState<LabPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [now, setNow] = useState(Date.now());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const json = await readJson(await fetch('/api/mc-lab?limit=60', { cache: 'no-store' }));
      setData(json as unknown as LabPayload);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'gagal memuat riwayat lab');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Polling cepat saat ada iterasi berjalan ATAU saat tombol baru ditekan
  // (POST masih menunggu dan baris "running" belum terbaca). Tanpa ini progres
  // manual baru muncul setelah request selesai — persis yang tidak diinginkan.
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    const running = data?.latest?.status === 'running';
    const fast = running || starting;
    pollRef.current = setInterval(load, fast ? 2500 : 15_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [data?.latest?.status, starting, load]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const run = useCallback(async () => {
    setStarting(true);
    setError(null);
    try {
      const json = await readJson(
        await fetch('/api/mc-lab', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
      );
      if (!json.ok) setError((json.reason as string) || (json.error as string) || 'iterasi tidak berjalan');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'gagal memulai iterasi');
    } finally {
      setStarting(false);
    }
  }, [load]);

  const runs = data?.runs || [];
  const latest = data?.latest || null;
  const running = latest?.status === 'running';
  const doneRuns = useMemo(() => runs.filter((r) => r.status === 'done'), [runs]);

  const countdown = useMemo(() => {
    if (!data?.nextDueAt) return null;
    const diff = data.nextDueAt - now;
    if (diff <= 0) return 'siap';
    const m = Math.floor(diff / 60_000);
    const s = Math.floor((diff % 60_000) / 1000);
    return `${m}:${String(s).padStart(2, '0')}`;
  }, [data?.nextDueAt, now]);

  const bestRun = useMemo(
    () => doneRuns.slice().sort((a, b) => (b.score || 0) - (a.score || 0))[0] || null,
    [doneRuns]
  );

  const conclusion = useMemo(() => {
    if (doneRuns.length === 0) return null;
    const strong = doneRuns.filter((r) => r.verdict === 'strong' || r.verdict === 'promising');
    const byFamily = new Map<string, { tested: number; good: number }>();
    for (const r of doneRuns) {
      const key = r.family || 'unknown';
      const cur = byFamily.get(key) || { tested: 0, good: 0 };
      cur.tested++;
      if (r.verdict === 'strong' || r.verdict === 'promising') cur.good++;
      byFamily.set(key, cur);
    }
    const familyRank = Array.from(byFamily.entries())
      .filter(([, v]) => v.tested >= 3)
      .sort((a, b) => b[1].good / b[1].tested - a[1].good / a[1].tested);
    const byAsset = new Map<string, { tested: number; good: number }>();
    for (const r of doneRuns) {
      const key = r.asset || 'unknown';
      const cur = byAsset.get(key) || { tested: 0, good: 0 };
      cur.tested++;
      if (r.verdict === 'strong' || r.verdict === 'promising') cur.good++;
      byAsset.set(key, cur);
    }
    const assetRank = Array.from(byAsset.entries())
      .filter(([, v]) => v.tested >= 2)
      .sort((a, b) => b[1].good / b[1].tested - a[1].good / a[1].tested);
    return { strong, familyRank, assetRank };
  }, [doneRuns]);

  if (!data && !error) {
    return (
      <div style={card}>
        <div style={{ fontSize: '12px', color: '#9ca3af' }}>Memuat laboratorium…</div>
      </div>
    );
  }

  if (data && !data.configured) {
    const needsMigration = /tabel mc_lab_runs/i.test(data.reason || '');
    return (
      <div style={card}>
        <h3 style={h3}>🤖 Laboratorium Monte Carlo Otonom</h3>
        <p style={{ fontSize: '12px', color: '#f59e0b', lineHeight: 1.6, margin: '0 0 8px' }}>
          {data.reason}
        </p>
        <p style={{ fontSize: '11px', color: '#6b7280', lineHeight: 1.7, margin: 0 }}>
          {needsMigration ? (
            <>Jalankan <code>supabase/migrations/016_mc_lab_runs.sql</code> sekali di Supabase SQL Editor.</>
          ) : (
            <>
              Yang dibutuhkan: <code>NEXT_PUBLIC_SUPABASE_URL</code> dan{' '}
              <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>, lalu migrasi{' '}
              <code>016_mc_lab_runs.sql</code>. Service-role key bersifat opsional.
            </>
          )}
        </p>
      </div>
    );
  }

  return (
    <div style={{ marginBottom: '24px' }}>
      {/* Peringatan non-blocking: lab tetap jalan lewat anon key. */}
      {data?.warning && (
        <div
          style={{
            ...card,
            borderColor: 'rgba(245,158,11,0.4)',
            background: 'rgba(245,158,11,0.07)',
            marginBottom: '12px',
            padding: '10px 14px',
          }}
        >
          <span style={{ fontSize: '11px', color: '#f59e0b', lineHeight: 1.6 }}>⚠️ {data.warning}</span>
        </div>
      )}
      {/* Header + kontrol */}
      <div style={{ ...card, marginBottom: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: '280px' }}>
            <h3 style={{ ...h3, marginBottom: '6px' }}>🤖 Laboratorium Monte Carlo Otonom</h3>
            <p style={{ fontSize: '12px', color: '#9ca3af', lineHeight: 1.6, margin: 0 }}>
              AI hanya mengusulkan hipotesis (aset, timeframe, keluarga indikator, parameter, filter makro).
              Engine menghitung semuanya deterministik: backtest penuh, 3 jendela out-of-sample, lalu
              bootstrap Monte Carlo. Satu iterasi tiap {data?.cooldownMinutes ?? 10} menit; iterasi
              berikutnya melanjutkan dari temuan sebelumnya.
            </p>
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            {countdown && !running && (
              <span style={{ fontSize: '11px', color: '#6b7280' }}>
                iterasi berikutnya: <strong style={{ color: '#9ca3af' }}>{countdown}</strong>
              </span>
            )}
            <button
              onClick={run}
              disabled={starting || running}
              style={{
                padding: '8px 16px',
                background: starting || running ? '#4b5563' : 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
                border: 'none',
                borderRadius: '8px',
                color: 'white',
                fontSize: '12px',
                fontWeight: 600,
                cursor: starting || running ? 'not-allowed' : 'pointer',
              }}
            >
              {running ? 'Iterasi berjalan…' : starting ? 'Memulai…' : 'Jalankan iterasi sekarang'}
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div style={{ ...card, borderColor: 'rgba(239,68,68,0.4)', background: 'rgba(239,68,68,0.08)', marginBottom: '12px' }}>
          <span style={{ fontSize: '12px', color: '#ef4444' }}>{error}</span>
        </div>
      )}

      {/* Progres */}
      <div style={{ ...card, marginBottom: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '10px', gap: '12px', flexWrap: 'wrap' }}>
          <h4 style={h4}>
            {running ? 'Proses iterasi' : latest ? 'Iterasi terakhir' : 'Belum ada iterasi'}
          </h4>
          {latest && (
            <span style={{ fontSize: '11px', color: '#6b7280' }}>
              {prettyAsset(latest.asset)} · {latest.interval} · {FAMILY_LABEL[latest.family || ''] || latest.family}
              {latest.status === 'failed' && <span style={{ color: '#ef4444' }}> · gagal</span>}
            </span>
          )}
        </div>

        <div style={{ height: '8px', background: '#1f2937', borderRadius: '999px', overflow: 'hidden', marginBottom: '10px' }}>
          <div
            style={{
              width: `${Math.max(0, Math.min(100, latest?.progress ?? 0))}%`,
              height: '100%',
              background: latest?.status === 'failed'
                ? '#ef4444'
                : 'linear-gradient(90deg, #3b82f6, #8b5cf6)',
              transition: 'width 0.6s ease',
            }}
          />
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', marginBottom: '12px' }}>
          <span style={{ fontSize: '12px', color: running ? '#3b82f6' : '#9ca3af' }}>
            {latest?.status === 'failed'
              ? `Gagal: ${latest.error || 'tidak diketahui'}`
              : running
                ? `${latest?.stage || 'menyiapkan'} · ${Math.round(latest?.progress ?? 0)}%`
                : latest?.status === 'done'
                  ? `Selesai · putusan ${VERDICT_STYLE[latest.verdict || 'none']?.label || latest.verdict}`
                  : 'Menunggu'}
          </span>
          {latest?.rationale && (
            <span style={{ fontSize: '11px', color: '#6b7280', flex: 1, minWidth: '240px', textAlign: 'right' }}>
              {latest.rationale}
            </span>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '6px' }}>
          {STAGES.map((s) => {
            const reached = (latest?.progress ?? 0) >= s.at;
            const active = running && latest?.stage === s.key;
            return (
              <div
                key={s.key}
                style={{
                  fontSize: '10px',
                  padding: '5px 8px',
                  borderRadius: '6px',
                  border: `1px solid ${active ? '#3b82f6' : reached ? '#1f2937' : '#1f2937'}`,
                  background: active ? 'rgba(59,130,246,0.12)' : reached ? 'rgba(16,185,129,0.06)' : 'transparent',
                  color: active ? '#93c5fd' : reached ? '#9ca3af' : '#4b5563',
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: '6px',
                }}
              >
                <span>{s.label}</span>
                <span>{reached ? '✓' : '·'}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Kesimpulan */}
      {conclusion && bestRun && (
        <div style={{ ...card, marginBottom: '12px' }}>
          <h4 style={{ ...h4, marginBottom: '10px' }}>Kesimpulan sejauh ini</h4>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px', marginBottom: '12px' }}>
            <Kpi label="Eksperimen selesai" value={String(doneRuns.length)} />
            <Kpi
              label="Lolos uji OOS"
              value={`${conclusion.strong.length} / ${doneRuns.length}`}
              color={conclusion.strong.length ? '#10b981' : '#ef4444'}
            />
            <Kpi
              label="Skor tertinggi"
              value={bestRun ? `${bestRun.score ?? 0} · ${prettyAsset(bestRun.asset)}` : '—'}
            />
            <Kpi
              label="Keluarga indikator terbaik"
              value={
                conclusion.familyRank.length
                  ? FAMILY_LABEL[conclusion.familyRank[0][0]] || conclusion.familyRank[0][0]
                  : 'sampel belum cukup'
              }
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '12px' }}>
            <div>
              <div style={miniLabel}>Indikator dengan rasio lolos tertinggi (min. 3 uji)</div>
              {conclusion.familyRank.length === 0 && <div style={muted}>Belum cukup sampel.</div>}
              {conclusion.familyRank.slice(0, 4).map(([fam, v]) => (
                <div key={fam} style={rankRow}>
                  <span style={{ color: '#f9fafb' }}>{FAMILY_LABEL[fam] || fam}</span>
                  <span style={{ color: v.good ? '#10b981' : '#6b7280' }}>
                    {v.good}/{v.tested}
                  </span>
                </div>
              ))}
            </div>
            <div>
              <div style={miniLabel}>Aset dengan rasio lolos tertinggi (min. 2 uji)</div>
              {conclusion.assetRank.length === 0 && <div style={muted}>Belum cukup sampel.</div>}
              {conclusion.assetRank.slice(0, 6).map(([asset, v]) => (
                <div key={asset} style={rankRow}>
                  <span style={{ color: '#f9fafb' }}>{prettyAsset(asset)}</span>
                  <span style={{ color: v.good ? '#10b981' : '#6b7280' }}>
                    {v.good}/{v.tested}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <p style={{ fontSize: '11px', color: '#6b7280', lineHeight: 1.6, margin: '12px 0 0' }}>
            "Lolos" berarti minimal 2 dari 3 jendela out-of-sample positif dengan profit factor ≥ 1,
            sampel ≥ 20 trade, dan Monte Carlo tidak menunjukkan mayoritas hasil negatif. Ini uji
            historis, bukan jaminan performa masa depan.
          </p>
        </div>
      )}

      {/* Ringkasan grup */}
      {data?.groups?.length ? (
        <div style={{ ...card, marginBottom: '12px' }}>
          <h4 style={{ ...h4, marginBottom: '10px' }}>Cakupan per kelas aset</h4>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' }}>
            {data.groups.map((g) => (
              <div key={g.id} style={{ border: '1px solid #1f2937', borderRadius: '8px', padding: '10px 12px' }}>
                <div style={{ fontSize: '12px', color: '#f9fafb', fontWeight: 600, marginBottom: '4px' }}>{g.label}</div>
                <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '6px' }}>
                  {g.assets.map(prettyAsset).join(' · ')}
                </div>
                <div style={{ fontSize: '11px', color: g.summary ? '#9ca3af' : '#4b5563' }}>
                  {g.summary
                    ? `${g.summary.tested} diuji · ${g.summary.promising} lolos`
                    : 'belum ada 3 eksperimen'}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* Riwayat */}
      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #374151', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
          <h4 style={{ ...h4, margin: 0 }}>Riwayat iterasi</h4>
          <span style={{ fontSize: '11px', color: '#6b7280' }}>
            {doneRuns.length} selesai · {runs.filter((r) => r.status === 'failed').length} gagal
          </span>
        </div>
        <div className="ah-scroll">
          <table style={{ width: '100%', minWidth: '1080px', borderCollapse: 'collapse', fontSize: '12px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #374151' }}>
                <th style={th}>Waktu</th>
                <th style={th}>Aset</th>
                <th style={th}>Keluarga</th>
                <th style={th}>TF</th>
                <th style={th}>Makro</th>
                <th style={th}>Trade</th>
                <th style={th}>Return</th>
                <th style={th}>PF</th>
                <th style={th}>Max DD</th>
                <th style={th}>OOS</th>
                <th style={th}>MC profit</th>
                <th style={th}>Putusan</th>
              </tr>
            </thead>
            <tbody>
              {runs.length === 0 && (
                <tr>
                  <td colSpan={12} style={{ ...td, color: '#6b7280', textAlign: 'center', padding: '24px' }}>
                    Belum ada iterasi. Tekan "Jalankan iterasi sekarang" atau tunggu cron 10 menit.
                  </td>
                </tr>
              )}
              {runs.map((r) => {
                const m = r.metrics?.full;
                const vs = VERDICT_STYLE[r.verdict || 'none'];
                return (
                  <tr key={r.id} style={{ borderBottom: '1px solid #1f2937' }}>
                    <td style={{ ...td, color: '#6b7280', whiteSpace: 'nowrap' }}>
                      {new Date(r.created_at).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' })}
                    </td>
                    <td style={{ ...td, color: '#f9fafb', fontWeight: 600 }}>{prettyAsset(r.asset)}</td>
                    <td style={{ ...td, color: '#9ca3af' }}>{FAMILY_LABEL[r.family || ''] || r.family || '—'}</td>
                    <td style={td}>{r.interval || '—'}</td>
                    <td style={{ ...td, color: r.macro_filter === 'none' ? '#6b7280' : '#93c5fd' }}>
                      {r.macro_filter || 'none'}
                    </td>
                    <td style={td}>{m ? m.trades : '—'}</td>
                    <td style={{ ...td, color: (m?.totalReturnPct ?? 0) >= 0 ? '#10b981' : '#ef4444' }}>
                      {m ? fmtPct(m.totalReturnPct) : '—'}
                    </td>
                    <td style={{ ...td, color: '#f59e0b' }}>{m ? m.profitFactor.toFixed(2) : '—'}</td>
                    <td style={{ ...td, color: '#ef4444' }}>{m ? `${m.maxDrawdownPct.toFixed(1)}%` : '—'}</td>
                    <td style={td}>
                      {r.metrics?.oos?.length
                        ? `${r.metrics.oosPositive ?? 0}/${r.metrics.oos.length}`
                        : '—'}
                    </td>
                    <td style={td}>
                      {r.metrics?.mc?.iterations ? `${(r.metrics.mc.probProfit * 100).toFixed(0)}%` : '—'}
                    </td>
                    <td style={td}>
                      {r.status === 'running' ? (
                        <span style={{ color: '#3b82f6' }}>{r.progress ?? 0}%</span>
                      ) : r.status === 'failed' ? (
                        <span style={{ color: '#ef4444' }}>gagal</span>
                      ) : (
                        <span style={{ color: vs?.color || '#9ca3af', fontWeight: 600 }}>
                          {vs?.label || r.verdict} {r.score != null ? `· ${r.score}` : ''}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Detail run terbaik */}
      {bestRun && <RunDetail run={bestRun} />}
    </div>
  );
}

const REASON_LABEL: Record<string, string> = {
  stop: 'SL',
  target: 'TP',
  time: 'Waktu',
  end: 'Akhir data',
};

/**
 * Chart setup per trade: candlestick + kotak stop/target + label R, seperti
 * rencana backtest manual pada gambar referensi. Skala harga mencakup stop &
 * target supaya seluruh kotak setup terlihat, bukan hanya pergerakan harga.
 */
function TradeChart({ run }: { run: LabRun }) {
  const all = run.metrics?.trades || [];
  const [count, setCount] = useState(20);
  const [candles, setCandles] = useState<Array<{ t: number; o: number; h: number; l: number; c: number }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const selected = useMemo(() => all.slice(-count), [all, count]);
  const from = selected.length ? selected[0].entryTime : 0;
  const to = selected.length ? selected[selected.length - 1].exitTime : 0;

  useEffect(() => {
    if (!selected.length) return;
    let alive = true;
    setCandles(null);
    setError(null);
    fetch(
      `/api/mc-lab-candles?asset=${encodeURIComponent(run.asset || '')}&interval=${encodeURIComponent(run.interval || '1d')}&from=${from}&to=${to}`,
      { cache: 'no-store' }
    )
      .then((r) => readJson(r))
      .then((j) => {
        if (!alive) return;
        setCandles((j.candles as Array<{ t: number; o: number; h: number; l: number; c: number }>) || []);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : 'gagal memuat candle');
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id, count, from, to, attempt]);

  if (!all.length) {
    return (
      <div style={{ marginBottom: '14px' }}>
        <div style={miniLabel}>Chart setup per trade</div>
        <div style={muted}>Detail trade tidak tersimpan untuk run ini (data lama sebelum fitur ini).</div>
      </div>
    );
  }

  const counts = { stop: 0, target: 0, time: 0, end: 0 } as Record<string, number>;
  for (const t of all) counts[t.reason] = (counts[t.reason] || 0) + 1;

  const total = all.length;
  const winCount = all.filter((t) => t.r > 0).length;

  return (
    <div style={{ marginBottom: '14px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '6px' }}>
        <div style={miniLabel}>
          Chart setup per trade — {winCount}/{total} trade profit
          {' · '}TP {counts.target || 0} · SL {counts.stop || 0} · waktu {counts.time || 0}
          {run.metrics?.tradesTruncated ? ` (dari ${run.metrics?.tradesTotal} trade, 300 terakhir)` : ''}
        </div>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <span style={{ fontSize: '10px', color: '#6b7280' }}>tampilkan</span>
          {[10, 20, 50, 100].map((n) => (
            <button
              key={n}
              onClick={() => setCount(n)}
              style={{
                padding: '3px 9px',
                fontSize: '10px',
                borderRadius: '6px',
                border: `1px solid ${count === n ? '#3b82f6' : '#374151'}`,
                background: count === n ? 'rgba(59,130,246,0.15)' : 'transparent',
                color: count === n ? '#93c5fd' : '#6b7280',
                cursor: 'pointer',
              }}
            >
              {n} terakhir
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: '10px',
            alignItems: 'center',
            fontSize: '11px',
            color: '#ef4444',
            marginBottom: '8px',
            border: '1px solid rgba(239,68,68,0.3)',
            background: 'rgba(239,68,68,0.06)',
            borderRadius: '8px',
            padding: '8px 12px',
          }}
        >
          <span>Candle gagal dimuat: {error}</span>
          <button
            onClick={() => setAttempt((a) => a + 1)}
            style={{
              padding: '4px 12px',
              fontSize: '10px',
              borderRadius: '6px',
              border: '1px solid #ef4444',
              background: 'transparent',
              color: '#ef4444',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            Coba lagi
          </button>
        </div>
      )}
      {!candles && !error && <div style={{ ...muted, marginBottom: '8px' }}>Memuat candle…</div>}

      {candles && candles.length > 0 && (() => {
        const drawable = selected.filter((t) => t.entryTime >= candles[0].t);
        return (
          <>
            {drawable.length < selected.length && (
              <div style={{ fontSize: '10px', color: '#f59e0b', marginBottom: '6px' }}>
                {selected.length - drawable.length} trade terlama di luar jangkauan chart (data terlalu panjang) — kurangi jumlah trade yang ditampilkan.
              </div>
            )}
            <TradeSvg trades={drawable} candles={candles} />
          </>
        );
      })()}

      {candles && candles.length > 0 && (
        <div className="ah-scroll" style={{ marginTop: '10px' }}>
          <table style={{ width: '100%', minWidth: '620px', borderCollapse: 'collapse', fontSize: '11px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #374151' }}>
                <th style={th}>#</th>
                <th style={th}>Masuk</th>
                <th style={th}>Keluar</th>
                <th style={th}>Arah</th>
                <th style={th}>Entry → Exit</th>
                <th style={th}>Hasil</th>
                <th style={th}>Exit via</th>
                <th style={th}>Bar</th>
                <th style={th}>Saldo ($1.000 awal, risiko 1%)</th>
              </tr>
            </thead>
            <tbody>
              {selected
                .slice()
                .reverse()
                .map((t, i) => (
                  <tr key={`${t.entryTime}-${i}`} style={{ borderBottom: '1px solid #1f2937' }}>
                    <td style={{ ...td, color: '#6b7280' }}>{total - selected.length + i + 1}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtDate(t.entryTime)}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtDate(t.exitTime)}</td>
                    <td style={{ ...td, color: t.side === 'buy' ? '#10b981' : '#f59e0b' }}>{t.side === 'buy' ? 'Long' : 'Short'}</td>
                    <td style={{ ...td, color: '#9ca3af' }}>
                      {t.entry.toPrecision(6)} → {t.exit.toPrecision(6)}
                    </td>
                    <td style={{ ...td, fontWeight: 700, color: t.r >= 0 ? '#10b981' : '#ef4444' }}>
                      {t.r >= 0 ? '+' : ''}
                      {t.r.toFixed(2)}R
                    </td>
                    <td style={{ ...td, color: t.reason === 'target' ? '#10b981' : t.reason === 'stop' ? '#ef4444' : '#f59e0b' }}>
                      {REASON_LABEL[t.reason] || t.reason}
                    </td>
                    <td style={td}>{t.bars}</td>
                    <td style={{ ...td, color: '#f9fafb' }}>${t.balance.toLocaleString('id-ID', { maximumFractionDigits: 2 })}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TradeSvg({
  trades,
  candles,
}: {
  trades: StoredTrade[];
  candles: Array<{ t: number; o: number; h: number; l: number; c: number }>;
}) {
  const W = 1000;
  const H = 340;
  const padL = 6;
  const padR = 62;
  const padT = 14;
  const padB = 24;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  // Index bar berdasarkan waktu, dengan fallback bar terdekat (mis. candle
  // libur pasar melompat sehingga waktu trade tidak persis sama).
  const idxOf = (time: number): number => {
    if (candles.length === 0) return 0;
    let lo = 0;
    let hi = candles.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (candles[mid].t < time) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  if (candles.length < 2 || trades.length === 0) return null;

  const lo = Math.min(
    ...candles.map((c) => c.l),
    ...trades.flatMap((t) => [t.stop, t.target])
  );
  const hi = Math.max(
    ...candles.map((c) => c.h),
    ...trades.flatMap((t) => [t.stop, t.target])
  );
  const range = hi - lo || 1;
  const y = (p: number) => padT + (1 - (p - lo) / range) * plotH;
  const barW = plotW / Math.max(candles.length, 1);
  const x = (i: number) => padL + (i + 0.5) * barW;
  const bodyW = Math.max(1, barW * 0.62);
  const dp = hi >= 1000 ? 0 : hi >= 10 ? 2 : 4;
  const fmt = (p: number) => p.toFixed(dp);

  const gridSteps = 4;
  const gridlines = Array.from({ length: gridSteps + 1 }, (_, i) => lo + (range * i) / gridSteps);
  const labelEvery = Math.max(1, Math.ceil(candles.length / 7));

  return (
    <div style={{ width: '100%', overflowX: 'auto' }} className="ah-scroll">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block', minWidth: '700px', background: '#0b1120', border: '1px solid #1f2937', borderRadius: '8px' }}>
        {gridlines.map((p, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y(p)} y2={y(p)} stroke="#1f2937" strokeWidth="1" />
            <text x={W - padR + 6} y={y(p) + 3} fill="#6b7280" fontSize="9">{fmt(p)}</text>
          </g>
        ))}

        {candles.map((c, i) => {
          const up = c.c >= c.o;
          const color = up ? '#10b981' : '#ef4444';
          const bodyTop = y(Math.max(c.o, c.c));
          const bodyH = Math.max(1, y(Math.min(c.o, c.c)) - bodyTop);
          return (
            <g key={c.t}>
              <line x1={x(i)} x2={x(i)} y1={y(c.h)} y2={y(c.l)} stroke={color} strokeWidth={Math.min(1.2, Math.max(0.5, barW * 0.1))} />
              <rect x={x(i) - bodyW / 2} y={bodyTop} width={bodyW} height={bodyH} fill={color} opacity={up ? 0.9 : 0.85} />
            </g>
          );
        })}

        {trades.map((t, k) => {
          const i1 = idxOf(t.entryTime);
          const i2 = idxOf(t.exitTime);
          const win = t.r >= 0;
          const color = win ? '#10b981' : '#ef4444';
          const top = y(Math.max(t.stop, t.target));
          const bottom = y(Math.min(t.stop, t.target));
          const x1 = x(Math.max(0, i1 - 1));
          const x2 = x(Math.min(candles.length - 1, i2 + 1));
          const labelR = `${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)}R`;
          const labelY = win ? top - 4 : bottom + 11;
          return (
            <g key={`${t.entryTime}-${k}`}>
              {/* Zona setup: dari stop sampai target selama posisi hidup */}
              <rect x={x1} y={top} width={Math.max(2, x2 - x1)} height={Math.max(2, bottom - top)} fill={color} opacity="0.10" stroke={color} strokeWidth="0.8" strokeOpacity="0.5" />
              {/* Garis entry */}
              <line
                x1={x1}
                x2={x2}
                y1={y(t.entry)}
                y2={y(t.entry)}
                stroke="#fbbf24"
                strokeWidth="1"
                strokeDasharray="4 3"
              />
              <text
                x={x2}
                y={labelY}
                fill={color}
                fontSize="10"
                fontWeight="700"
                textAnchor="end"
                stroke="#0b1120"
                strokeWidth="3"
                paintOrder="stroke"
              >
                {labelR}
              </text>
              {k === 0 && (
                <text x={x1} y={y(t.entry) - 4} fill="#fbbf24" fontSize="8.5" textAnchor="start" stroke="#0b1120" strokeWidth="2.5" paintOrder="stroke">
                  Entry
                </text>
              )}
            </g>
          );
        })}

        {candles
          .filter((_, i) => i % labelEvery === 0)
          .map((c) => {
            const i = idxOf(c.t);
            return (
              <text key={`lbl-${c.t}`} x={x(i)} y={H - 8} fill="#6b7280" fontSize="9" textAnchor="middle">
                {new Date(c.t * 1000).toISOString().slice(5, 10)}
              </text>
            );
          })}
      </svg>
    </div>
  );
}

function RunDetail({ run }: { run: LabRun }) {  const m = run.metrics;
  const full = m?.full;
  const mc = m?.mc;
  const params = m?.params || {};
  return (
    <div style={{ ...card, marginTop: '12px' }}>
      <h4 style={{ ...h4, marginBottom: '4px' }}>
        Detail: {prettyAsset(run.asset)} · {FAMILY_LABEL[run.family || ''] || run.family}
      </h4>
      <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '12px' }}>
        Data {fmtDate(m?.dataFrom)} → {fmtDate(m?.dataTo)} ({m?.bars ?? 0} bar, {run.interval})
        {m?.benchmark ? ` · benchmark ${prettyAsset(m.benchmark)}` : ''}
        {m?.filterBlockedPct ? ` · filter makro memblokir ${m.filterBlockedPct.toFixed(0)}% bar` : ''}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px', marginBottom: '14px' }}>
        <Kpi label="Return penuh" value={fmtPct(full?.totalReturnPct)} color={(full?.totalReturnPct ?? 0) >= 0 ? '#10b981' : '#ef4444'} />
        <Kpi label="CAGR" value={fmtPct(full?.cagrPct)} />
        <Kpi label="Profit factor" value={full ? full.profitFactor.toFixed(2) : '—'} />
        <Kpi label="Win rate" value={full ? `${full.winRate.toFixed(1)}%` : '—'} />
        <Kpi label="Expectancy" value={full ? `${full.expectancyR.toFixed(2)}R` : '—'} />
        <Kpi label="Max drawdown" value={full ? `${full.maxDrawdownPct.toFixed(1)}%` : '—'} color="#ef4444" />
        <Kpi label="Buy & hold" value={fmtPct(full?.buyHoldPct)} />
        <Kpi label="Exposure" value={full ? `${full.exposurePct.toFixed(0)}%` : '—'} />
      </div>

      <TradeChart run={run} />

      {mc && mc.iterations > 0 && (
        <div style={{ marginBottom: '14px' }}>
          <div style={miniLabel}>Monte Carlo bootstrap ({mc.iterations} iterasi, 1% risiko/trade)</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: '8px' }}>
            <Kpi label="Peluang profit" value={`${(mc.probProfit * 100).toFixed(0)}%`} color={mc.probProfit >= 0.6 ? '#10b981' : '#f59e0b'} />
            <Kpi label="Persentil 5" value={fmtPct(mc.p5Pct)} />
            <Kpi label="Median" value={fmtPct(mc.p50Pct)} />
            <Kpi label="Persentil 95" value={fmtPct(mc.p95Pct)} />
            <Kpi label="Terburuk" value={fmtPct(mc.worstPct)} color="#ef4444" />
          </div>
        </div>
      )}

      {m?.oos?.length ? (
        <div style={{ marginBottom: '14px' }}>
          <div style={miniLabel}>Walk-forward out-of-sample</div>
          <div className="ah-scroll">
            <table style={{ width: '100%', minWidth: '560px', borderCollapse: 'collapse', fontSize: '11px' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #374151' }}>
                  <th style={th}>Jendela</th>
                  <th style={th}>Trade</th>
                  <th style={th}>Return</th>
                  <th style={th}>PF</th>
                  <th style={th}>DD</th>
                  <th style={th}>Expectancy</th>
                </tr>
              </thead>
              <tbody>
                {m.oos.map((o, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid #1f2937' }}>
                    <td style={td}>OOS {i + 1}</td>
                    <td style={td}>{o.trades}</td>
                    <td style={{ ...td, color: o.totalReturnPct >= 0 ? '#10b981' : '#ef4444' }}>{fmtPct(o.totalReturnPct)}</td>
                    <td style={td}>{o.profitFactor.toFixed(2)}</td>
                    <td style={{ ...td, color: '#ef4444' }}>{o.maxDrawdownPct.toFixed(1)}%</td>
                    <td style={td}>{o.expectancyR.toFixed(2)}R</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '12px' }}>
        <div>
          <div style={miniLabel}>Parameter yang diuji</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {Object.entries(params).map(([k, v]) => (
              <span key={k} style={{ fontSize: '10px', padding: '3px 7px', background: '#1f2937', borderRadius: '4px', color: '#9ca3af' }}>
                {k}={String(v)}
              </span>
            ))}
          </div>
        </div>
        <div>
          <div style={miniLabel}>Alasan putusan</div>
          <ul style={{ margin: 0, paddingLeft: '16px', color: '#9ca3af', fontSize: '11px', lineHeight: 1.7 }}>
            {(run.reasons || []).map((r, i) => (
              <li key={i}>{r}</li>
            ))}
            {(run.metrics?.notes || []).map((n, i) => (
              <li key={`n${i}`} style={{ color: '#f59e0b' }}>{n}</li>
            ))}
          </ul>
        </div>
      </div>

      {run.rationale && (
        <p style={{ fontSize: '11px', color: '#6b7280', margin: '12px 0 0', lineHeight: 1.6 }}>
          Hipotesis AI: {run.rationale}
        </p>
      )}
    </div>
  );
}

function Kpi({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ border: '1px solid #1f2937', borderRadius: '8px', padding: '8px 10px' }}>
      <div style={{ fontSize: '10px', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '3px' }}>{label}</div>
      <div style={{ fontSize: '13px', fontWeight: 700, color: color || '#f9fafb' }}>{value}</div>
    </div>
  );
}

const card: React.CSSProperties = {
  background: '#111827',
  border: '1px solid #374151',
  borderRadius: '12px',
  padding: '16px',
};
const h3: React.CSSProperties = { fontSize: '15px', fontWeight: 700, color: '#f9fafb', margin: '0 0 8px' };
const h4: React.CSSProperties = { fontSize: '13px', fontWeight: 600, color: '#f9fafb', margin: 0 };
const th: React.CSSProperties = {
  padding: '8px 10px',
  textAlign: 'left',
  fontSize: '10px',
  fontWeight: 700,
  color: '#6b7280',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  whiteSpace: 'nowrap',
};
const td: React.CSSProperties = { padding: '8px 10px', color: '#9ca3af', fontSize: '11px' };
const miniLabel: React.CSSProperties = {
  fontSize: '10px',
  color: '#6b7280',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  marginBottom: '6px',
};
const muted: React.CSSProperties = { fontSize: '11px', color: '#4b5563' };
const rankRow: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  fontSize: '11px',
  padding: '4px 0',
  borderBottom: '1px solid #1f2937',
};
