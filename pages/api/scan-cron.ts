import type { NextApiRequest, NextApiResponse } from 'next';
import { createHash, randomUUID } from 'crypto';
import { getSupabase, isSupabaseConfigured } from '../../lib/supabase';
import { runAutonomousChunk } from '../../lib/autonomousChunk';
import { buildRanges, parseRanges } from '../../lib/ranges';
import type { MultiTimeframeResult } from '../../lib/algorithms/multiTimeframe';
import { RegimeResult } from '../../lib/algorithms/marketRegime';
import { AutonomousParams } from '../../lib/algorithms/autonomousParams';
import { buildSummaries } from './scans-save';
import { sendTelegramMessage, telegramEnv } from '../../lib/serverTelegram';
import { tgFrame, TG_FOOTER, signalLabel } from '../../lib/tgMessage';
import { buildTradeableList, TradeableCoin } from '../../lib/algorithms/tradeable';
import { computeMatrix } from '../../lib/algorithms/correlationMatrix';
import { tfSigned } from '../../lib/algorithms/multiTimeframe';
import { buildPortfolioPlan, buildRotationDigest } from '../../lib/algorithms/portfolioVerdict';
import { buildEarlyWarnings } from '../../lib/algorithms/earlyWarning';
import { buildSectorHeat } from '../../lib/algorithms/narrativeHeat';
import { fetchPairRatio } from '../../lib/algorithms/pairRatio';
import { fetchKlinesRouted } from '../../lib/universe';
import { recordSignals, scoreLedger, scoreLedgerR } from '../../lib/signalLedger';
import { ensureSupabaseAdmin } from '../../lib/supabaseAdmin';
import { isConfidentSignal } from '../../lib/confidentGate';
import { checkDataSources } from '../../lib/dataHealth';
import type { Candle } from '../../lib/types';

export const config = { maxDuration: 60 };

/**
 * Server-side autonomous scan worker.
 *
 * The browser sweep only exists while a tab is open. This route performs one
 * bounded chunk per invocation, persisting the cursor to Supabase so the sweep
 * survives across ticks. A scheduler calls it every N minutes; the sweep
 * completes after a few ticks and the result is written to scan_history (the
 * same table the browser and the Telegram bot read).
 *
 * Auth: requires SCAN_CRON_SECRET. Vercel Cron and GitHub Actions both send
 * a bearer token; without it the route is closed.
 *
 * Query/body:
 *   indexSymbol (default BTCUSDT), depth (default 'all'), universe
 *   ('curated' default | 'all'), budgetMs, maxChunks
 *
 * Response: { ok, state, done } where state is the persisted cursor.
 */

interface Body {
  indexSymbol?: string;
  depth?: string;
  universe?: 'curated' | 'all';
  budgetMs?: number;
  maxChunks?: number;
  /** Set false to run the scan without pushing to Telegram. */
  notify?: boolean;
}

const DEFAULT_BUDGET_MS = 40_000;

/** Supabase client shape used by the notifier (kept structural for testing). */
type Supa = NonNullable<ReturnType<typeof getSupabase>>;

interface PushResult {
  attempted: boolean;
  sent: number;
  failed: number;
  errors: string[];
}

function bare(sym: string): string {
  return (sym.includes(':') ? sym.slice(sym.indexOf(':') + 1) : sym).replace(/USDT$|USDC$/, '');
}

function pct(x: number, d = 2): string {
  return `${x >= 0 ? '+' : ''}${x.toFixed(d)}`;
}

/**
 * The basket the rotation verdict is computed over. Read from the shared
 * basket the web panel saves, so the phone is told about the same coins the
 * operator is looking at.
 */
async function loadBasket(supabase: Supa): Promise<string[]> {
  const { data } = await supabase
    .from('correlation_settings')
    .select('symbols')
    .eq('id', 'default')
    .limit(1)
    .maybeSingle();
  const syms = (data as { symbols?: string[] } | null)?.symbols;
  return Array.isArray(syms) && syms.length >= 2 ? syms.slice(0, 16) : [];
}

async function loadDominanceHistory(
  supabase: Supa,
  symbols: string[],
  interval: string,
  windowBars: number,
): Promise<Array<{ symbol: string; created_at: string; dominance: number | null; dominance_rank: number | null }>> {
  const { data } = await supabase
    .from('correlation_dominance_history')
    .select('symbol, created_at, dominance, dominance_rank')
    .in('symbol', symbols)
    .eq('interval', interval)
    .eq('window_bars', windowBars)
    .order('created_at', { ascending: false })
    .limit(symbols.length * 10);
  return (data ?? []) as Array<{ symbol: string; created_at: string; dominance: number | null; dominance_rank: number | null }>;
}

/**
 * Compute the pairwise matrix for the shared basket.
 * Returns null on any failure — a rotation push must never fail the scan.
 */
async function computeBasketMatrix(
  symbols: string[],
  interval: string,
  windowBars: number,
) {
  const settled = await Promise.allSettled(
    symbols.map((s) => fetchKlinesRouted(s, interval, windowBars * 3 + 60)),
  );
  const series: Record<string, Candle[]> = {};
  const failed: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value.length > 0) series[symbols[i]] = r.value;
    else failed.push(symbols[i]);
  });
  const available = Object.keys(series);
  if (available.length < 2) return null;
  const m = computeMatrix(series, available, windowBars, interval);
  if (!m) return null;
  if (failed.length > 0) console.warn('[cron] basket symbols skipped:', failed.join(','));
  return m;
}

/**
 * Build and send the post-scan Telegram digest.
 *
 * Three separate messages, not one blob:
 *   1. Rotation verdict  — hold / trim / drop on what you already carry.
 *   2. Tradeable entries — tickers with a valid setup right now.
 *   3. Sector warnings   — only when something actually flipped.
 *
 * Rationale: these answer different questions. Mixing them invites reading a
 * "TAHAN" as an entry signal. Rotation ranks the book; entries are a separate
 * gate; sector flips are timing.
 */
async function pushCompletedScan(args: {
  supabase: Supa;
  rankings: MultiTimeframeResult[];
  regime: RegimeResult;
  indexSymbol: string;
  depth: string;
  sweepId: string;
  /** Sumber data basi saat sweep berjalan — pembaca harus tahu. */
  degraded?: boolean;
}): Promise<PushResult> {
  const { supabase, rankings, regime, indexSymbol, depth, degraded } = args;
  const result: PushResult = { attempted: false, sent: 0, failed: 0, errors: [] };

  const { configured } = telegramEnv();
  if (!configured) {
    result.errors.push('telegram not configured');
    return result;
  }
  result.attempted = true;

  const interval = '4h';
  const windowBars = 30;
  const id = stateId(indexSymbol, depth);

  // Dedup cursor for sector flips AND the rotation verdict: don't re-push the
  // same sector within 24h, and never repeat an unchanged rotation digest.
  // No-op (empty cursor) if the migration hasn't been applied yet, so a missing
  // column never blocks rotation/entry pushes.
  const nowIso = new Date().toISOString();
  let lastSectors: Record<string, string> = {};
  let lastRotation: string | null = null;
  let freshSectors: Record<string, string> = {};
  try {
    const { data: stateRow } = await supabase
      .from('scan_cron_state')
      .select('last_notify')
      .eq('id', id)
      .maybeSingle();
    const raw = (stateRow as { last_notify?: { sectors?: Record<string, string>; rotation_digest?: string } } | null)
      ?.last_notify ?? {};
    lastSectors = raw.sectors ?? {};
    lastRotation = typeof raw.rotation_digest === 'string' ? raw.rotation_digest : null;
    freshSectors = { ...lastSectors };
  } catch {
    // Column not yet added — proceed without dedup.
  }
  // Persisted only after a successful send, so a failed push is retried next sweep.
  let rotationDigest: string | null = null;

  // ---- 1. Rotation verdict from the shared basket ----
  try {
    const basket = await loadBasket(supabase);
    if (basket.length >= 2) {
      const matrix = await computeBasketMatrix(basket, interval, windowBars);
      if (matrix) {
        // Persist the snapshot so the next push can measure persistence
        // (how many snapshots a coin has been weak in a row).
        await supabase.from('correlation_snapshots').insert({
          symbols: matrix.symbols,
          interval: matrix.interval,
          window_bars: matrix.window,
          basket_corr: matrix.basketCorr,
          rs: matrix.rs,
          corr: matrix.corr,
          beta: matrix.beta,
          coins: matrix.coins,
          missing: [],
          bars_used: matrix.bars,
          regime_label: regime.regime,
          regime_confidence: regime.confidence,
        }).then(() => undefined, () => undefined);

        const history = await loadDominanceHistory(supabase, matrix.symbols, interval, windowBars);
        const plan = buildPortfolioPlan(matrix, history);
        const digest = buildRotationDigest(plan);
        // Perhatian pengguna adalah anggaran paling mahal: digest yang sama
        // berkali-kali bukan informasi. Kirim hanya saat verdict berubah.
        const verdict = createHash('sha1').update(digest).digest('hex').slice(0, 8);
        if (verdict === lastRotation) {
          console.log('[rotasi] verdict tidak berubah — tidak dikirim');
        } else {
          const body = degraded
            ? `⚠ SUMBER DATA BASI — bacaan bisa menyesatkan\n\n${digest}`
            : digest;
          const framed = tgFrame('ROTASI', body);
          const sent = await sendTelegramMessage(framed);
          if (sent.ok) {
            result.sent++;
            rotationDigest = verdict;
            // Simpan verdukt di tempat yang sama dengan kursor sektor.
            await supabase
              .from('scan_cron_state')
              .update({
                last_notify: { sectors: freshSectors, rotation_digest: verdict },
              })
              .eq('id', id)
              .then(() => undefined, () => undefined);
          } else {
            result.failed++;
            result.errors.push(`rotasi: ${sent.error}`);
          }
        }
      }
    }
  } catch (err) {
    result.failed++;
    result.errors.push(`rotasi: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  // ---- 2. Tradeable entries ----
  try {
    const { trades } = buildTradeableList(rankings, {});
    if (trades.length > 0) {
      const lines = [
        `📈 Timeframe: ${interval}`,
        `🌍 Regime: ${regime.regime.replace(/_/g, ' ').toUpperCase()}`,
        `✅ ${trades.length} koin lolos gate`,
        ...(degraded ? ['⚠ SUMBER DATA BASI — bacaan bisa menyesatkan'] : []),
        '',
      ];
      for (const t of trades.slice(0, 8) as TradeableCoin[]) {
        const dir = t.direction === 'long' ? '🟢 LONG' : '🔴 SHORT';
        lines.push(`• ${t.ticker} ${dir} | Conf ${t.confluenceScore} | ${t.riskTier}`);
        lines.push(`  Alasan: ${t.why[0]}`);
        lines.push('');
      }
      lines.push('⚠️ Risk per trade maks 1% ekuitas. Stop wajib sebelum entry.');
      const framed = tgFrame('ENTRY', lines.join('\n'));
      const sent = await sendTelegramMessage(framed);
      if (sent.ok) result.sent++;
      else { result.failed++; result.errors.push(`entry: ${sent.error}`); }
    }
  } catch (err) {
    result.failed++;
    result.errors.push(`entry: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  // ---- 3. Sector flips ----
  try {
    const sectors = buildSectorHeat(rankings);
    // Empty history: every flip is treated as a first sighting, which is the
    // honest answer for a server sweep that has never seen a prior scan.
    const warnings = buildEarlyWarnings(sectors, {}, rankings).filter(
      (w) => w.severity === 'high',
    );
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const toSend = warnings.filter((w) => {
      const sentAt = lastSectors[w.sectorId];
      if (!sentAt) return true;
      return new Date(sentAt).getTime() < dayAgo;
    });

    if (toSend.length > 0) {
      const lines: string[] = [];
      for (const w of toSend.slice(0, 5)) {
        lines.push(`${w.sectorIcon} ${w.title}`);
        lines.push(`  ${w.detail}`);
        if (w.coins.length > 0) {
          lines.push(`  Koin: ${w.coins.slice(0, 5).map((c) => `${c.ticker} (${c.confluenceScore})`).join(', ')}`);
        }
        lines.push('');
        freshSectors[w.sectorId] = nowIso;
      }
      const framed = tgFrame('SEKTOR', lines.join('\n'), { footer: TG_FOOTER });
      const sent = await sendTelegramMessage(framed);
      if (sent.ok) {
        result.sent++;
        // Persist dedup cursor so the same sector isn't re-pushed within 24h.
        await supabase
          .from('scan_cron_state')
          .update({
            last_notify: {
              sectors: freshSectors,
              rotation_digest: rotationDigest ?? lastRotation,
            },
          })
          .eq('id', id)
          .then(() => undefined, () => undefined);
      } else {
        result.failed++;
        result.errors.push(`sektor: ${sent.error}`);
      }
    }
  } catch (err) {
    result.failed++;
    result.errors.push(`sektor: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  return result;
}

/** ---------- Top signals: persist + confident Telegram ---------- */

const SIGNAL_TYPES: Array<'strong_buy' | 'buy' | 'strong_sell' | 'sell'> = [
  'strong_buy',
  'buy',
  'strong_sell',
  'sell',
];

/** Simpan top 10 per kelas sinyal ke tabel top_signals (Supabase). */
async function persistTopSignals(
  supabase: Supa,
  rankings: MultiTimeframeResult[]
): Promise<void> {
  // One insert for all classes: this runs inside the 60s route budget, and a
  // row-per-round-trip costs ~0.3s each.
  const rows: Record<string, unknown>[] = [];
  for (const type of SIGNAL_TYPES) {
    for (const r of rankings
      .filter((x) => x.finalSignal === type)
      .sort((a, b) => b.confluenceScore - a.confluenceScore)
      .slice(0, 10)) {
      rows.push({
        signal_type: type,
        asset: r.asset,
        confluence_score: r.confluenceScore,
        conviction: r.conviction ?? null,
        agreement: r.agreement ?? null,
        timeframe: '4h',
        sent_to_telegram: false,
      });
    }
  }
  if (rows.length === 0) return;
  await supabase
    .from('top_signals')
    .insert(rows)
    .then(() => undefined, () => undefined); // jangan gagalkan scan saat insert gagal
}

/** Ambil asset yang sudah dikirim Telegram dalam 24 jam terakhir (dedup). */
async function getAlreadySentKeys(supabase: Supa): Promise<Set<string>> {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('top_signals')
    .select('asset, signal_type')
    .eq('sent_to_telegram', true)
    .gte('created_at', yesterday);

  const set = new Set<string>();
  for (const row of data ?? []) {
    set.add(`${row.signal_type}:${row.asset}`);
  }
  return set;
}

/** Alasan satu baris mengapa sinyal ini muncul, untuk dibaca di Telegram. */
function signalReason(r: MultiTimeframeResult): string {
  const parts: string[] = [];
  const active = r.timeframes.filter((t) => t.active);
  if (active.length > 0 && r.confluenceDirection !== 'none') {
    const sign = r.confluenceDirection === 'bullish' ? 1 : -1;
    const agreeing = active.filter((t) => tfSigned(t) * sign > 0).length;
    parts.push(`${agreeing}/${active.length} TF searah`);
  }
  if (r.newestSignalAgeBars != null) {
    parts.push(
      r.newestSignalAgeBars === 0
        ? 'trigger this bar'
        : `trigger ${r.newestSignalAgeBars} bar lalu`
    );
  } else {
    parts.push('tanpa trigger segar');
  }
  if (r.liquidityFactor < 0.65) parts.push('volume tipis');
  if (r.capTier === 'micro') parts.push('micro cap');
  return parts.join(', ');
}

/** Which signals this tick actually sent, and which the 24h dedup held back. */
interface SendInfo {
  pushed: Set<string>;
  deduped: Set<string>;
}

/** Kirim Telegram hanya untuk sinyal confident yang belum pernah dikirim. */
async function sendConfidentSignals(
  supabase: Supa,
  rankings: MultiTimeframeResult[],
  regime: RegimeResult,
  indexSymbol: string
): Promise<SendInfo> {
  const info: SendInfo = { pushed: new Set(), deduped: new Set() };
  const { configured } = telegramEnv();
  if (!configured) return info;

  const alreadySent = await getAlreadySentKeys(supabase);

  for (const type of SIGNAL_TYPES) {
    const dup = (asset: string) => alreadySent.has(`${type}:${asset}`);
    const confidentAll = rankings
      .filter((r) => r.finalSignal === type && isConfidentSignal(r, regime?.regime))
      .sort((a, b) => b.confluenceScore - a.confluenceScore)
      .slice(0, 10);
    const confident = confidentAll.filter((r) => !dup(r.asset));
    for (const r of confidentAll) {
      if (dup(r.asset)) info.deduped.add(`${type}:${r.asset}`);
    }

    if (confident.length === 0) continue;

    const lines: string[] = [
      `Regime: ${regime.regime.replace(/_/g, ' ').toUpperCase()} | Index: ${bare(indexSymbol)} | TF: 4h`,
      '',
    ];
    for (const r of confident) {
      lines.push(
        `• ${bare(r.asset)} — ${signalLabel(type)} | Conf ${r.confluenceScore} | Agr ${Math.round(
          r.agreement * 100
        )}% | Konv ${Math.round(r.conviction * 100)}%`
      );
      lines.push(`  Alasan: ${signalReason(r)}`);
      lines.push('');
    }

    const body = lines.join('\n').trimEnd();
    const framed = tgFrame(signalLabel(type), body, { footer: TG_FOOTER });
    const sent = await sendTelegramMessage(framed);

    // One update per class instead of per signal — same predicate, ~40x fewer
    // round-trips, and this still runs inside the 60s route budget.
    await supabase
      .from('top_signals')
      .update({ sent_to_telegram: true })
      .in('asset', confident.map((r) => r.asset))
      .eq('signal_type', type)
      .eq('sent_to_telegram', false)
      .then(() => undefined, () => undefined);

    if (sent.ok) {
      for (const r of confident) info.pushed.add(`${type}:${r.asset}`);
    } else {
      console.error(`[telegram] ${type}: ${sent.error}`);
    }
  }

  return info;
}

const DEFAULT_MAX_CHUNKS = 1;

function authorized(req: NextApiRequest): boolean {
  const secret = process.env.SCAN_CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ') && header.slice(7) === secret) return true;
  // Vercel Cron sends its own header; accept it only when a secret is set.
  return req.headers['x-vercel-cron'] != null && secret.length > 0;
}

function stateId(indexSymbol: string, depth: string): string {
  return `${indexSymbol}:${depth}`;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET,POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!authorized(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!isSupabaseConfigured()) {
    return res.status(200).json({ ok: false, reason: 'supabase not configured' });
  }
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(200).json({ ok: false, reason: 'supabase client unavailable' });
  }

  // Health gate: kerusakan lapisan data terbukti senyap (Gate 400 total,
  // candle bertanggal 1970, key ditolak) sementara sweep melapor ok:true.
  // Sekali per tick, ~1 detik; kalau sumber basi, hasilnya dilabeli.
  const health = await checkDataSources();
  const degraded = !health.ok;
  if (degraded) {
    console.error(`[health] sumber data bermasalah — sweep berjalan DEGRADED: ${JSON.stringify(health)}`);
  }

  const body: Body = { ...(req.query as Body), ...(req.body as Body) };  const indexSymbol = (body.indexSymbol || 'BTCUSDT').toUpperCase();
  const depth = body.depth || 'all';
  const universeMode = body.universe === 'all' ? 'all' : 'curated';
  const budgetMs = Math.min(Math.max(body.budgetMs ?? DEFAULT_BUDGET_MS, 5_000), 50_000);
  const maxChunks = Math.min(Math.max(body.maxChunks ?? DEFAULT_MAX_CHUNKS, 1), 5);
  const id = stateId(indexSymbol, depth);
  // Escape hatch for the first run while wiring things up.
  const notifyDisabled = body.notify === false;
  let gateStats: { confident: number; nonNeutral: number } | null = null;
  let sweepTotal: number | undefined;
  let pushResult: PushResult | null = null;

  try {
    // Load or create the cursor for this target.
    const { data: existing, error: loadErr } = await supabase
      .from('scan_cron_state')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (loadErr) return res.status(500).json({ error: `load state: ${loadErr.message}` });

    let state = existing as Record<string, unknown> | null;
    const nowIso = new Date().toISOString();

    if (!state) {
      const { data: created, error: createErr } = await supabase
        .from('scan_cron_state')
        .insert({
          id,
          index_symbol: indexSymbol,
          depth,
          universe: universeMode,
          order_by: 'cap',
          sweep_id: randomUUID(),
          status: 'idle',
          next_offset: 0,
          done_ranges: '',
        })
        .select('*')
        .single();
      if (createErr) return res.status(500).json({ error: `create state: ${createErr.message}` });
      state = created as Record<string, unknown>;
    }

    // A finished sweep resets on the next tick so the schedule keeps producing
    // fresh scans instead of short-circuiting on `done`.
    let status = String(state.status);
    if (status === 'done') {
      const { data: reset, error: resetErr } = await supabase
        .from('scan_cron_state')
        .update({
          sweep_id: randomUUID(),
          status: 'idle',
          next_offset: 0,
          done_ranges: '',
          started_at: nowIso,
          completed_at: null,
          error: null,
          ticks: 0,
        })
        .eq('id', id)
        .select('*')
        .single();
      if (resetErr) return res.status(500).json({ error: `reset state: ${resetErr.message}` });
      state = reset as Record<string, unknown>;
    }

    // Klaim atomik atas target ini: guard concurrency GitHub Actions tidak
    // melindungi dari tick lokal/eksternal — dua run yang membaca kursor yang
    // sama majukan posisi yang sama dan mendorong pesan dobel. Update bersyarat
    // gagal (0 baris) berarti tick lain sedang memegangnya. Tick yang mati di
    // tengah jalan otomatis lepas lewat batas usang 10 menit.
    const staleIso = new Date(Date.now() - 10 * 60_000).toISOString();
    const claim = await supabase
      .from('scan_cron_state')
      .update({ status: 'running', last_tick_at: nowIso })
      .eq('id', id)
      .or(`status.neq.running,last_tick_at.lt.${staleIso}`)
      .select('id');
    if (claim.error) return res.status(500).json({ error: `claim: ${claim.error.message}` });
    if (!claim.data || claim.data.length === 0) {
      return res.status(409).json({ ok: false, reason: 'tick lain sedang memegang target ini' });
    }

    let sweepId = String(state.sweep_id);
    let nextOffset = Number(state.next_offset) || 0;
    let doneRanges = String(state.done_ranges || '');
    let universeId = (state.universe_id as string | null) ?? undefined;
    let scanned = Number(state.scanned_count) || 0;
    let failed = Number(state.failed_count) || 0;
    let regime = (state.regime as RegimeResult | null) ?? null;
    let params = (state.autonomous_params as AutonomousParams | null) ?? null;
    let sources = (state.sources as Record<string, number> | null) ?? null;

    let chunks = 0;
    let done = false;
    // Re-base BEFORE scanning when the stored composition no longer matches.
    // The curated id re-hashes whenever market-cap or 24h volume ordering moves,
    // and discovering that only after a full chunk burns the whole budget twice
    // (504), while doing it every tick leaves the sweep stuck at offset 0.
    let resets = 0;
    if (universeId && universeMode === 'curated') {
      try {
        const { buildCuratedUniverse } = await import('../../lib/curatedUniverse');
        const current = await buildCuratedUniverse();
        if (current.id !== universeId) {
          await supabase.from('scan_cron_rows').delete().eq('sweep_id', sweepId);
          universeId = current.id;
          sweepId = randomUUID();
          nextOffset = 0;
          doneRanges = '';
          scanned = 0;
          failed = 0;
          resets = 1;
        }
      } catch {
        // Composition unavailable — the in-loop guard below still bounds restarts.
      }
    }

    while (chunks < maxChunks && !done) {
      const skip = parseRanges(doneRanges);
      const chunk = await runAutonomousChunk({
        indexSymbol,
        depth,
        universeMode,
        offset: nextOffset,
        span: 2000,
        budgetMs,
        skipPositions: skip,
        universeId,
      });

      // Universe membership or ordering changed mid-sweep → the positional
      // cursor is meaningless against the new ordering. Restart cleanly.
      const changed = chunk.universeId !== (universeId ?? chunk.universeId);
      if (universeId && changed) {
        await supabase.from('scan_cron_rows').delete().eq('sweep_id', sweepId);
        universeId = chunk.universeId;
        sweepId = randomUUID();
        nextOffset = 0;
        doneRanges = '';
        scanned = 0;
        failed = 0;
        if (++resets > 1) break;
        continue;
      }

      universeId = chunk.universeId;
      regime = chunk.regime;
      params = chunk.autonomousParams;
      sources = chunk.sources;

      // Persist this chunk's rows (upsert by sweep_id+asset).
      if (chunk.rankings.length > 0) {
        const rows = chunk.rankings.map((r: MultiTimeframeResult) => ({
          sweep_id: sweepId,
          asset: r.asset,
          result: r,
        }));
        const { error: rowsErr } = await supabase
          .from('scan_cron_rows')
          .upsert(rows, { onConflict: 'sweep_id,asset' });
        if (rowsErr) return res.status(500).json({ error: `persist rows: ${rowsErr.message}` });
        scanned += chunk.rankings.length;
      }

      // Advance the cursor: the chunk covers [nextOffset, nextOffset+span).
      // Positions completed (result or permanently failed) are added to done.
      const covered = Math.min(nextOffset + 2000, chunk.total);
      for (let p = nextOffset; p < covered; p++) {
        if (chunk.positions.includes(p) || (chunk.failedPositions ?? []).includes(p)) {
          skip.add(p);
        }
      }
      doneRanges = buildRanges(skip);
      nextOffset = chunk.progress.nextOffset;
      failed += (chunk.failedPositions ?? []).length;
      done = chunk.progress.done;
      if (Number.isFinite(chunk.total)) sweepTotal = chunk.total;
      chunks++;
    }

    const total = state.total ?? sweepTotal;

    // Assemble and persist the final scan when the sweep completes.
    if (done) {
      const { data: rows, error: readErr } = await supabase
        .from('scan_cron_rows')
        .select('result')
        .eq('sweep_id', sweepId);
      if (readErr) return res.status(500).json({ error: `read final rows: ${readErr.message}` });

      const rankings = (rows ?? [])
        .map((r) => (r.result as unknown as MultiTimeframeResult))
        .sort((a, b) => b.confluenceScore - a.confluenceScore);

      if (rankings.length > 0 && regime && params) {
        const summaries = buildSummaries(rankings);
        const { error: saveErr } = await supabase.from('scan_history').insert({
          scan_type: 'crypto',
          mode: 'autonomous',
          index_symbol: indexSymbol,
          interval: '4h',
          market_regime: regime,
          autonomous_params: params,
          results: rankings,
          total_scanned: rankings.length,
          signals_count: rankings.filter((r) => r.finalSignal !== 'neutral').length,
          buy_signals_summary: summaries.buys,
          sell_signals_summary: summaries.sells,
          regime_label: regime.regime,
          created_at: nowIso,
        });
        if (saveErr) {
          return res.status(500).json({ error: `save scan_history: ${saveErr.message}` });
        }
        // Drop staged rows for this completed sweep.
        await supabase.from('scan_cron_rows').delete().eq('sweep_id', sweepId);

        // Autonomous Telegram push. This is the only place a completed server
        // sweep reaches the phone — the browser path is user-initiated, so a
        // cron sweep used to end silently.
        if (!notifyDisabled) {
          pushResult = await pushCompletedScan({
            supabase,
            rankings,
            regime,
            indexSymbol,
            depth,
            sweepId,
            degraded,
          });
        }

        // --- Top signals: simpan top 10 per kelas + kirim Telegram yang confident ---
        try {
          await persistTopSignals(supabase, rankings);
          const sendInfo = await sendConfidentSignals(supabase, rankings, regime, indexSymbol);
          gateStats = {
            confident: rankings.filter((r) => isConfidentSignal(r, regime?.regime)).length,
            nonNeutral: rankings.filter((r) => r.finalSignal !== 'neutral').length,
          };
          console.log(
            `[gate] confident ${gateStats.confident} / non-netral ${gateStats.nonNeutral} / universe ${rankings.length} (regime ${regime.regime})`
          );

          // Signal ledger: record every confident signal at emit. Deliberately
          // outside sendConfidentSignals() — recording must not depend on
          // Telegram being configured. `pushed` comes from the send result.
          //
          // Writes use the service-role client: the anon key is public, and a
          // publicly writable track record is not a track record.
          const ledgerWriter = await ensureSupabaseAdmin();
          if (ledgerWriter) {
            await recordSignals(ledgerWriter, {
              signals: rankings.filter((r) => isConfidentSignal(r, regime?.regime)),
              indexSymbol,
              regime: regime.regime,
              pushed: sendInfo.pushed,
              deduped: sendInfo.deduped,
            });
          } else {
            console.error('[ledger] record disabled: service-role tidak tersedia (key ditolak atau belum diset)');
          }
        } catch (err) {
          console.error('[top-signals] failed:', err instanceof Error ? err.message : err);
        }
      }
    }

    // Signal ledger scoring: two bounded batches per tick, whether or not this
    // tick completed a sweep. Alpha and R are independent; neither ever touches
    // a value that is already filled.
    const ledgerScorer = await ensureSupabaseAdmin();
    if (!ledgerScorer) {
      console.error('[ledger] scoring disabled: service-role tidak tersedia (key ditolak atau belum diset)');
    } else {
      try {
        await scoreLedger(ledgerScorer);
      } catch (err) {
        console.error('[ledger] score failed:', err instanceof Error ? err.message : err);
      }
      try {
        await scoreLedgerR(ledgerScorer);
      } catch (err) {
        console.error('[ledger] scoreR failed:', err instanceof Error ? err.message : err);
      }
    }

    const { data: final, error: stateErr } = await supabase
      .from('scan_cron_state')
      .update({
        status: done ? 'done' : 'running',
        // Persist the working sweep id. Re-basing changes it locally, and if it
        // never lands here the next tick (and this tick's own finalize) reads a
        // different id from scan_cron_rows — rankings come back empty and the
        // save + Telegram push are skipped silently.
        sweep_id: sweepId,
        universe_id: universeId ?? null,
        next_offset: nextOffset,
        done_ranges: doneRanges,
        total: total ?? null,
        regime: regime as RegimeResult | null,
        autonomous_params: params as AutonomousParams | null,
        sources: sources as Record<string, number> | null,
        scanned_count: scanned,
        failed_count: failed,
        last_tick_at: nowIso,
        completed_at: done ? nowIso : null,
        ticks: (Number(state.ticks) || 0) + 1,
        updated_at: nowIso,
      })
      .eq('id', id)
      .select('*')
      .single();
    if (stateErr) return res.status(500).json({ error: `update state: ${stateErr.message}` });

    const digest = createHash('sha1').update(sweepId).digest('hex').slice(0, 8);
    return res.status(200).json({
      ok: true,
      done,
      chunks,
      notify: pushResult,
      health,
      gate: gateStats,
      state: final
        ? {
            id,
            sweepId: digest,
            status: final.status,
            nextOffset: final.next_offset,
            total: final.total,
            scanned: final.scanned_count,
            failed: final.failed_count,
            ticks: final.ticks,
            regime: (final.regime as RegimeResult | null)?.regime ?? null,
          }
        : null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    // Record the error for operator visibility, but still 200 so the scheduler
    // does not retry-hammer.
    await supabase
      .from('scan_cron_state')
      .update({ status: 'error', error: msg, updated_at: new Date().toISOString() })
      .eq('id', id)
      .then(() => undefined, () => undefined);
    return res.status(200).json({ ok: false, error: msg });
  }
}
