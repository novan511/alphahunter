import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import Layout from '../components/Layout/Layout';
import Sparkline from '../components/Sparkline';

interface ArenaModel { id: string; name: string; free: boolean }

interface LeaderRow {
  model: string;
  running: boolean;
  terminated?: boolean;
  equity: number;
  archetype?: string;
  equityHistory?: number[];
  pnlPct: number;
  openCount: number;
  iterCount: number;
  iterNote: string;
  thoughts?: Array<{ time: number; thought: string; thoughtPlain?: string; plan: string; planPlain?: string; actions: string }>;
  params: Record<string, number | boolean | string>;
  stats: {
    totalTrades: number;
    wins: number;
    winRate: number;
    totalR: number;
    avgR: number;
    bestR: number;
    worstR: number;
    ProfitFactor: number;
  };
}

interface LivePos {
  model: string;
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  markPrice: number;
  stopLoss: number;
  takeProfit: number;
  liveR: number;
  barsHeld: number;
  reason: string;
}

const card: React.CSSProperties = { background: '#111827', border: '1px solid #374151', borderRadius: 12, padding: 16 };
const rColor = (r: number) => (r > 0 ? '#10b981' : r < 0 ? '#ef4444' : '#9ca3af');

const fmt = (v: number, d = 4) =>
  v >= 1 ? v.toLocaleString('en-US', { maximumFractionDigits: d }) : v.toPrecision(4);

export default function ArenaPage() {
  const [models, setModels] = useState<ArenaModel[]>([]);
  const [modelSearch, setModelSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lb, setLb] = useState<LeaderRow[]>([]);
  const [positions, setPositions] = useState<LivePos[]>([]);
  const [marks, setMarks] = useState<Record<string, number>>({});
  const [gw, setGw] = useState<{ lastOkAt: number; lastErrAt: number; lastErr: string; down: boolean } | null>(null);
  const [booting, setBooting] = useState(false);
  const [stepping, setStepping] = useState(false);
  const [msg, setMsg] = useState<string>('');
  const [auto, setAuto] = useState(true);
  const autoRef = useRef(auto);
  autoRef.current = auto;
  const steppingRef = useRef(false);

  const loadModels = useCallback(async () => {
    try {
      const res = await fetch('/api/arena?action=models');
      const json = await res.json();
      setModels(json.models || []);
      if ((json.models || []).length === 0) setMsg('Gateway belum dioacak — set ARENA_LLM_BASE_URL/ARENA_LLM_API_KEY atau LLM_BASE_URL/LLM_API_KEY (.env.local).');
    } catch {
      setMsg('Gagal memuat daftar model dari gateway.');
    }
  }, []);

  const modelsFree = models.filter((m) => m.free);
  const filteredModels = modelSearch.trim()
    ? models.filter((m) => (m.id + ' ' + m.name).toLowerCase().includes(modelSearch.toLowerCase()))
    : models;

  const loadLb = useCallback(async () => {
    const res = await fetch('/api/arena?action=leaderboard');
    const json = await res.json();
    setLb(json.lb || []);
    setPositions(json.positions || []);
    setGw(json.gw || null);
  }, []);

  const reviveGateway = async () => {
    setMsg('Ping gateway…');
    try {
      const r = await fetch('/api/arena', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'gw-ping' }) });
      const d = await r.json();
      setMsg(d.alive ? '✅ gateway hidup kembali' : '❌ gateway masih mati — buka console instabox lalu klik Resume (runtime 8 jam harus di-extend di platform)');
      await loadLb();
    } catch {
      setMsg('Ping gagal jalan.');
    }
  };

  // mark price live (candle 1m granular) per simbol — PnL naik-turun semivable CEX
  const symbols = Array.from(new Set(positions.map((p: LivePos) => p.symbol))).join(',');
  useEffect(() => {
    if (!symbols) return;
    let alive = true;
    const tick = async () => {
      for (const sym of symbols.split(',')) {
        if (!alive) return;
        try {
          const r = await fetch(`/api/arena-candles?symbol=${encodeURIComponent(sym)}&gran=1m&lastOnly=1`);
          const arr = await r.json();
          const px = Array.isArray(arr) && arr.length ? arr[arr.length - 1].close : null;
          if (alive && typeof px === 'number') setMarks((m) => ({ ...m, [sym]: px }));
        } catch { /* tahan mark sebelumnya */ }
      }
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, [symbols]);

  useEffect(() => {
    loadLb();
    loadModels();
  }, [loadLb, loadModels]);

  const router = useRouter();

  // autonomous loop: step tiap 90 detik selama tab terbuka
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!autoRef.current || steppingRef.current) return;
      steppingRef.current = true;
      setStepping(true);
      try {
        await fetch('/api/arena', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // loop otonom: tanpa force — 1 iterasi per candle biar kuota model aman
          body: JSON.stringify({ action: 'step', force: false }),
        });
        await loadLb();
      } catch { /* keep polling */ }
      if (alive) { steppingRef.current = false; setStepping(false); }
    };
    const t = setInterval(tick, 90_000);
    return () => { alive = false; clearInterval(t); };
  }, [loadLb]);

  const start = async () => {
    setBooting(true);
    try {
      const res = await fetch('/api/arena', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', models: Array.from(selected) }),
      });
      const json = await res.json();
      if (!json.ok) setMsg(`Gagal mulai: ${json.error}`);
      else {
        setMsg(`Arena dimulai: ${(json.started || []).length} model × $1000`);
        await loadLb();
      }
    } finally {
      setBooting(false);
    }
  };

  const stepNow = async () => {
    steppingRef.current = true;
    setStepping(true);
    try {
      const res = await fetch('/api/arena', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // manual = force: pikir & jawab sekarang (lewati gate candle baru)
        body: JSON.stringify({ action: 'step', force: true }),
      });
      const json = await res.json();
      if (!json.ok) setMsg(`Step gagal: ${json.error}`);
      await loadLb();
    } finally {
      steppingRef.current = false;
      setStepping(false);
    }
  };

  const toggleAgent = async (model: string, running: boolean) => {
    await fetch('/api/arena', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: running ? 'stop' : 'resume', model }),
    });
    await loadLb();
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <Layout>
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Hero */}
        <div className="card" style={{ ...card, background: 'linear-gradient(135deg,#111827,#1e1b4b)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
            <div>
              <h1 style={{ fontSize: 22, fontWeight: 800, color: '#f9fafb', margin: 0 }}>
                ⚔️ AI Arena <span style={{ color: '#818cf8', fontWeight: 500, fontSize: 14 }}>· alpha-arena style</span>
              </h1>
              <p style={{ color: '#9ca3af', margin: '6px 0 0', fontSize: 13, maxWidth: 640 }}>
                Tiap model AI dari gateway AntSeed mulai dengan <b style={{ color: '#f9fafb' }}>$1,000</b> modal virtual, trade otonom di semua market
                memakai seluruh engine Althunter (MTF confluence, spike, RS decoupling), dan <b style={{ color: '#f9fafb' }}>iterasi sendiri</b> antar
                step. Yang dilomba <b style={{ color: '#818cf8' }}>bukan winrate — tapi R expectancy</b> (rata-rata R per trade).
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {gw && (
                <span
                  style={{ padding: '8px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: gw.down ? 'pointer' : 'default', border: `1px solid ${gw.down ? '#ef4444' : '#10b981'}`, color: gw.down ? '#fca5a5' : '#86efac' }}
                  onClick={gw.down ? reviveGateway : undefined}
                  title={gw.down ? `Terlihat mati: ${gw.lastErr} — klik untuk ping ulang` : ''}
                >
                  {gw.down ? '🔴 gateway mati — klik untuk bangunkan' : '🟢 gateway hidup'}
                </span>
              )}
              <button
                onClick={() => setAuto((a) => !a)}
                style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #4b5563', background: auto ? 'rgba(59,130,246,.2)' : 'transparent', color: auto ? '#3b82f6' : '#9ca3af', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
                title="Loop otonom tiap 90 detik"
              >
                {auto ? '🔄 Autonomous: ON' : '⏸ Autonomous: OFF'}
              </button>
              <button
                onClick={stepNow}
                disabled={stepping}
                style={{ padding: '8px 14px', borderRadius: 8, border: 'none', background: stepping ? '#374151' : '#2563eb', color: '#fff', cursor: stepping ? 'wait' : 'pointer', fontSize: 12, fontWeight: 600 }}
              >
                {stepping ? '⏳ Stepping…' : '▶ Step sekarang'}
              </button>
            </div>
          </div>
          {msg && <p style={{ color: '#fbbf24', fontSize: 12, margin: '10px 0 0' }}>{msg}</p>}
        </div>

        {/* Pendaftaran model (kalau arena masih kosong) */}
        <div style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <h2 style={{ fontSize: 15, color: '#f9fafb', margin: 0 }}>Daftar peserta (pilih model gateway)</h2>
            <button
              onClick={start}
              disabled={booting || models.length === 0}
              style={{ padding: '7px 12px', borderRadius: 8, border: 'none', background: booting ? '#374151' : '#059669', color: '#fff', cursor: booting ? 'wait' : 'pointer', fontSize: 12, fontWeight: 600 }}
            >
              {booting ? 'Merekrut…' : `🚀 Mulai Arena${selected.size ? ` (${selected.size})` : ' (default 6)'}`}
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <input
              value={modelSearch}
              onChange={(e) => setModelSearch(e.target.value)}
              placeholder="🔍 cari model (glm, grok, deepseek…)"
              style={{ flex: 1, maxWidth: 320, padding: '6px 10px', borderRadius: 8, border: '1px solid #4b5563', background: '#0b1220', color: '#f9fafb', fontSize: 12 }}
            />
            <span style={{ color: '#6b7280', fontSize: 11 }}>
              {selected.size > 0 ? `${selected.size} dipilih` : `${(modelsFree || []).length} model gratis tersedia`}
            </span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 180, overflowY: 'auto' }}>
            {filteredModels.length === 0 && <span style={{ color: '#6b7280', fontSize: 12 }}>— tidak ada yang cocok —</span>}
            {filteredModels.map((m) => (
              <button
                key={m.id}
                onClick={() => toggleSelect(m.id)}
                title={m.free ? 'GRATIS (peer $0/$0)' : m.id}
                style={{
                  padding: '4px 10px', borderRadius: 999, fontSize: 11, cursor: 'pointer',
                  border: selected.has(m.id) ? '1px solid #3b82f6' : '1px solid #4b5563',
                  background: selected.has(m.id) ? 'rgba(59,130,246,.15)' : 'transparent',
                  color: selected.has(m.id) ? '#60a5fa' : '#9ca3af',
                }}
              >
                {m.free ? '🆓 ' : ''}{m.id}
              </button>
            ))}
          </div>
        </div>

        {/* Leaderboard ala alpha arena: kartu baris besar + sparkline, klik → profil model */}
        <div style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
            <h2 style={{ fontSize: 15, color: '#f9fafb', margin: 0 }}>🏆 Leaderboard</h2>
            <span style={{ fontSize: 11, color: '#6b7280', alignSelf: 'center' }}>Ribu kertas yang besar · klik baris untuk detail model</span>
          </div>
          {lb.length === 0 && (
            <p style={{ color: '#6b7280', fontSize: 12, margin: 0 }}>Belum ada peserta — tekan "🚀 Mulai Arena" di panel atas.</p>
          )}
          {lb.map((row, i) => (
            <div
              key={row.model}
              onClick={() => router.push(`/models/${encodeURIComponent(row.model)}`)}
              style={{
                display: 'grid',
                gridTemplateColumns: '44px 1.4fr 1fr 92px 96px 84px 72px 92px 70px',
                alignItems: 'center', gap: 8, padding: '12px 10px', borderRadius: 10, cursor: 'pointer',
                borderBottom: '1px solid #1f2937', background: i === 0 ? 'rgba(129,140,248,.06)' : 'transparent',
              }}
            >
              <span style={{ color: '#9ca3af', fontSize: 13, fontWeight: 700 }}>{i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}</span>
              <div style={{ minWidth: 0 }}>
                <div style={{ color: '#f9fafb', fontWeight: 700, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.model}>
                  {row.model} {!row.running && <span style={{ color: '#ef4444', fontWeight: 400 }}>· {row.terminated ? 'TERMINATED (402/404)' : 'stopped'}</span>}
                </div>
                <div style={{ fontSize: 10, color: '#818cf8' }}>🧬 {row.archetype || 'Momentum General'} · iter {row.iterCount}</div>
              </div>
              <Sparkline points={row.equityHistory || []} width={120} height={34} />
              <div>
                <div style={{ color: '#f9fafb', fontWeight: 700, fontSize: 14 }}>${fmt(row.equity, 2)}</div>
                <div style={{ fontSize: 11, color: rColor(row.pnlPct) }}>{row.pnlPct >= 0 ? '+' : ''}{row.pnlPct.toFixed(2)}%</div>
              </div>
              <div>
                <div style={{ color: '#9ca3af', fontSize: 10 }}>TOTAL R</div>
                <div style={{ color: rColor(row.stats.totalR), fontWeight: 800, fontSize: 14 }}>{row.stats.totalR >= 0 ? '+' : ''}{row.stats.totalR.toFixed(2)}R</div>
              </div>
              <div>
                <div style={{ color: '#9ca3af', fontSize: 10 }}>AVG R / TRADE</div>
                <div style={{ color: rColor(row.stats.avgR), fontSize: 12 }}>{row.stats.avgR >= 0 ? '+' : ''}{row.stats.avgR.toFixed(2)}R</div>
              </div>
              <div>
                <div style={{ color: '#9ca3af', fontSize: 10 }}>TRADES</div>
                <div style={{ color: '#e5e7eb', fontSize: 12 }}>{row.stats.totalTrades}{row.stats.totalTrades > 0 && <span style={{ color: '#6b7280' }}> ({row.stats.winRate.toFixed(0)}%w)</span>}</div>
              </div>
              <div>
                <div style={{ color: '#9ca3af', fontSize: 10 }}>OPEN POSISI</div>
                <div style={{ color: '#e5e7eb', fontSize: 12 }}>{row.openCount}</div>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); toggleAgent(row.model, row.running); }}
                style={{ padding: '5px 10px', fontSize: 10, borderRadius: 6, cursor: 'pointer', background: 'transparent', border: '1px solid #4b5563', color: row.running ? '#ef4444' : '#10b981' }}
              >
                {row.running ? 'stop' : 'resume'}
              </button>
            </div>
          ))}
        </div>

        {/* Live positions */}
        <div style={card}>
          <h2 style={{ fontSize: 15, color: '#f9fafb', margin: '0 0 10px' }}>📡 Live Positions</h2>
          {positions.length === 0 ? (
            <p style={{ color: '#6b7280', fontSize: 12, margin: 0 }}>Flat semua — menunggu sinyal confluence di atas ambang tiap model.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ color: '#9ca3af', textAlign: 'left', borderBottom: '1px solid #374151' }}>
                    <th style={{ padding: 8 }}>Model</th>
                    <th style={{ padding: 8 }}>Symbol</th>
                    <th style={{ padding: 8 }}>Side</th>
                    <th style={{ padding: 8 }}>Entry</th>
                    <th style={{ padding: 8 }}>Mark</th>
                    <th style={{ padding: 8 }}>Live R</th>
                    <th style={{ padding: 8 }}>SL</th>
                    <th style={{ padding: 8 }}>TP</th>
                    <th style={{ padding: 8 }}>Held</th>
                    <th style={{ padding: 8 }}>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p, i) => (
                    <tr key={`${p.model}-${p.symbol}-${i}`} style={{ borderBottom: '1px solid #1f2937' }}>
                      <td style={{ padding: 8, color: '#f9fafb', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.model}>{p.model.split('/').pop()}</td>
                      <td style={{ padding: 8, color: '#f9fafb', fontWeight: 600 }}>{p.symbol}</td>
                      <td style={{ padding: 8, color: p.side === 'long' ? '#10b981' : '#ef4444', fontWeight: 700 }}>{p.side === 'long' ? '▲ LONG' : '▼ SHORT'}</td>
                      <td style={{ padding: 8, color: '#9ca3af' }}>{fmt(p.entryPrice)}</td>
                      <td style={{ padding: 8, color: '#9ca3af' }}>{fmt(marks[p.symbol] ?? p.markPrice)}</td>
                      {(() => {
                        const m = marks[p.symbol] ?? p.markPrice;
                        const dir = p.side === 'long' ? 1 : -1;
                        const lr = ((m - p.entryPrice) * dir) / Math.max(1e-9, Math.abs(p.entryPrice - p.stopLoss));
                        return <td style={{ padding: 8, color: rColor(lr), fontWeight: 700 }}>{lr >= 0 ? '+' : ''}{lr.toFixed(2)}R</td>;
                      })()}
                      <td style={{ padding: 8, color: '#ef4444' }}>{fmt(p.stopLoss)}</td>
                      <td style={{ padding: 8, color: '#10b981' }}>{p.takeProfit > 0 ? fmt(p.takeProfit) : '—"run" (trail/exit bebas)'}</td>
                      <td style={{ padding: 8, color: '#9ca3af' }}>{p.barsHeld}b</td>
                      <td style={{ padding: 8, color: '#6b7280', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.reason}>{p.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {/* Live thoughts — isi kepala model realtime */}
        <div style={card}>
          <h2 style={{ fontSize: 15, color: '#f9fafb', margin: '0 0 10px' }}>🧠 Live Thinking · isi kepala tiap model, diperbarui per step</h2>
          {lb.filter((r) => (r.thoughts || []).length > 0).length === 0 ? (
            <p style={{ color: '#6b7280', fontSize: 12, margin: 0 }}>
              Belum ada pikiran terekam — jalankan satu step; tiap step model diminta menuang "thought" (apa yang dilihat pasar + kondisi R-nya) dan "plan" (rencana bar ke depan) dalam JSON.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {lb
                .filter((r) => (r.thoughts || []).length > 0)
                .map((r) => (
                  <div key={`think-${r.model}`} style={{ border: '1px solid #1f2937', borderRadius: 10, padding: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      <b style={{ color: '#f9fafb', fontSize: 13 }}>{r.model.split('/').pop()}</b>
                      <span style={{ color: '#6b7280', fontSize: 11 }}>iter ke-{r.iterCount} · {r.running ? '🟢 berjalan' : '🔴 berhenti'}</span>
                    </div>
                    {(r.thoughts || []).map((th, i) => (
                      <div key={i} style={{ padding: '8px 0', borderTop: i === 0 ? 'none' : '1px dashed #1f2937' }}>
                        <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3 }}>
                          {new Date(th.time).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })} · aksi: <span style={{ color: '#fbbf24' }}>{th.actions || '—'}</span>
                        </div>
                        <div style={{ fontSize: 13, color: '#f3f4f6', lineHeight: 1.55 }}>
                          🗣️ <span style={{ fontWeight: 500 }}>{th.thoughtPlain || th.thought || '—'}</span>
                        </div>
                        {th.thought && th.thoughtPlain && (
                          <div style={{ fontSize: 11, color: '#6b7280', lineHeight: 1.5, marginTop: 2, fontStyle: 'italic' }}>
                            📊 versi teknis: {th.thought}
                          </div>
                        )}
                        {th.plan && (
                          <div style={{ fontSize: 12, color: '#818cf8', lineHeight: 1.5, marginTop: 3 }}>
                            🎯 {th.planPlain || th.plan}
                            {th.planPlain && th.plan && (
                              <div style={{ fontSize: 10, color: '#4b5563', marginTop: 1 }}>rencana teknis: {th.plan}</div>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
            </div>
          )}
        </div>

        {/* Footer catatan */}
      </div>
    </Layout>
  );
}
