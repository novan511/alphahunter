import React, { useEffect, useState } from 'react';
import Layout from '../components/Layout/Layout';
import type { HorizonKey, LedgerRow, LedgerStats } from '../lib/signalLedger';
import { MIN_SAMPLE, type BucketStats } from '../lib/calibration';

const HORIZONS: HorizonKey[] = ['1d', '3d', '7d'];

type View = 'all' | 'pushed';

interface TrackRecord {
  configured: boolean;
  rows: LedgerRow[];
  all: LedgerStats;
  pushed: LedgerStats;
  buckets: BucketStats[];
  bucketsAll: BucketStats[];
  error?: string;
}

const calc = (v: number | null, digits = 2, signed = false): string => {
  if (v == null) return '—';
  return `${signed && v >= 0 ? '+' : ''}${(v * 100).toFixed(digits)}%`;
};

const price = (v: number | null): string => {
  if (v == null) return '—';
  if (v >= 1) return v.toFixed(2);
  return v.toPrecision(4);
};

const alphaColor = (v: number | null): string =>
  v == null ? '#6b7280' : v >= 0 ? '#10b981' : '#ef4444';

/**
 * Public signal record. Forward-only: it shows what has actually been emitted
 * and scored so far, never a backtest. Losing rows are shown like winning ones,
 * and every aggregate carries the sample size behind it.
 */
export default function RecordPage() {
  const [data, setData] = useState<TrackRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>('all');

  useEffect(() => {
    let alive = true;
    fetch('/api/track-record')
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
        return res.json();
      })
      .then((json: TrackRecord) => {
        if (!alive) return;
        setData(json);
        if (json.error) setError(json.error);
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : 'Gagal memuat catatan');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const stats = data ? (view === 'pushed' ? data.pushed : data.all) : null;
  const rows = data ? (view === 'pushed' ? data.rows.filter((r) => r.pushed) : data.rows) : [];
  const buckets = data ? (view === 'pushed' ? data.buckets : data.bucketsAll) : [];

  return (
    <Layout>
      <div style={{ padding: '0 24px 40px', maxWidth: '1400px', margin: '0 auto' }}>
        <h2 style={{ fontSize: '18px', fontWeight: '700', color: '#f9fafb', marginBottom: '8px' }}>
          📒 Rekam Jejak Sinyal (Live)
        </h2>
        <p style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '20px', lineHeight: 1.7 }}>
          Setiap sinyal yang lolos gate dicatat saat keluar, lalu dinilai otomatis terhadap benchmark-nya
          pada horizon tetap 1/3/7 hari. Angkanya adalah <strong>alpha</strong> (return aset dikurangi return
          benchmark, dibalik untuk short) — bukan return absolut. Catatan ini <strong>forward-only</strong>:
          dimulai dari nol dan tidak bisa diubah setelahnya. Harga acuan diambil dari candle terakhir saat
          scan, jadi untuk koin yang tipis harga ini belum tentu bisa dieksekusi (slippage). Bukan backtest,
          bukan rekomendasi.
        </p>

        {error && (
          <div style={{
            padding: '12px 16px', background: 'rgba(245, 158, 11, 0.1)', border: '1px solid rgba(245, 158, 11, 0.3)',
            borderRadius: '8px', color: '#f59e0b', fontSize: '12px', marginBottom: '16px',
          }}>{error}</div>
        )}

        <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
          {(['all', 'pushed'] as View[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              style={{
                padding: '8px 16px',
                borderRadius: '8px',
                border: '1px solid ' + (view === v ? '#3b82f6' : '#374151'),
                background: view === v ? 'rgba(59, 130, 246, 0.15)' : '#111827',
                color: view === v ? '#3b82f6' : '#9ca3af',
                fontSize: '12px',
                fontWeight: '600',
                cursor: 'pointer',
              }}
            >
              {v === 'all' ? 'Semua sinyal confident' : 'Yang benar-benar dikirim'}
            </button>
          ))}
        </div>

        {view === 'pushed' && (
          <p style={{ fontSize: '11px', color: '#6b7280', marginBottom: '16px' }}>
            Hanya {data?.pushed.n ?? 0} dari {data?.all.n ?? 0} sinyal yang benar-benar dikirim ke Telegram. Sampel
            ini lebih kecil dan berbeda dari pandangan “semua sinyal confident” — jangan dicampur.
          </p>
        )}

        {loading ? (
          <div style={{ padding: '20px', color: '#9ca3af', fontSize: '13px' }}>Memuat…</div>
        ) : !data || !stats || stats.n === 0 ? (
          <div style={{
            padding: '20px', background: '#111827', border: '1px solid #374151', borderRadius: '12px',
            color: '#9ca3af', fontSize: '13px', lineHeight: 1.7,
          }}>
            {data && !data.configured
              ? 'Supabase belum dikonfigurasi — catatan tidak bisa dibaca.'
              : view === 'pushed'
              ? 'Belum ada sinyal yang dikirim pada pandangan ini.'
              : 'Belum ada sinyal tercatat. Catatan ini mulai dari nol; hasil baru muncul setelah 1 hari (horizon 1d), lalu 3 dan 7 hari.'}
          </div>
        ) : (
          <>
            <BucketPanel buckets={buckets} view={view} />

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', marginBottom: '20px' }}>
              {HORIZONS.map((h) => {
                const s = stats.horizons[h];
                return (
                  <div key={h} style={{ background: '#111827', border: '1px solid #374151', borderRadius: '8px', padding: '12px 16px' }}>
                    <div style={{ fontSize: '11px', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
                      Horizon {h}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                      <span style={{ fontSize: '11px', color: '#9ca3af' }}>Win rate</span>
                      <span style={{ fontSize: '15px', fontWeight: '700', color: s.winRate != null && s.winRate >= 0.5 ? '#10b981' : '#ef4444' }}>
                        {calc(s.winRate, 1)}
                      </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: '4px' }}>
                      <span style={{ fontSize: '11px', color: '#9ca3af' }}>Avg alpha</span>
                      <span style={{ fontSize: '15px', fontWeight: '700', color: alphaColor(s.avgAlpha) }}>
                        {calc(s.avgAlpha, 2, true)}
                      </span>
                    </div>
                    <div style={{ fontSize: '10px', color: '#6b7280', marginTop: '8px' }}>
                      sampel: {s.n} sinyal dinilai
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '12px' }}>
              Total {view === 'all' ? 'sinyal confident' : 'sinyal terkirim'}: {stats.n} baris (setiap angka di
              atas selalu disertai ukuran sampelnya).
            </div>

            <div style={{ background: '#111827', border: '1px solid #374151', borderRadius: '12px', overflow: 'hidden' }}>
              <div className="ah-scroll">
                <table style={{ width: '100%', minWidth: '1180px', borderCollapse: 'collapse', fontSize: '12px' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #374151' }}>
                      <th style={thStyle}>Emit</th>
                      <th style={thStyle}>Aset</th>
                      <th style={thStyle}>Arah</th>
                      <th style={thStyle}>Signal</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Conf</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Harga emit</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Alpha 1d</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Alpha 3d</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Alpha 7d</th>
                      <th style={thStyle}>Hasil R</th>
                      <th style={thStyle}>Terkirim</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} style={{ borderBottom: '1px solid #1f2937' }}>
                        <td style={tdStyle}>{new Date(r.emitted_at).toLocaleString('id-ID')}</td>
                        <td style={{ ...tdStyle, color: '#f9fafb', fontWeight: '600' }}>{r.asset.replace('USDT', '')}</td>
                        <td style={{ ...tdStyle, color: r.direction === 'long' ? '#10b981' : '#ef4444', fontWeight: '600' }}>
                          {r.direction === 'long' ? 'LONG' : 'SHORT'}
                        </td>
                        <td style={tdStyle}>{r.signal.replace('_', ' ')}</td>
                        <td style={{ ...tdStyle, textAlign: 'right' }}>{r.confluence_score ?? '—'}</td>
                        <td style={{ ...tdStyle, textAlign: 'right' }}>{price(r.price)}</td>
                        <td style={{ ...tdStyle, textAlign: 'right', color: alphaColor(r.ret_1d) }}>{calc(r.ret_1d, 2, true)}</td>
                        <td style={{ ...tdStyle, textAlign: 'right', color: alphaColor(r.ret_3d) }}>{calc(r.ret_3d, 2, true)}</td>
                        <td style={{ ...tdStyle, textAlign: 'right', color: alphaColor(r.ret_7d) }}>{calc(r.ret_7d, 2, true)}</td>
                        <td style={{ ...tdStyle, color: r.r == null ? '#6b7280' : r.r >= 0 ? '#10b981' : '#ef4444', fontWeight: '600' }}>
                          {r.outcome === 'lost'
                            ? 'hilang'
                            : r.outcome == null
                              ? 'menunggu'
                              : `${r.r != null ? `${r.r >= 0 ? '+' : ''}${r.r.toFixed(2)}R` : '—'}${
                                  r.outcome === 'open' ? ' (waktu habis)' : ''
                                }`}
                        </td>
                        <td style={{ ...tdStyle, color: r.pushed ? '#10b981' : '#6b7280' }}>
                          {r.pushed ? 'Ya' : r.deduped ? 'Dedup 24j' : 'Tidak'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ padding: '10px 16px', fontSize: '11px', color: '#6b7280' }}>
                Baris rugi ditampilkan seperti baris untung. “—” berarti horizon itu belum jatuh tempo atau
                candle targetnya tidak tersedia. Angka yang sudah terisi tidak bisa diubah lagi. Baris
                <strong> pra-kalibrasi</strong> tidak punya stop/target dan tetap “menunggu” selamanya —
                level tidak pernah diisi belakangan, karena itu pintu belakang untuk memoles rekam jejak.
              </div>
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}

/**
 * Per-setup calibration. Deliberately refuses to print a rate a sample cannot
 * support: below the floor, and until the interval excludes zero, it says so in
 * words. The numbers are outcomes of signals that really fired, never a backtest.
 */
function BucketPanel({ buckets, view }: { buckets: BucketStats[]; view: View }) {
  if (buckets.length === 0) {
    return (
      <div style={{
        padding: '16px', background: '#111827', border: '1px solid #374151', borderRadius: '12px',
        color: '#9ca3af', fontSize: '12px', lineHeight: 1.7, marginBottom: '20px',
      }}>
        Kalibrasi per setup: belum ada sinyal berlevel pada pandangan ini. Angka pertama muncul setelah
        sinyal keluar, dinilai dari candle 4h (kena target, kena stop, atau keluar waktu di hari ke-7).
      </div>
    );
  }

  return (
    <div style={{ background: '#111827', border: '1px solid #374151', borderRadius: '12px', marginBottom: '20px', overflow: 'hidden' }}>
      <div style={{ padding: '14px 16px 0' }}>
        <div style={{ fontSize: '13px', fontWeight: '700', color: '#f9fafb', marginBottom: '6px' }}>
          Kalibrasi per setup — hasil R {view === 'pushed' ? '(yang benar-benar dikirim)' : '(semua sinyal confident)'}
        </div>
        <p style={{ fontSize: '11px', color: '#9ca3af', lineHeight: 1.7, margin: 0 }}>
          Tiap sinyal diberi stop <strong>1,5×ATR</strong> dan target <strong>2R</strong> saat keluar (satu
          konvensi, tidak pernah disetel ulang), lalu dinilai dari candle 4h — jadi win rate di sini
          membandingkan semua setup dengan risiko yang sama. Karena targetnya selalu 2R, win rate dan
          expectancy adalah dua pandangan dari angka yang sama, bukan dua bukti. Sampel kecil = derau:
          rata-rata baru boleh disebut punya edge kalau rentang keyakinan 95%-nya tidak menyentuh nol.
        </p>
      </div>
      <div className="ah-scroll">
        <table style={{ width: '100%', minWidth: '760px', borderCollapse: 'collapse', fontSize: '12px', marginTop: '12px' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #374151' }}>
              <th style={thStyle}>Setup</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>n selesai</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Win rate</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Expectancy</th>
              <th style={thStyle}>Status</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Waktu habis</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Hilang</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Menunggu</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b) => (
              <tr key={b.signal} style={{ borderBottom: '1px solid #1f2937' }}>
                <td style={{ ...tdStyle, color: '#f9fafb', fontWeight: '600' }}>{b.signal.replace(/_/g, ' ')}</td>
                <td style={{ ...tdStyle, textAlign: 'right' }}>{b.n}</td>
                <td style={{ ...tdStyle, textAlign: 'right' }}>
                  {b.n < MIN_SAMPLE || b.winRate == null
                    ? '—'
                    : `${(b.winRate * 100).toFixed(0)}% (${(b.winRateCi!.lo * 100).toFixed(0)}–${(
                        b.winRateCi!.hi * 100
                      ).toFixed(0)})`}
                </td>
                <td style={{ ...tdStyle, textAlign: 'right', color: b.conclusive ? '#10b981' : '#9ca3af', fontWeight: b.conclusive ? '700' : '400' }}>
                  {b.n < MIN_SAMPLE || b.expectancyR == null
                    ? '—'
                    : `${b.expectancyR >= 0 ? '+' : ''}${b.expectancyR.toFixed(2)}R (${b.expectancyCi!.lo.toFixed(
                        2
                      )}..${b.expectancyCi!.hi.toFixed(2)})`}
                </td>
                <td style={{ ...tdStyle, color: b.conclusive ? '#10b981' : '#f59e0b', fontWeight: '600' }}>
                  {b.conclusive
                    ? 'konklusif'
                    : b.n < MIN_SAMPLE
                      ? `sampel belum cukup (${b.n}/${MIN_SAMPLE})`
                      : 'interval masih menyentuh nol'}
                </td>
                <td style={{ ...tdStyle, textAlign: 'right' }}>{b.open}</td>
                <td style={{ ...tdStyle, textAlign: 'right' }}>{b.lost}</td>
                <td style={{ ...tdStyle, textAlign: 'right' }}>{b.pending}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ padding: '10px 16px', fontSize: '11px', color: '#6b7280' }}>
        Hanya baris yang benar-benar selesai (kena target atau kena stop) yang masuk win rate dan expectancy.
        “Waktu habis” (7 hari tanpa sentuhan) dan “hilang” (jalur candle-nya tidak utuh — awal hilang, ada bar
        bolong, atau seri berhenti sebelum jendela habis) dihitung terpisah dan tidak pernah dicampur ke angka
        utama. Kalau aturan stop/target suatu saat diubah, baris lama tidak ikut dihitung lagi di sini — dua
        definisi risiko tidak boleh dilebur jadi satu win rate.
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: '10px 12px', textAlign: 'left', fontSize: '10px', fontWeight: '700',
  color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.5px',
};

const tdStyle: React.CSSProperties = {
  padding: '10px 12px', color: '#9ca3af', fontSize: '12px',
};
