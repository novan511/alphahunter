/**
 * Orkestrasi laboratorium Monte Carlo otonom.
 *
 * Alur satu iterasi:
 *   pilih proposal (AI → validasi → fallback) → jalankan engine → putuskan →
 *   simpan. Progres ditulis ke baris Supabase yang sama supaya UI bisa
 *   memantaunya dari instance serverless mana pun.
 *
 * Cooldown 10 menit ditegakkan di sini, bukan di cron: cron bisa telat, dobel,
 * atau dipanggil manual. Satu sumber kebenaran = satu tempat.
 */

import { getSupabase, isSupabaseConfigured } from '../supabase';
import { ensureSupabaseAdmin, isSupabaseAdminConfigured } from '../supabaseAdmin';
import { callLLM } from './marketNarrator';
import {
  LAB_CATALOG,
  LAB_COOLDOWN_MINUTES,
  LAB_FAMILIES,
  LAB_INTERVALS,
  LAB_MAX_STORED_TRADES,
  fallbackProposal,
  groupForAsset,
  storedTrades,
  validateProposal,
  type HistoryLite,
  type LabProposal,
} from './mcLabSpec';
import {
  judge,
  runLabExperiment,
  type BacktestOutput,
  type Judgement,
  type RunOutput,
} from './mcLabEngine';

export interface McLabRow {
  id: string;
  created_at: string;
  finished_at?: string | null;
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
  metrics: (Partial<BacktestOutput> & { notes?: string[] }) | null;
  error: string | null;
}

const TABLE = 'mc_lab_runs';

export function isLabConfigured(): boolean {
  // Riwayat dibaca dengan anon key; penulisan butuh service-role (RLS hanya
  // mengizinkan select untuk anon).
  return isSupabaseConfigured() && isSupabaseAdminConfigured();
}

/**
 * Service-role key yang berasal dari project lain gagal SENYAP di setiap
 * iterasi (RLS menolak, error ditelan pemanggil). Deteksi dini: ref project
 * ada di klaim `ref` JWT dan di hostname URL Supabase.
 */
export function serviceKeyProjectMismatch(): string | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return null;
  const host = url.replace(/^https?:\/\//, '').split('.')[0];
  try {
    const payload = key.split('.')[1];
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as { ref?: string };
    if (json.ref && host && json.ref !== host) {
      return `SUPABASE_SERVICE_ROLE_KEY milik project "${json.ref}", sedangkan URL menunjuk "${host}". Salin service_role key dari project yang sama.`;
    }
  } catch {
    /* JWT tidak bisa dibaca — biarkan probe yang memutuskan */
  }
  return null;
}

/**
 * Probe sekali per panggilan: tabel belum dimigrasi harus muncul sebagai
 * instruksi jelas di UI, bukan halaman kosong tanpa penjelasan.
 */
export async function isTableReady(): Promise<boolean> {
  const supabase = await db();
  if (!supabase) return false;
  const { error } = await supabase.from(TABLE).select('id').limit(1);
  if (!error) return true;
  return !/schema cache|does not exist|PGRST205/i.test(error.message);
}

async function db() {
  return getSupabase();
}

async function dbWrite() {
  return ensureSupabaseAdmin();
}

export async function latestRun(): Promise<McLabRow | null> {
  const supabase = await db();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    // Tabel belum dibuat: jangan bikin halaman error, cukup tampilkan
    // instruksi migrasi lewat flag configured.
    if (/schema cache|does not exist|PGRST205/i.test(error.message)) return null;
    throw new Error(error.message);
  }
  return (data as McLabRow) || null;
}

export async function history(limit = 40): Promise<McLabRow[]> {
  const supabase = await db();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200));
  if (error) {
    if (/schema cache|does not exist|PGRST205/i.test(error.message)) return [];
    throw new Error(error.message);
  }
  return (data as McLabRow[]) || [];
}

export function nextDueAt(last: McLabRow | null): number | null {
  if (!last) return null;
  if (last.status === 'running') return null;
  // Jeda dihitung dari SAAT SELESAI, bukan saat mulai: yang diminta adalah
  // 10 menit setelah iterasi selesai, bukan setelah ia dimulai.
  const t = Date.parse(last.finished_at || last.created_at);
  if (Number.isNaN(t)) return null;
  return t + LAB_COOLDOWN_MINUTES * 60_000;
}

export function isDue(last: McLabRow | null, now = Date.now()): boolean {
  if (!last) return true;
  if (last.status === 'running') return false;
  const due = nextDueAt(last);
  return due == null ? true : now >= due;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function historyDigest(rows: McLabRow[]): string {
  if (rows.length === 0) return 'Belum ada eksperimen. Mulai dari aset big cap.';
  return rows
    .slice(0, 25)
    .map((r) => {
      const m = r.metrics;
      const oos = m?.oos?.length ? `${m.oosPositive}/${m.oos.length} OOS positif` : 'OOS n/a';
      const pf = m?.oos?.length
        ? `PF OOS ${(m.oos.reduce((a, x) => a + x.profitFactor, 0) / m.oos.length).toFixed(2)}`
        : 'PF n/a';
      const mc = m?.mc ? `MC profit ${(m.mc.probProfit * 100).toFixed(0)}%` : 'MC n/a';
      return `- ${r.asset} | ${r.family} | ${r.interval} | ${r.macro_filter || 'none'} | ${r.verdict} (${r.score}) | ${oos}, ${pf}, ${mc}`;
    })
    .join('\n');
}

function testedCells(rows: McLabRow[]): string {
  const done = rows.filter((r) => r.status === 'done' && r.asset && r.family && r.interval);
  const tested = new Set(done.map((r) => `${r.asset}|${r.family}|${r.interval}`));
  const missing: string[] = [];
  for (const g of LAB_CATALOG) {
    for (const asset of g.assets) {
      for (const fam of LAB_FAMILIES) {
        if (!tested.has(`${asset}|${fam}|1d`)) missing.push(`${asset} × ${fam}`);
        if (missing.length >= 40) break;
      }
      if (missing.length >= 40) break;
    }
    if (missing.length >= 40) break;
  }
  return missing.length ? missing.join(', ') : 'semua sel big cap × keluarga pada 1d sudah diuji';
}

export function buildProposalPrompt(rows: McLabRow[]): string {
  const catalog = LAB_CATALOG.map(
    (g) => `- ${g.label}: ${g.assets.join(', ')}`
  ).join('\n');

  return `Kamu adalah PERANCANG EKSPERIMEN untuk Althunter, bukan penasihat trading.

Tugasmu: pilih SATU eksperimen berikutnya yang paling informatif. Engine akan menjalankannya secara deterministik; kamu tidak menghitung angka apa pun dan tidak boleh mengarang hasil.

KATALOG TITIK AWAL (boleh memakai aset lain dengan format yang sama):
${catalog}

FORMAT ASET: "binance:SYMBOL", "hyperliquid:COIN", atau ticker Yahoo ("yahoo:GC=F", "yahoo:NVDA", "yahoo:SPY"). Jangan pakai spasi atau tanda kutip.

KELUARGA ATURAN: ${LAB_FAMILIES.join(', ')}
TIMEFRAME: ${LAB_INTERVALS.join(', ')} (1h/4h hanya ~2 tahun terakhir; 1d/1w sejak 2000)
FILTER MAKRO: none, vix_low, vix_high, fed_easing, fed_tightening, curve_inverted, curve_positive

RIWAYAT EKSPERIMEN (terbaru dulu):
${historyDigest(rows)}

SEL YANG BELUM DIUJI (prioritaskan yang masih kosong, big cap dulu):
${testedCells(rows)}

ATURAN MEMILIH:
1. Jangan ulangi kombinasi aset+keluarga+timeframe yang sudah diuji, kecuali kamu mengubah parameter secara berarti (sebutkan perubahan itu di rationale).
2. Kalau sebuah sel gagal (verdict none/weak), pindah ke sel lain dulu; jangan mengulang dengan tweak kecil berulang.
3. Prioritaskan aset paling likuid di kelasnya sebelum melebar ke aset kecil.
4. Parameter harus masuk akal: EMA cepat < EMA lambat, RSI beli > RSI jual, target ATR tidak lebih kecil dari setengah stop ATR.
5. rationale maksimal 400 karakter, bahasa Indonesia, menjelaskan HIPOTESIS yang diuji — bukan prediksi harga, bukan janji profit.

KELUARAN WAJIB: satu objek JSON saja, tanpa markdown:
{
  "asset": "binance:BTCUSDT",
  "interval": "1d",
  "family": "trend",
  "macroFilter": "none",
  "params": {
    "fast": 20, "slow": 100, "rsiPeriod": 14, "rsiBuy": 55, "rsiSell": 45,
    "rocPeriod": 20, "rocThreshold": 0.04, "donchian": 55, "zEntry": 1.5,
    "atrStop": 2, "atrTarget": 3, "maxHold": 60, "allowShort": true, "minTouches": 2
  },
  "rationale": "<=400 karakter"
}`;
}

/** AI → validasi → fallback. Tidak pernah melempar. */
export async function proposeNext(rows: McLabRow[]): Promise<LabProposal> {
  // Run yang gagal (data tidak tersedia) tidak boleh dianggap "sudah diuji":
  // sel itu justru perlu dicoba lagi nanti dengan aset lain.
  const usable = rows.filter((r) => r.status !== 'failed');
  const lite: HistoryLite[] = usable.map((r) => ({
    asset: r.asset || '',
    family: r.family || '',
    interval: r.interval || '',
    verdict: r.verdict,
  }));

  try {
    const raw = await callLLM(buildProposalPrompt(usable), {
      system:
        'Kamu merancang eksperimen backtest. Keluarkan hanya JSON valid sesuai skema. ' +
        'Jangan pernah menulis janji profit, perintah beli/jual, atau angka hasil yang belum diukur.',
    });
    const checked = validateProposal(raw);
    if (checked.ok && checked.value) {
      // Tolak pengulangan identik supaya iterasi tidak berputar di tempat.
      const dup = usable.some(
        (r) =>
          r.asset === checked.value!.asset &&
          r.family === checked.value!.family &&
          r.interval === checked.value!.interval
      );
      if (!dup) return checked.value;
      const fb = fallbackProposal(lite);
      return { ...fb, rationale: `Model mengusulkan sel yang sudah diuji; fallback memilih ${fb.asset} × ${fb.family}.` };
    }
    const fb = fallbackProposal(lite);
    return { ...fb, rationale: `${fb.rationale} (proposal model ditolak: ${checked.error})` };
  } catch {
    return fallbackProposal(lite);
  }
}

// ---------------------------------------------------------------------------
// Iterasi
// ---------------------------------------------------------------------------

export interface IterationResult {
  ran: boolean;
  reason?: string;
  runId?: string;
  proposal?: LabProposal;
  verdict?: Judgement['verdict'];
  score?: number;
  error?: string;
}

async function createRow(proposal: LabProposal): Promise<string | null> {
  const supabase = await dbWrite();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      status: 'running',
      stage: 'menyiapkan',
      progress: 0,
      asset: proposal.asset,
      interval: proposal.interval,
      family: proposal.family,
      macro_filter: proposal.macroFilter,
      rationale: proposal.rationale,
      source: proposal.source,
    })
    .select('id')
    .single();
  if (error) {
    console.warn('[mc-lab] insert gagal:', error.message);
    if (/schema cache|does not exist|PGRST205/i.test(error.message)) {
      throw new Error(
        'tabel mc_lab_runs belum ada — jalankan supabase/migrations/016_mc_lab_runs.sql di SQL Editor'
      );
    }
    return null;
  }
  return data?.id ?? null;
}

async function patchRow(id: string | null, patch: Record<string, unknown>): Promise<void> {  if (!id) return;
  const supabase = await dbWrite();
  if (!supabase) return;
  const { error } = await supabase.from(TABLE).update(patch).eq('id', id);
  if (error) console.warn('[mc-lab] update gagal:', error.message);
}

/**
 * Jalankan satu iterasi. `force` melewati cooldown (tombol manual), tetapi
 * tidak pernah menjalankan dua iterasi paralel.
 */
export async function runIteration(opts: { force?: boolean; source?: string } = {}): Promise<IterationResult> {
  if (!isSupabaseConfigured()) {
    return { ran: false, reason: 'supabase belum dikonfigurasi — riwayat tidak bisa disimpan' };
  }

  const last = await latestRun();
  if (last?.status === 'running') {
    const started = Date.parse(last.created_at);
    // Run yang macet > 5 menit dianggap mati (serverless timeout), bukan aktif.
    if (Number.isFinite(started) && Date.now() - started < 5 * 60_000) {
      return { ran: false, reason: 'iterasi lain masih berjalan' };
    }
  }
  // shortcut: cek-lalu-insert bukan operasi atomik; dua pemanggil yang tiba
  // persis bersamaan bisa sama-sama lolos. Workflow cron memakai concurrency
  // group, jadi risiko nyata hanya tombol UI yang ditekan beruntun.
  // Upgrade: unique partial index pada status='running' bila perlu dijamin.
  if (!opts.force && !isDue(last)) {
    const due = nextDueAt(last);
    return {
      ran: false,
      reason: `cooldown ${LAB_COOLDOWN_MINUTES} menit — berikutnya ${due ? new Date(due).toISOString() : 'n/a'}`,
    };
  }

  const rows = await history(60);
  const proposal = await proposeNext(rows);
  let runId: string | null = null;
  try {
    runId = await createRow(proposal);
  } catch (err) {
    return { ran: false, reason: err instanceof Error ? err.message : 'gagal menulis ke database', proposal };
  }
  if (!runId) {
    return {
      ran: false,
      reason: 'SUPABASE_SERVICE_ROLE_KEY belum diset/ditolak — hasil tidak bisa disimpan',
      proposal,
    };
  }

  try {
    const out: RunOutput = await runLabExperiment({
      proposal,
      onStage: async (stage, progress) => {
        await patchRow(runId, { stage, progress });
      },
    });

    await patchRow(runId, { stage: 'menilai hasil', progress: 95 });
    const verdict = judge(out);

    await patchRow(runId, {
      status: 'done',
      stage: 'selesai',
      progress: 100,
      finished_at: new Date().toISOString(),
      verdict: verdict.verdict,
      score: verdict.score,
      reasons: verdict.reasons,
      metrics: {
        full: out.full,
        oos: out.oos,
        oosPositive: out.oosPositive,
        mc: out.mc,
        params: out.params,
        // Trade terakhir (maks 300) disertai saldo berjalan supaya UI bisa
        // menggambar chart setup + tabel saldo seperti rencana backtest manual.
        // Saldo dihitung dari urutan PENUH, jadi tetap benar walau terpotong.
        trades: storedTrades(out.trades),
        tradesTotal: out.trades.length,
        tradesTruncated: out.trades.length > LAB_MAX_STORED_TRADES,
        filterBlockedPct: out.filterBlockedPct,
        dataFrom: out.dataFrom,
        dataTo: out.dataTo,
        bars: out.bars,
        notes: out.notes,
        benchmark: out.benchmark,
      },
      source: `${proposal.source}:${opts.source || 'manual'}`,
      asset: out.asset,
      interval: out.interval,
      family: out.family,
      macro_filter: out.macroFilter,
    });

    return {
      ran: true,
      runId: runId || undefined,
      proposal,
      verdict: verdict.verdict,
      score: verdict.score,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'iterasi gagal';
    await patchRow(runId, {
      status: 'failed',
      stage: 'gagal',
      progress: 100,
      finished_at: new Date().toISOString(),
      error: msg,
    });
    return { ran: false, reason: msg, runId: runId || undefined, error: msg };
  }
}

export function summarizeGroup(rows: McLabRow[], group: string) {
  const done = rows.filter((r) => r.status === 'done' && groupForAsset(r.asset || '') === group);
  if (done.length < 3) return null;
  const strong = done.filter((r) => r.verdict === 'strong' || r.verdict === 'promising');
  return {
    tested: done.length,
    promising: strong.length,
    best: done.slice().sort((a, b) => (b.score || 0) - (a.score || 0))[0] || null,
  };
}
