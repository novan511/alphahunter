import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import Layout from '../../components/Layout/Layout';
import Sparkline from '../../components/Sparkline';
import ArenaPositionChart from '../../components/Arena/PositionChart';

interface ArenaTrade {
  symbol: string; side: string; entryTime: number; exitTime: number;
  entryPrice: number; exitPrice: number; pnl: number; r: number;
  reason: string; exitReason: string;
}
interface ArenaState {
  model: string;
  archetype: string;
  mandate: string;
  running: boolean;
  equity: number;
  params: Record<string, number | boolean | string>;
  cash: number;
  positions: Array<{ symbol: string; side: string; entryTime?: number; entryPrice: number; markPrice?: number; stopLoss: number; takeProfit: number; barsHeld: number; riskDollar: number; qty?: number; reason: string }>;
  trades: ArenaTrade[];
  thoughts: Array<{ time: number; thought: string; thoughtPlain?: string; plan?: string; planPlain?: string; actions: string }>;
  equityHistory: Array<{ time: number; equity: number }>;
  iterCount: number;
  log: string[];
  stats: { totalTrades: number; wins: number; winRate: number; totalR: number; avgR: number; bestR: number; worstR: number; ProfitFactor: number };
}

const card: React.CSSProperties = { background: '#111827', border: '1px solid #374151', borderRadius: 12, padding: 16 };
const rColor = (r: number) => (r > 0 ? '#10b981' : r < 0 ? '#ef4444' : '#9ca3af');
const fmt = (v: number, d = 2) => (v >= 1 ? v.toLocaleString('en-US', { maximumFractionDigits: d }) : v.toPrecision(4));
const when = (t: number) => new Date(t).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Satu baris posisi terbuka dengan mark-price live (poll candle terakhir tiap 30 dtk)
 *  → PnL $ dan R naik-turun realtime seperti di CEX. */
function LivePositionRow({ p, interval }: { p: NonNullable<ArenaState['positions']>[number]; interval: string }) {
  const [mark, setMark] = useState<number | null>(p.markPrice ?? p.entryPrice);
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  const prevRef = useRef<number>(mark ?? 0);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        // mark live dari candle granular (1m) — close 1h hanya bergeser saat candle roll
        const r = await fetch(`/api/arena-candles?symbol=${encodeURIComponent(p.symbol)}&gran=1m&lastOnly=1`);
        const arr = await r.json();
        const px = Array.isArray(arr) && arr.length ? arr[arr.length - 1].close : null;
        if (alive && typeof px === 'number') {
          if (prevRef.current && px !== prevRef.current) {
            setFlash(px > prevRef.current ? 'up' : 'down');
            setTimeout(() => setFlash(null), 900);
          }
          prevRef.current = px;
          setMark(px);
        }
      } catch { /* biarkan mark sebelumnya */ }
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, [p.symbol, interval]);

  const dir = p.side === 'long' ? 1 : -1;
  const qty = p.qty || 0;
  const pnl = ((mark ?? p.entryPrice) - p.entryPrice) * dir * qty;
  const riskU = Math.abs(p.entryPrice - p.stopLoss) * qty || (p.riskDollar || 1);
  const pnlR = pnl / (riskU || 1);
  const liveP = mark ?? p.entryPrice;

  return (
    <div style={{ padding: '10px 0', borderBottom: '1px dashed #1f2937', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
      <b style={{ color: p.side === 'long' ? '#10b981' : '#ef4444' }}>{p.side === 'long' ? '▲ LONG' : '▼ SHORT'} {p.symbol.replace(/^[a-z]+:/i, '')}</b>
      <span style={{ color: '#6b7280', fontSize: 11 }}>entry {fmt(p.entryPrice)} → <span style={{ color: '#f9fafb', fontWeight: 700, background: flash === 'up' ? 'rgba(16,185,129,.12)' : flash === 'down' ? 'rgba(239,68,68,.12)' : 'transparent', padding: '0 3px', borderRadius: 4 }}>{fmt(liveP)}</span></span>
      <span style={{ display: 'inline-flex', flexDirection: 'column', minWidth: 120 }}>
        <b style={{ color: rColor(pnl), fontSize: 15, fontVariantNumeric: 'tabular-nums' }}>
          {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
        </b>
        <span style={{ color: rColor(pnlR), fontSize: 11 }}>{pnlR >= 0 ? '+' : ''}{pnlR.toFixed(2)}R floating</span>
      </span>
      <span style={{ color: '#6b7280', fontSize: 11 }}>SL {fmt(p.stopLoss)} · TP {p.takeProfit > 0 ? fmt(p.takeProfit) : '—'} · {p.barsHeld} bar · qty {fmt(qty, 4)}</span>
      <span style={{ color: '#4b5563', fontSize: 10, flex: 1, minWidth: 140 }}>{p.reason}</span>
    </div>
  );
}

export default function ModelPage() {
  const [s, setS] = useState<ArenaState | null>(null);
  const [err, setErr] = useState('');
  const router = useRouter();
  const slug = Array.isArray(router.query.slug) ? router.query.slug[0] : router.query.slug || '';

  useEffect(() => {
    fetch(`/api/arena?action=detail&model=${encodeURIComponent(slug)}`)
      .then(async (res) => {
        const json: { ok?: boolean; state?: ArenaState; error?: string } = await res.json();
        if (!json.ok || !json.state) throw new Error(json.error || 'Model tidak ditemukan');
        setS(json.state);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : 'Gagal memuat'));
  }, [slug]);

  const equityCurve = (s?.equityHistory || []).map((p) => p.equity);
  const st = s?.stats;
  const pnlPct = s ? ((s.equity - 1000) / 10) : 0;

  return (
    <Layout>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '24px 16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <a href="/arena" style={{ color: '#818cf8', fontSize: 12, textDecoration: 'none' }}>← kembali ke arena</a>
        {err && <div style={card}><p style={{ color: '#ef4444', margin: 0, fontSize: 13 }}>{err}</p></div>}
        {!s && !err && <div style={card}><p style={{ color: '#6b7280', margin: 0 }}>Memuat…</p></div>}

        {s && (
          <>
            {/* Header */}
            <div style={{ ...card, background: 'linear-gradient(135deg,#111827,#1e1b4b)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                <div>
                  <h1 style={{ fontSize: 20, color: '#f9fafb', margin: 0, fontWeight: 800 }}>{s.model}</h1>
                  <div style={{ fontSize: 12, color: '#818cf8', marginTop: 4 }}>🧬 {s.archetype || 'Momentum General'} · {s.running ? '🟢 aktif' : '🔴 berhenti/KO'}</div>
                  <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 6, maxWidth: 560 }}>{s.mandate}</p>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 28, fontWeight: 800, color: rColor(s.equity - 1000) }}>${fmt(s.equity)}</div>
                  <div style={{ fontSize: 13, color: rColor(pnlPct) }}>{pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}% dari $1.000</div>
                  <div style={{ marginTop: 6 }}><Sparkline points={equityCurve} width={220} height={44} /></div>
                </div>
              </div>
            </div>

            {/* Stat utama */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 10 }}>
              {[
                { l: 'Total R', v: `${st && st.totalR >= 0 ? '+' : ''}${(st?.totalR ?? 0).toFixed(2)}R`, c: rColor(st?.totalR ?? 0) },
                { l: 'Avg R / trade', v: `${st && st.avgR >= 0 ? '+' : ''}${(st?.avgR ?? 0).toFixed(2)}R`, c: rColor(st?.avgR ?? 0) },
                { l: 'Trades', v: String(st?.totalTrades ?? 0), c: '#e5e7eb' },
                { l: 'Win rate', v: `${(st?.winRate ?? 0).toFixed(0)}%`, c: '#e5e7eb' },
                { l: 'Best R', v: `${(st?.bestR ?? 0).toFixed(2)}R`, c: rColor(st?.bestR ?? 0) },
                { l: 'Worst R', v: `${(st?.worstR ?? 0).toFixed(2)}R`, c: rColor(st?.worstR ?? 0) },
              ].map((x) => (
                <div key={x.l} style={card}>
                  <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5 }}>{x.l}</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: x.c }}>{x.v}</div>
                </div>
              ))}
            </div>

            {/* Chart realtime: satu chart per asset yang dipantau (posisi terbuka; kalau flat, dari trade terakhir) */}
            <div style={card}>
              <h2 style={{ fontSize: 14, color: '#f9fafb', margin: '0 0 8px' }}>📊 Chart live yang dipantau · entry / SL / TP realtime</h2>
              {(() => {
                const open = s.positions || [];
                const fallback = open.length === 0
                  ? Array.from(new Set((s.trades || []).slice(0, 2).map((t) => `${t.symbol}|${t.side}`))).map((key) => {
                      const t = (s.trades || (s.trades = [])).find((x) => `${x.symbol}|${x.side}` === key)!;
                      return { symbol: t.symbol, side: t.side, entryPrice: t.entryPrice, stopLoss: t.entryPrice * (t.side === 'long' ? 0.985 : 1.015), takeProfit: t.exitPrice, entryTime: t.entryTime, reason: `trade terakhir (exit: ${t.exitReason})` };
                    })
                  : [];
                const charts = open.map((pos) => ({ symbol: pos.symbol, interval: String(s.params?.interval || '1h'), side: pos.side, entryPrice: pos.entryPrice, stopLoss: pos.stopLoss, takeProfit: pos.takeProfit, entryTime: (pos as { entryTime?: number }).entryTime ?? pos.entryPrice, reason: pos.reason }));
                const fallbackCharts = fallback.map((f) => ({ symbol: f.symbol, interval: String(s.params?.interval || '1h'), side: f.side, entryPrice: f.entryPrice, stopLoss: f.stopLoss, takeProfit: f.takeProfit, entryTime: f.entryTime, reason: f.reason }));
                const all = [...charts, ...fallbackCharts];
                if (all.length === 0) return <p style={{ color: '#6b7280', fontSize: 12, margin: 0 }}>Belum ada asset dipantau — belum buka posisi / trade.</p>;
                return (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
                    {all.map((c, i) => <ArenaPositionChart key={`${c.symbol}-${i}`} {...c} />)}
                  </div>
                );
              })()}
            </div>

            {/* Posisi terbuka — PnL live naik-turun (mark price tiap 30 dtk) */}
            <div style={card}>
              <h2 style={{ fontSize: 14, color: '#f9fafb', margin: '0 0 8px' }}>📡 Posisi terbuka ({(s.positions || []).length}) · <span style={{ color: '#10b981', fontSize: 11 }}>PnL live ±30 dtk</span></h2>
              {(s.positions || []).length === 0 ? (
                <p style={{ color: '#6b7280', fontSize: 12, margin: 0 }}>Flat.</p>
              ) : (
                (s.positions || []).map((p, i) => <LivePositionRow key={`${p.symbol}-${i}`} p={p} interval={String(s.params?.interval || '1h')} />)
              )}
            </div>

            {/* Riwayat trade — advanced-lite: tabel + distribusi R */}
            <div style={card}>
              <h2 style={{ fontSize: 14, color: '#f9fafb', margin: '0 0 8px' }}>📜 Riwayat trade</h2>
              {(s.trades || []).length === 0 ? (
                <p style={{ color: '#6b7280', fontSize: 12, margin: 0 }}>Belum ada trade.</p>
              ) : (
                <>
                  <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
                    {/* histogram kecil distribusi R: 5 bucket */}
                    {(() => {
                      const rs = s.trades.map((t) => t.r);
                      const buckets = [-3, -1, 0, 1, 3, Infinity];
                      const labels = ['≤-3R', '-3..-1R', '-1..0R', '0..+3R', '>+3R'];
                      const counts = [0, 0, 0, 0, 0];
                      for (const r of rs) {
                        for (let b = 0; b < 5; b++) {
                          if (r >= buckets[b] && r < buckets[b + 1]) { counts[b]++; break; }
                        }
                      }
                      const max = Math.max(1, ...counts);
                      return counts.map((c, i) => (
                        <div key={i} style={{ flex: 1, textAlign: 'center' }}>
                          <div style={{ height: 40, display: 'flex', alignItems: 'flex-end' }}>
                            <div style={{ width: '100%', height: `${(c / max) * 100}%`, background: i < 3 ? '#ef4444' : '#10b981', borderRadius: 4, minHeight: 2 }} />
                          </div>
                          <div style={{ fontSize: 10, color: '#6b7280' }}>{labels[i]}</div>
                          <div style={{ fontSize: 11, color: '#e5e7eb' }}>{c}</div>
                        </div>
                      ));
                    })()}
                  </div>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr style={{ color: '#9ca3af', textAlign: 'left', borderBottom: '1px solid #374151' }}>
                          <th style={{ padding: 6 }}>Waktu</th>
                          <th style={{ padding: 6 }}>Market</th>
                          <th style={{ padding: 6 }}>Sisi</th>
                          <th style={{ padding: 6 }}>Entry → Exit</th>
                          <th style={{ padding: 6 }}>PnL</th>
                          <th style={{ padding: 6 }}>R</th>
                          <th style={{ padding: 6 }}>Alasan exit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(s.trades || []).slice(0, 30).map((t, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid #1f2937' }}>
                            <td style={{ padding: 6, color: '#6b7280' }}>{when(t.exitTime)}</td>
                            <td style={{ padding: 6, color: '#f9fafb', fontWeight: 600 }}>{t.symbol}</td>
                            <td style={{ padding: 6, color: t.side === 'long' ? '#10b981' : '#ef4444' }}>{t.side}</td>
                            <td style={{ padding: 6, color: '#9ca3af' }}>{fmt(t.entryPrice)} → {fmt(t.exitPrice)}</td>
                            <td style={{ padding: 6, color: rColor(t.pnl) }}>${t.pnl.toFixed(2)}</td>
                            <td style={{ padding: 6, color: rColor(t.r), fontWeight: 700 }}>{t.r >= 0 ? '+' : ''}{t.r.toFixed(2)}R</td>
                            <td style={{ padding: 6, color: '#6b7280' }}>{t.exitReason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>

            {/* Papan pikiran model ini */}
            <div style={card}>
              <h2 style={{ fontSize: 14, color: '#f9fafb', margin: '0 0 8px' }}>🧠 Papan pikiran · iter {s.iterCount}</h2>
              {(s.thoughts || []).length === 0 ? (
                <p style={{ color: '#6b7280', fontSize: 12, margin: 0 }}>Belum ada refleksi — jalankan step.</p>
              ) : (
                (s.thoughts || []).map((th, i) => (
                  <div key={i} style={{ padding: '8px 0', borderTop: i === 0 ? 'none' : '1px dashed #1f2937' }}>
                    <div style={{ fontSize: 10, color: '#6b7280' }}>{when(th.time)} · aksi: <span style={{ color: '#fbbf24' }}>{th.actions || '—'}</span></div>
                    <div style={{ fontSize: 13, color: '#f3f4f6', marginTop: 3 }}>🗣️ {th.thoughtPlain || th.thought}</div>
                    {th.thought && th.thoughtPlain && <div style={{ fontSize: 11, color: '#6b7280', fontStyle: 'italic', marginTop: 2 }}>📊 {th.thought}</div>}
                    {th.planPlain && <div style={{ fontSize: 12, color: '#818cf8', marginTop: 2 }}>🎯 {th.planPlain}{th.planPlain && th.plan && <span style={{ color: '#4b5563', fontSize: 10 }}> · {th.plan}</span>}</div>}
                  </div>
                ))
              )}
            </div>

            {/* Parameter saat ini */}
            <div style={card}>
              <h2 style={{ fontSize: 14, color: '#f9fafb', margin: '0 0 8px' }}>⚙️ Parameter iterasi saat ini</h2>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {Object.entries(s.params || {}).map(([k, v]) => (
                  <span key={k} style={{ padding: '4px 10px', borderRadius: 999, fontSize: 11, border: '1px solid #4b5563', color: '#d1d5db' }}>
                    <b style={{ color: '#818cf8' }}>{k}</b> {String(v)}
                  </span>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}
