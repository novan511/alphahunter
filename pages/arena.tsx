import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import Layout from '../components/Layout/Layout';
import Sparkline from '../components/Sparkline';

interface ArenaModel { id: string; name: string; free: boolean }
interface ExecutionAssumptions {
  profiles: Record<string, { feeBpsPerSide: number; slippageBpsPerSide: number; basis: string }>;
  note: string;
}

interface LeaderRow {
  model: string;
  running: boolean;
  terminated?: boolean;
  equity: number;
  archetype?: string;
  equityHistory?: number[];
  pnlPct: number;
  expectancyScore: number | null;
  maxDrawdownPct: number;
  tradeSample: number;
  tradeHistoryCapped: boolean;
  lastDecision?: {
    requestedAt: number; completedAt: number; latencyMs: number; modelLatencyMs: number; interval: string; barAt: number | null;
    snapshotCapturedAt: number | null; signalCount: number; candidateSymbols: string[]; actionSummary: string;
    provider: string; validDecision: boolean; fallback: boolean; error?: string;
  } | null;
  lastSnapshot?: {
    capturedAt: number; primaryInterval: string; requestedAssets: number; availableAssets: number;
    missingSymbols: string[]; newestBarAt: number | null; oldestBarAt: number | null; benchmarkMissingTimeframes: string[];
  } | null;
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
  qty?: number;
  riskDollar?: number;
  feeBpsPerSide?: number;
  slippageBpsPerSide?: number;
  tookPartial?: boolean;
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
  const [deepseekFallback, setDeepseekFallback] = useState<boolean>(false);
  const [controlsReady, setControlsReady] = useState(false);
  const [controlTokenRequired, setControlTokenRequired] = useState(false);
  const [controlMessage, setControlMessage] = useState('');
  const [controlToken, setControlToken] = useState('');
  const [persistenceMode, setPersistenceMode] = useState('checking');
  const [executionAssumptions, setExecutionAssumptions] = useState<ExecutionAssumptions | null>(null);
  const [booting, setBooting] = useState(false);
  const [stepping, setStepping] = useState(false);
  const [msg, setMsg] = useState<string>('');
  const [auto, setAuto] = useState(true);
  const autoRef = useRef(auto);
  const steppingRef = useRef(false);
  const loadingLbRef = useRef(false);
  const controlsRef = useRef({ ready: false, required: false, token: '' });
  controlsRef.current = { ready: controlsReady, required: controlTokenRequired, token: controlToken };
  const canControl = controlsReady && (!controlTokenRequired || Boolean(controlToken));
  autoRef.current = auto && canControl;

  useEffect(() => {
    try { setControlToken(sessionStorage.getItem('arena-control-token') || ''); } catch { /* private browsing */ }
  }, []);
  useEffect(() => {
    try {
      if (controlToken) sessionStorage.setItem('arena-control-token', controlToken);
      else sessionStorage.removeItem('arena-control-token');
    } catch { /* private browsing */ }
  }, [controlToken]);

  const controlHeaders = () => ({
    'Content-Type': 'application/json',
    ...(controlsRef.current.token ? { Authorization: `Bearer ${controlsRef.current.token}` } : {}),
  });

  const loadModels = useCallback(async () => {
    try {
      // full-gratis: panel rekrutmen hanya menampilkan model dengan harga 0
      const res = await fetch('/api/arena?action=models&freeOnly=1');
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
    if (loadingLbRef.current) return;
    loadingLbRef.current = true;
    try {
      const res = await fetch('/api/arena?action=leaderboard');
      if (!res.ok) throw new Error(`leaderboard HTTP ${res.status}`);
      const json = await res.json();
      setLb(json.lb || []);
      setPositions(json.positions || []);
      setGw(json.gw || null);
      setDeepseekFallback(Boolean(json.deepseekFallback));
      setControlsReady(Boolean(json.controlsReady));
      setControlTokenRequired(Boolean(json.controlTokenRequired));
      setControlMessage(String(json.controlMessage || ''));
      setPersistenceMode(json.persistenceMode || 'unknown');
      setExecutionAssumptions(json.executionAssumptions || null);
    } finally {
      loadingLbRef.current = false;
    }
  }, []);

  const reviveGateway = async () => {
    setMsg('Ping gateway…');
    try {
      const r = await fetch('/api/arena', { method: 'POST', headers: controlHeaders(), body: JSON.stringify({ action: 'gw-ping' }) });
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
      const updates = await Promise.all(symbols.split(',').map(async (sym) => {
        try {
          const r = await fetch(`/api/arena-candles?symbol=${encodeURIComponent(sym)}&gran=1m&lastOnly=1`);
          if (!r.ok) return null;
          const arr = await r.json();
          const px = Array.isArray(arr) && arr.length ? arr[arr.length - 1].close : null;
          return typeof px === 'number' ? [sym, px] as const : null;
        } catch { return null; /* tahan mark sebelumnya */ }
      }));
      if (alive) setMarks((current) => ({ ...current, ...Object.fromEntries(updates.filter((x): x is readonly [string, number] => x !== null)) }));
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, [symbols]);

  useEffect(() => {
    loadLb().catch(() => setMsg('Gagal memuat status arena. Coba muat ulang halaman.'));
    loadModels();
  }, [loadLb, loadModels]);

  const router = useRouter();
  const latestSnapshot = lb
    .map((row) => row.lastSnapshot)
    .filter((snapshot): snapshot is NonNullable<LeaderRow['lastSnapshot']> => Boolean(snapshot))
    .sort((a, b) => b.capturedAt - a.capturedAt)[0];
  const snapshotAgeSeconds = latestSnapshot ? Math.max(0, Math.round((Date.now() - latestSnapshot.capturedAt) / 1000)) : null;
  const newestBarAgeSeconds = latestSnapshot?.newestBarAt
    ? Math.max(0, Math.round(Date.now() / 1000 - latestSnapshot.newestBarAt))
    : null;

  // Pisahkan refresh UI dari eksekusi LLM: state baru langsung terlihat
  // walau model sedang berpikir, dan jangan menunggu request step untuk tick berikutnya.
  useEffect(() => {
    let alive = true;
    const refresh = () => { if (alive) void loadLb().catch(() => undefined); };
    const tick = async () => {
      const control = controlsRef.current;
      if (!autoRef.current || steppingRef.current || !control.ready || (control.required && !control.token)) return;
      steppingRef.current = true;
      setStepping(true);
      try {
        const response = await fetch('/api/arena', {
          method: 'POST',
          headers: controlHeaders(),
          // backend tetap membatasi satu iterasi per candle baru
          body: JSON.stringify({ action: 'step', force: false }),
        });
        if (!response.ok) throw new Error(`step HTTP ${response.status}`);
        refresh();
      } catch { /* keep polling */ }
      finally {
        if (alive) { steppingRef.current = false; setStepping(false); }
      }
    };
    // Prompt eksekusi segera saat memasuki arena; interval 30s memberi
    // gateway kesempatan meng-update tanpa menunggu 90 detik.
    void tick();
    const stepTimer = setInterval(tick, 30_000);
    const refreshTimer = setInterval(refresh, 5_000);
    return () => { alive = false; clearInterval(stepTimer); clearInterval(refreshTimer); };
  }, [loadLb]);

  const start = async () => {
    setBooting(true);
    try {
      const res = await fetch('/api/arena', {
        method: 'POST',
        headers: controlHeaders(),
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
      if (!controlsRef.current.ready || (controlsRef.current.required && !controlsRef.current.token)) {
      setMsg(`Kontrol terkunci: ${controlMessage || 'periksa konfigurasi server dan token operator.'}`);
        return;
      }
      const res = await fetch('/api/arena', {
        method: 'POST',
        headers: controlHeaders(),
        // Manual scan tetap menghormati gate candle baru.
        body: JSON.stringify({ action: 'step', force: false }),
      });
      const json = await res.json();
      if (!json.ok) setMsg(`Step gagal: ${json.error}`);
      else if (!(json.results || []).length) setMsg('Tidak ada model aktif untuk diperiksa.');
      else if ((json.results || []).every((result: { skipped?: boolean }) => result.skipped)) setMsg('Belum ada candle baru. Data diperiksa, tetapi model tidak mengulang keputusan dari candle yang sama.');
      await loadLb();
    } finally {
      steppingRef.current = false;
      setStepping(false);
    }
  };

  const toggleAgent = async (model: string, running: boolean) => {
    await fetch('/api/arena', {
      method: 'POST',
      headers: controlHeaders(),
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
                AI Arena <span style={{ color: '#fbbf24', fontWeight: 600, fontSize: 12, letterSpacing: '.08em' }}>PAPER SIMULATION</span>
              </h1>
              <p style={{ color: '#9ca3af', margin: '6px 0 0', fontSize: 13, maxWidth: 640 }}>
                Setiap model mengelola modal virtual $1.000. Hasil ini simulasi berbasis candle dan asumsi biaya—bukan eksekusi broker, rekomendasi investasi, atau bukti profit live.
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {gw && (
                  <button
                    type="button"
                    style={{ padding: '8px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: gw.down && canControl ? 'pointer' : 'default', border: `1px solid ${gw.down ? '#ef4444' : '#10b981'}`, color: gw.down ? '#fca5a5' : '#86efac', background: 'transparent' }}
                    onClick={gw.down && canControl ? reviveGateway : undefined}
                    disabled={!canControl}
                    title={gw.down ? `Terlihat mati: ${gw.lastErr} — klik untuk ping ulang` : ''}
                  >
                    {gw.down ? '🔴 gateway mati — klik untuk bangunkan' : '🟢 gateway hidup'}
                  </button>
                )}
                {deepseekFallback && (
                  <span style={{ padding: '8px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600, border: '1px solid #22c55e', color: '#86efac' }}>
                    DeepSeek fallback dikonfigurasi
                  </span>
                )}
              <button
                onClick={() => setAuto((a) => !a)}
                disabled={!canControl}
                style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #4b5563', background: auto && canControl ? 'rgba(59,130,246,.2)' : 'transparent', color: canControl && auto ? '#3b82f6' : '#9ca3af', cursor: canControl ? 'pointer' : 'not-allowed', fontSize: 12, fontWeight: 600 }}
                title="Pemeriksaan setiap 30 detik; AI memutuskan hanya saat candle baru"
              >
                {!canControl ? '🔒 Controls locked' : auto ? 'Autonomous: ON' : 'Autonomous: OFF'}
              </button>
              <button
                onClick={stepNow}
                disabled={stepping || !canControl}
                style={{ padding: '8px 14px', borderRadius: 8, border: 'none', background: stepping ? '#374151' : '#2563eb', color: '#fff', cursor: stepping ? 'wait' : 'pointer', fontSize: 12, fontWeight: 600 }}
              >
                {stepping ? '⏳ Memeriksa…' : '▶ Periksa sekarang'}
              </button>
            </div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14, paddingTop: 12, borderTop: '1px solid #273244', color: '#9ca3af', fontSize: 11 }}>
            <span style={{ color: controlsReady ? '#86efac' : '#fca5a5' }}>
              Controls: {controlsReady ? (controlTokenRequired ? 'token protected' : 'development mode') : `locked — ${controlMessage || 'check server configuration'}`}
            </span>
            <span>Persistence: {persistenceMode}</span>
            {latestSnapshot && <span>Snapshot computed {snapshotAgeSeconds}s ago · newest market bar age {newestBarAgeSeconds ?? '—'}s · {latestSnapshot.availableAssets}/{latestSnapshot.requestedAssets} assets · TF {latestSnapshot.primaryInterval}</span>}
            {latestSnapshot?.missingSymbols.length ? <span style={{ color: '#fbbf24' }}>Missing: {latestSnapshot.missingSymbols.join(', ')}</span> : null}
            {latestSnapshot?.benchmarkMissingTimeframes.length ? <span style={{ color: '#fbbf24' }}>Benchmark unavailable: {latestSnapshot.benchmarkMissingTimeframes.join(', ')}</span> : null}
          </div>
          {executionAssumptions && (
            <details style={{ marginTop: 8, color: '#9ca3af', fontSize: 11 }}>
              <summary style={{ cursor: 'pointer' }}>Asumsi biaya & batas simulasi</summary>
              <p style={{ margin: '8px 0' }}>{executionAssumptions.note}</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {Object.entries(executionAssumptions.profiles).map(([klass, profile]) => (
                  <span key={klass} style={{ padding: '4px 7px', border: '1px solid #374151', borderRadius: 6 }}>
                    {klass}: fee {profile.feeBpsPerSide} bps/side · slip {profile.slippageBpsPerSide} bps/side · {profile.basis}
                  </span>
                ))}
              </div>
            </details>
          )}
          {controlTokenRequired && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, color: '#9ca3af', fontSize: 11 }}>
              Operator token
              <input
                type="password"
                autoComplete="current-password"
                value={controlToken}
                onChange={(event) => setControlToken(event.target.value)}
                placeholder="ARENA_CONTROL_TOKEN"
                aria-label="Arena operator token"
                style={{ width: 260, maxWidth: '100%', padding: '8px 10px', borderRadius: 7, border: '1px solid #4b5563', background: '#0b1220', color: '#f9fafb' }}
              />
              <span>disimpan hanya di sesi tab ini</span>
            </label>
          )}
          {msg && <p style={{ color: '#fbbf24', fontSize: 12, margin: '10px 0 0' }}>{msg}</p>}
        </div>

        {/* Pendaftaran model (kalau arena masih kosong) */}
        <div style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <h2 style={{ fontSize: 15, color: '#f9fafb', margin: 0 }}>Daftar peserta (pilih model gateway)</h2>
            <button
              onClick={start}
              disabled={booting || models.length === 0 || !canControl}
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
            <span style={{ fontSize: 11, color: '#6b7280', alignSelf: 'center' }}>Urut: expectancy + shrinkage heuristik untuk sampel kecil · riwayat maksimal 200 trade</span>
          </div>
          {lb.length === 0 && (
            <p style={{ color: '#6b7280', fontSize: 12, margin: 0 }}>Belum ada peserta — tekan "🚀 Mulai Arena" di panel atas.</p>
          )}
          <div style={{ overflowX: 'auto' }}>
          {lb.map((row, i) => (
            <div
              key={row.model}
              onClick={() => router.push(`/models/${encodeURIComponent(row.model)}`)}
              role="link"
              tabIndex={0}
              onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') router.push(`/models/${encodeURIComponent(row.model)}`); }}
              style={{
                display: 'grid',
                gridTemplateColumns: '44px minmax(190px,1.4fr) 120px 92px 108px 92px 76px 80px 72px 70px',
                minWidth: 970,
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
                <div style={{ color: '#9ca3af', fontSize: 10 }}>EXPECTANCY</div>
                <div style={{ color: rColor(row.stats.avgR), fontWeight: 800, fontSize: 14 }}>{row.tradeSample ? `${row.stats.avgR >= 0 ? '+' : ''}${row.stats.avgR.toFixed(2)}R` : '—'}</div>
                <div style={{ color: '#6b7280', fontSize: 10 }}>score {row.expectancyScore == null ? '—' : `${row.expectancyScore >= 0 ? '+' : ''}${row.expectancyScore.toFixed(2)}R`}</div>
              </div>
              <div>
                <div style={{ color: '#9ca3af', fontSize: 10 }}>RECORDED R</div>
                <div style={{ color: rColor(row.stats.totalR), fontSize: 12 }}>{row.stats.totalR >= 0 ? '+' : ''}{row.stats.totalR.toFixed(2)}R</div>
              </div>
              <div>
                <div style={{ color: '#9ca3af', fontSize: 10 }}>OBS. DD*</div>
                <div style={{ color: row.maxDrawdownPct > 0 ? '#fca5a5' : '#e5e7eb', fontSize: 12 }}>{row.maxDrawdownPct.toFixed(2)}%</div>
              </div>
              <div>
                <div style={{ color: '#9ca3af', fontSize: 10 }}>TRADES</div>
                <div style={{ color: '#e5e7eb', fontSize: 12 }}>{row.tradeSample}{row.tradeHistoryCapped ? ' · last 200' : ''}</div>
                <div style={{ color: '#6b7280', fontSize: 10 }}>{row.stats.totalTrades > 0 ? `${row.stats.winRate.toFixed(0)}% win` : 'no closed trade'}</div>
              </div>
              <div>
                <div style={{ color: '#9ca3af', fontSize: 10 }}>OPEN POSISI</div>
                <div style={{ color: '#e5e7eb', fontSize: 12 }}>{row.openCount}</div>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); toggleAgent(row.model, row.running); }}
                disabled={!canControl}
                style={{ padding: '5px 10px', fontSize: 10, borderRadius: 6, cursor: 'pointer', background: 'transparent', border: '1px solid #4b5563', color: row.running ? '#ef4444' : '#10b981' }}
              >
                {row.running ? 'stop' : 'resume'}
              </button>
            </div>
          ))}
          </div>
        </div>

        {/* Live positions */}
        <div style={card}>
          <h2 style={{ fontSize: 15, color: '#f9fafb', margin: '0 0 10px' }}>Open simulated positions <span style={{ color: '#9ca3af', fontSize: 11, fontWeight: 400 }}>mark source: latest 1m candle, not broker tick</span></h2>
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
                        // R = pnl / riskDollar entry (bukan jarak stop — stop sudah pindah ke
                        // breakeven/trail, jadi jarak entry→SL tidak lagi sama dengan 1R)
                        const exitPx = m * (1 + (dir === 1 ? -1 : 1) * (p.slippageBpsPerSide || 0) / 10_000);
                        const gross = (exitPx - p.entryPrice) * dir * (p.qty || 0);
                        const fees = (p.feeBpsPerSide || 0) / 10_000 * (p.qty || 0) * (p.entryPrice + exitPx);
                        const lr = p.riskDollar && p.qty
                          ? (gross - fees) / Math.max(1e-9, p.riskDollar)
                          : ((m - p.entryPrice) * dir) / Math.max(1e-9, Math.abs(p.entryPrice - p.stopLoss));
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
        {/* Model-provided rationale (not chain-of-thought) */}
        <div style={card}>
          <h2 style={{ fontSize: 15, color: '#f9fafb', margin: '0 0 4px' }}>Decision audit</h2>
          <p style={{ color: '#6b7280', fontSize: 11, margin: '0 0 10px' }}>Rasional di bawah ditulis oleh model; ini bukan chain-of-thought atau bukti validitas keputusan. Catatan teknis menampilkan provider, latensi, candle, dan data yang diterima.</p>
          {lb.filter((r) => (r.thoughts || []).length > 0).length === 0 ? (
            <p style={{ color: '#6b7280', fontSize: 12, margin: 0 }}>
              Belum ada keputusan yang tercatat. AI hanya diminta mengevaluasi setup pada candle baru.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {lb
                .filter((r) => (r.thoughts || []).length > 0)
                .map((r) => (
                  <div key={`think-${r.model}`} style={{ border: '1px solid #1f2937', borderRadius: 10, padding: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      <b style={{ color: '#f9fafb', fontSize: 13 }}>{r.model.split('/').pop()}</b>
                      <span style={{ color: '#6b7280', fontSize: 11 }}>iter {r.iterCount} · {r.running ? 'running' : 'stopped'}</span>
                    </div>
                    {r.lastDecision && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '4px 0 8px', color: '#9ca3af', fontSize: 10 }}>
                        <span>{r.lastDecision.validDecision ? 'JSON parsed' : 'response not parsed'}</span>
                        <span>{r.lastDecision.provider}{r.lastDecision.fallback ? ' · fallback' : ''}</span>
                        <span>model {r.lastDecision.modelLatencyMs} ms · total {r.lastDecision.latencyMs} ms</span>
                        <span>TF {r.lastDecision.interval}</span>
                        <span>{r.lastDecision.signalCount} signals · candidates: {r.lastDecision.candidateSymbols.join(', ') || 'none'}</span>
                        {r.lastDecision.error && <span style={{ color: '#fca5a5' }}>{r.lastDecision.error}</span>}
                      </div>
                    )}
                    {(r.thoughts || []).map((th, i) => (
                      <div key={i} style={{ padding: '8px 0', borderTop: i === 0 ? 'none' : '1px dashed #1f2937' }}>
                        <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3 }}>
                          {new Date(th.time).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} · aksi: <span style={{ color: '#fbbf24' }}>{th.actions || '—'}</span>
                        </div>
                        <div style={{ fontSize: 13, color: '#f3f4f6', lineHeight: 1.55 }}>
                          Model rationale: <span style={{ fontWeight: 500 }}>{th.thoughtPlain || th.thought || '—'}</span>
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
