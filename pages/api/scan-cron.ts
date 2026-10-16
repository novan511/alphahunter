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
import { buildTradeableList, TradeableCoin } from '../../lib/algorithms/tradeable';
import { computeMatrix } from '../../lib/algorithms/correlationMatrix';
import { buildPortfolioPlan, buildRotationDigest } from '../../lib/algorithms/portfolioVerdict';
import { buildEarlyWarnings } from '../../lib/algorithms/earlyWarning';
import { buildSectorHeat } from '../../lib/algorithms/narrativeHeat';
import { fetchPairRatio } from '../../lib/algorithms/pairRatio';
import { fetchKlinesRouted } from '../../lib/universe';
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
  sweepId: string;
}): Promise<PushResult> {
  const { supabase, rankings, regime, indexSymbol } = args;
  const result: PushResult = { attempted: false, sent: 0, failed: 0, errors: [] };

  const { configured } = telegramEnv();
  if (!configured) {
    result.errors.push('telegram not configured');
    return result;
  }
  result.attempted = true;

  const interval = '4h';
  const windowBars = 30;

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
        const sent = await sendTelegramMessage(digest);
        if (sent.ok) result.sent++;
        else { result.failed++; result.errors.push(`rotasi: ${sent.error}`); }
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
      const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' });
      const lines = [
        '📊 ENTRY SIGNAL — ALTHUNTER',
        '━━━━━━━━━━━━━━━━━━━━━━',
        `⏰ ${now} WIB`,
        `📈 Timeframe: ${interval}`,
        `🌍 Regime: ${regime.regime.replace(/_/g, ' ').toUpperCase()}`,
        `✅ ${trades.length} koin lolos gate`,
        '',
      ];
      for (const t of trades.slice(0, 8) as TradeableCoin[]) {
        const dir = t.direction === 'long' ? '🟢 LONG' : '🔴 SHORT';
        lines.push(`• ${t.ticker} ${dir}`);
        lines.push(`  Conf: ${t.confluenceScore} | Risiko: ${t.riskTier} | Maks: ${t.riskBudgetPct}% ekuitas`);
      }
      lines.push('');
      lines.push('⚠️ Risk per trade maks 1% ekuitas. Stop wajib sebelum entry.');
      const sent = await sendTelegramMessage(lines.join('\n').slice(0, 3900));
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
    if (warnings.length > 0) {
      const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' });
      const lines = [
        '🔥 SEKTOR BERGERAK — ALTHUNTER',
        '━━━━━━━━━━━━━━━━━━━━━━',
        `⏰ ${now} WIB`,
        '',
      ];
      for (const w of warnings.slice(0, 5)) {
        lines.push(`${w.sectorIcon} ${w.title}`);
        lines.push(`  ${w.detail}`);
        if (w.coins.length > 0) {
          lines.push(`  Koin: ${w.coins.slice(0, 5).map((c) => `${c.ticker} (${c.confluenceScore})`).join(', ')}`);
        }
        lines.push('');
      }
      const sent = await sendTelegramMessage(lines.join('\n').slice(0, 3900));
      if (sent.ok) result.sent++;
      else { result.failed++; result.errors.push(`sektor: ${sent.error}`); }
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

/**
 * Confidence gate agar tidak kirim fakeout.
 * Strong sinyal butuh agreement & conviction lebih tinggi dari sinyal biasa.
 */
function isConfidentSignal(r: MultiTimeframeResult): boolean {
  if (r.finalSignal === 'strong_buy' || r.finalSignal === 'strong_sell') {
    return r.confluenceScore >= 72 && r.agreement >= 0.7 && r.conviction >= 0.6;
  }
  if (r.finalSignal === 'buy' || r.finalSignal === 'sell') {
    return r.confluenceScore >= 48 && r.agreement >= 0.5 && r.conviction >= 0.45;
  }
  return false;
}

/** Simpan top 10 per kelas sinyal ke tabel top_signals (Supabase). */
async function persistTopSignals(
  supabase: Supa,
  rankings: MultiTimeframeResult[]
): Promise<void> {
  for (const type of SIGNAL_TYPES) {
    const top10 = rankings
      .filter((r) => r.finalSignal === type)
      .sort((a, b) => b.confluenceScore - a.confluenceScore)
      .slice(0, 10);

    for (const r of top10) {
      await supabase
        .from('top_signals')
        .insert({
          signal_type: type,
          asset: r.asset,
          confluence_score: r.confluenceScore,
          conviction: r.conviction ?? null,
          agreement: r.agreement ?? null,
          timeframe: '4h',
          sent_to_telegram: false,
        })
        .then(() => undefined, () => undefined); // jangan gagalkan scan saat insert gagal
    }
  }
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

/** Kirim Telegram hanya untuk sinyal confident yang belum pernah dikirim. */
async function sendConfidentSignals(
  supabase: Supa,
  rankings: MultiTimeframeResult[],
  regime: RegimeResult,
  indexSymbol: string
): Promise<void> {
  const { configured } = telegramEnv();
  if (!configured) return;

  const alreadySent = await getAlreadySentKeys(supabase);
  const now = new Date().toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
  });

  for (const type of SIGNAL_TYPES) {
    const confident = rankings
      .filter((r) => r.finalSignal === type && isConfidentSignal(r))
      .sort((a, b) => b.confluenceScore - a.confluenceScore)
      .slice(0, 10)
      .filter((r) => !alreadySent.has(`${type}:${r.asset}`));

    if (confident.length === 0) continue;

    const label =
      type === 'strong_buy'
        ? '🚀 STRONG BUY'
        : type === 'buy'
        ? '📈 BUY'
        : type === 'strong_sell'
        ? '🔻 STRONG SELL'
        : '📉 SELL';

    const lines: string[] = [
      `${label} — ALTHUNTER`,
      '━━━━━━━━━━━━━━━━━━━━━━',
      `⏰ ${now} WIB`,
      `📈 TF: 4h | Index: ${indexSymbol} | Regime: ${regime.regime.replace(/_/g, ' ').toUpperCase()}`,
      `🎯 ${confident.length} koin lolos confidence gate`,
      '',
    ];

    for (const r of confident) {
      lines.push(
        `• ${r.asset} — Conf: ${r.confluenceScore} | Agr: ${Math.round(
          r.agreement * 100
        )}% | Konv: ${Math.round(r.conviction * 100)}%`
      );
    }

    lines.push('');
    lines.push('⚠️ Konfirmasi sendiri sebelum entry. Stop loss wajib.');

    const sent = await sendTelegramMessage(lines.join('\n').slice(0, 3900));

    // Tandai sudah dikirim agar tidak duplikat di scan berikutnya.
    for (const r of confident) {
      await supabase
        .from('top_signals')
        .update({ sent_to_telegram: true })
        .eq('asset', r.asset)
        .eq('signal_type', type)
        .eq('sent_to_telegram', false)
        .then(() => undefined, () => undefined);
    }

    if (!sent.ok) {
      console.error(`[telegram] ${type}: ${sent.error}`);
    }
  }
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

  const body: Body = { ...(req.query as Body), ...(req.body as Body) };  const indexSymbol = (body.indexSymbol || 'BTCUSDT').toUpperCase();
  const depth = body.depth || 'all';
  const universeMode = body.universe === 'all' ? 'all' : 'curated';
  const budgetMs = Math.min(Math.max(body.budgetMs ?? DEFAULT_BUDGET_MS, 5_000), 50_000);
  const maxChunks = Math.min(Math.max(body.maxChunks ?? DEFAULT_MAX_CHUNKS, 1), 5);
  const id = stateId(indexSymbol, depth);
  // Escape hatch for the first run while wiring things up.
  const notifyDisabled = body.notify === false;
  let pushResult: PushResult | null = null;
  const _t0 = Date.now();
  // DIAGNOSTIC: persist phase timings so they survive the 60s kill.
  const mark = async (label: string) => {
    const ms = Date.now() - _t0;
    console.log(`[timing] ${label} +${ms}ms`);
    await supabase
      .from('scan_cron_state')
      .update({ error: `timing ${label} +${ms}ms`, updated_at: new Date().toISOString() })
      .eq('id', id)
      .then(() => undefined, () => undefined);
  };

  try {
    // Load or create the cursor for this target.
    const { data: existing, error: loadErr } = await supabase
      .from('scan_cron_state')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (loadErr) return res.status(500).json({ error: `load state: ${loadErr.message}` });
    await mark('state loaded');

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
      await mark('chunk fetched');

      // Universe membership or ordering changed mid-sweep → the positional
      // cursor is meaningless against the new ordering. Restart cleanly.
      const changed = chunk.universeId !== (universeId ?? chunk.universeId);
      if (universeId && changed) {
        sweepId = randomUUID();
        nextOffset = 0;
        doneRanges = '';
        scanned = 0;
        failed = 0;
        await supabase.from('scan_cron_rows').delete().eq('sweep_id', sweepId);
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
        await mark('rows upserted');
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
      chunks++;
    }

    const total = state.total ?? undefined;
    await mark('chunk loop done');

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
            sweepId,
          });
        }

        // --- Top signals: simpan top 10 per kelas + kirim Telegram yang confident ---
        try {
          await persistTopSignals(supabase, rankings);
          await sendConfidentSignals(supabase, rankings, regime, indexSymbol);
        } catch (err) {
          console.error('[top-signals] failed:', err instanceof Error ? err.message : err);
        }
      }
    }

    const { data: final, error: stateErr } = await supabase
      .from('scan_cron_state')
      .update({
        status: done ? 'done' : 'running',
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
    await mark('finalize done');
    return res.status(200).json({
      ok: true,
      done,
      chunks,
      notify: pushResult,
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
