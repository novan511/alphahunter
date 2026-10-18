/**
 * Signal ledger: write-once record of confident signals and their later scores.
 *
 * The rules live in the database (migration 012): fact columns are immutable
 * and each horizon is filled exactly once. This module is only the writer and
 * reader, and everything it does has to respect those rules:
 *
 *   recordSignals()  insert at emit (deduped by asset+direction+day, so a
 *                    re-emit the same day is a no-op).
 *   scoreLedger()    fill any horizon that is due and still null, from the
 *                    candle nearest the target time. Never touches a filled
 *                    horizon, so running it twice changes nothing.
 *   readLedger()     recent rows plus read-time aggregates.
 *
 * Alpha is measured against the benchmark stored on the row, signed by
 * direction: this engine is relative strength, so absolute return would flatter
 * every long in a rising market.
 */

import { getSupabase } from './supabase';
import { fetchKlinesRouted } from './universe';
import { analyzeStructure } from './algorithms/marketStructure';
import { bucketStats, type BucketStats, type CalibrationRow } from './calibration';
import {
  firstTouch,
  levelsFor,
  FOUR_H_BAR_SEC,
  MAX_HOLD_SEC,
  LEVEL_CONVENTION,
  type TouchResult,
} from './signalLevels';
import type { Candle } from './types';
import type { MultiTimeframeResult } from './algorithms/multiTimeframe';

type Supa = NonNullable<ReturnType<typeof getSupabase>>;

/** Fixed emission-relative horizons. Each is scored independently. */
const HORIZONS = [
  { key: '1d', hours: 24 },
  { key: '3d', hours: 72 },
  { key: '7d', hours: 168 },
] as const;
export type HorizonKey = (typeof HORIZONS)[number]['key'];

/**
 * A target is only scored from a candle within this window of the exact due
 * time. Both sides are seconds: candle timestamps are seconds, so a
 * millisecond tolerance would simply never match a candle.
 */
export const SCORE_TOLERANCE_SEC = 6 * 3_600;

/** Scoring candles: same series as the emit snapshot, over a window long enough for 7d. */
const SCORE_INTERVAL = '4h';
const SCORE_BARS = 60;

/** Rows scored per tick, so a late backlog never blows the route budget. */
export const SCORE_BATCH = 5;

export interface LedgerRow {
  id: number;
  emitted_at: string;
  asset: string;
  direction: 'long' | 'short';
  index_symbol: string;
  benchmark_symbol: string;
  benchmark_price: number | null;
  price: number | null;
  price_at: string | null;
  price_tf: string | null;
  signal: string;
  confluence_score: number | null;
  conviction: number | null;
  agreement: number | null;
  regime: string | null;
  pushed: boolean;
  deduped: boolean;
  ret_1d: number | null;
  scored_1d_at: string | null;
  ret_3d: number | null;
  scored_3d_at: string | null;
  ret_7d: number | null;
  scored_7d_at: string | null;
  /** Structure/pattern read at emit time, per timeframe. Immutable. */
  context: Record<string, unknown> | null;
  /** ATR(14) of the emit series, snapshotted so R never depends on a later read. */
  atr: number | null;
  /** Levels placed at emit under `level_convention`. Immutable. */
  stop: number | null;
  target: number | null;
  level_convention: string | null;
  /** Realised R-multiple: filled exactly once, with `outcome`. */
  r: number | null;
  outcome: string | null;
  scored_r_at: string | null;
  created_at: string;
}

export interface HorizonStats {
  /** Rows with a filled value at this horizon. Always shown next to the stats. */
  n: number;
  winRate: number | null;
  avgAlpha: number | null;
}

export interface LedgerStats {
  n: number;
  horizons: Record<HorizonKey, HorizonStats>;
}

export interface LedgerView {
  rows: LedgerRow[];
  /** All confident signals. */
  all: LedgerStats;
  /** Only the signals actually pushed to Telegram. */
  pushed: LedgerStats;
  /**
   * Per-setup R calibration. The headline view is `buckets` (pushed only — what
   * a user could actually have acted on); `bucketsAll` is the wider record and
   * the two are never mixed.
   */
  buckets: BucketStats[];
  bucketsAll: BucketStats[];
}

/* ------------------------------------------------------------------ */
/* Pure helpers (self-checked in scripts/smoke-ledger.ts)              */
/* ------------------------------------------------------------------ */

/**
 * Candle whose timestamp is nearest `targetSec`, or null beyond the tolerance.
 * Candle times and `targetSec` are both in seconds.
 */
export function nearestCandle(
  candles: Candle[],
  targetSec: number,
  tolSec: number = SCORE_TOLERANCE_SEC
): Candle | null {
  let best: Candle | null = null;
  let bestDist = Infinity;
  for (const c of candles) {
    const d = Math.abs(c.time - targetSec);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best && bestDist <= tolSec ? best : null;
}

/**
 * Signed alpha: asset return minus benchmark return, flipped for a short.
 * Null when either base is unusable.
 */
export function alphaOf(
  direction: 'long' | 'short',
  base: number,
  target: number,
  benchBase: number,
  benchTarget: number
): number | null {
  if (!(base > 0) || !(benchBase > 0)) return null;
  if (!Number.isFinite(target) || !Number.isFinite(benchTarget)) return null;
  const alpha = target / base - benchTarget / benchBase;
  return direction === 'short' ? -alpha : alpha;
}

/* ------------------------------------------------------------------ */
/* Recording                                                           */
/* ------------------------------------------------------------------ */

/** Live last close of a symbol (4h, then 1h, then 1d). Null if unavailable. */
async function snapshotClose(symbol: string): Promise<{ price: number; tf: string } | null> {
  for (const tf of ['4h', '1h', '1d']) {
    try {
      const candles = await fetchKlinesRouted(symbol, tf, 2);
      const last = candles[candles.length - 1];
      if (last && Number.isFinite(last.close) && last.close > 0) {
        return { price: last.close, tf };
      }
    } catch {
      // try the next timeframe
    }
  }
  return null;
}

/** Structure is fetched for at most this many distinct assets per tick. */
export const MAX_STRUCTURE_TARGETS = 6;

/** Columns added by migration 015, needed to scope the pre-migration fallback. */
const LEVEL_COLUMNS = ['atr', 'stop', 'target', 'level_convention'] as const;

/**
 * Structure read at emit, stored verbatim in `signal_ledger.context`.
 *
 * Captured now on purpose: re-deriving it months later would run different
 * thresholds, and a "what the engine saw" field that changes when the code
 * changes is not a record. Best-effort — a failed fetch stores nothing rather
 * than a guess.
 */
async function snapshotStructure(asset: string): Promise<Record<string, unknown> | null> {
  const out: Record<string, unknown> = {};
  await Promise.all(
    ['4h', '1d'].map(async (tf) => {
      try {
        const s = analyzeStructure(await fetchKlinesRouted(asset, tf, 200));
        if (!s) return;
        out[tf] = {
          price: s.price,
          atr: s.atr,
          bars: s.bars,
          trend: s.trend.label,
          support: s.support?.price ?? null,
          resistance: s.resistance?.price ?? null,
          patterns: s.patterns.map((p) => ({
            name: p.name,
            direction: p.direction,
            confirmed: p.confirmed,
            confidence: p.confidence,
            trigger: p.trigger ?? null,
            stop: p.stop ?? null,
          })),
        };
      } catch {
        // best-effort
      }
    })
  );
  return Object.keys(out).length > 0 ? out : null;
}

export interface RecordSignalsArgs {
  /** Signals that passed the confident gate. */
  signals: MultiTimeframeResult[];
  indexSymbol: string;
  regime: string | null;
  /** `${finalSignal}:${asset}` keys actually sent to Telegram this tick. */
  pushed?: Set<string>;
  /** `${finalSignal}:${asset}` keys held back by the 24h dedup. */
  deduped?: Set<string>;
  now?: number;
}

/**
 * Insert confident signals. The unique index on (asset, direction, emit day)
 * makes a same-day re-emit a no-op, so this is safe to call every tick.
 */
export async function recordSignals(
  supabase: Supa,
  args: RecordSignalsArgs
): Promise<number> {
  const nowMs = args.now ?? Date.now();
  const emittedAt = new Date(nowMs).toISOString();
  // Benchmark snapshot is one call per tick, not per signal.
  const bench = await snapshotClose(args.indexSymbol);

  const picked = args.signals
    // `neutral` should never reach here (isConfidentSignal rejects it), but a
    // mislabelled direction would be permanent — rows are immutable.
    .filter((r) => r.finalSignal !== 'neutral')
    .filter((r) => Number.isFinite(r.price) && (r.price as number) > 0);

  if (picked.length === 0) return 0;

  const contexts = new Map<string, unknown>();
  const assets = Array.from(new Set(picked.map((r) => r.asset))).slice(0, MAX_STRUCTURE_TARGETS);
  await Promise.all(
    assets.map(async (asset) => {
      const s = await snapshotStructure(asset);
      if (s) contexts.set(asset, s);
    })
  );

  const rows = picked.map((r) => {
    const key = `${r.finalSignal}:${r.asset}`;
    const direction = r.finalSignal.includes('sell') ? 'short' : 'long';
    // Levels are placed here, at emit, from the snapshot ATR — never afterwards.
    const levels = levelsFor(direction, r.price, r.atr);
    return {
      emitted_at: emittedAt,
      asset: r.asset,
      direction,
      index_symbol: args.indexSymbol,
      benchmark_symbol: args.indexSymbol,
      benchmark_price: bench?.price ?? null,
      price: r.price,
      price_at: emittedAt,
      price_tf: r.priceTf ?? null,
      signal: r.finalSignal,
      confluence_score: r.confluenceScore,
      conviction: r.conviction ?? null,
      agreement: r.agreement ?? null,
      regime: args.regime,
      pushed: args.pushed?.has(key) ?? false,
      deduped: args.deduped?.has(key) ?? false,
      context: contexts.get(r.asset) ?? null,
      atr: r.atr ?? null,
      stop: levels?.stop ?? null,
      target: levels?.target ?? null,
      level_convention: levels?.convention ?? null,
    };
  });

  // ignoreDuplicates maps to ON CONFLICT DO NOTHING: the first emit of the day wins.
  const onConflict = 'asset,direction,emit_day';
  const { error } = await supabase
    .from('signal_ledger')
    .upsert(rows, { onConflict, ignoreDuplicates: true });
  if (!error) return rows.length;

  // Migration 015 may not have run yet (its columns do not exist). A row without
  // levels can never be calibrated, but a row never written can never be
  // recovered — so drop the level columns and record the signal anyway.
  const missingColumn =
    error.message.includes('column') && LEVEL_COLUMNS.some((c) => error.message.includes(c));
  if (!missingColumn) throw new Error(`recordSignals: ${error.message}`);

  const withoutLevels = rows.map((row) => {
    const copy: Record<string, unknown> = { ...row };
    for (const c of LEVEL_COLUMNS) delete copy[c];
    return copy;
  });
  const { error: retryErr } = await supabase
    .from('signal_ledger')
    .upsert(withoutLevels, { onConflict, ignoreDuplicates: true });
  if (retryErr) throw new Error(`recordSignals: ${retryErr.message}`);
  return rows.length;
}

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

function retOf(row: StatRow, key: HorizonKey): number | null {
  if (key === '1d') return row.ret_1d;
  if (key === '3d') return row.ret_3d;
  return row.ret_7d;
}

export interface ScoreLedgerOptions {
  max?: number;
  now?: number;
}

/** One candle series per symbol per run, shared by both scorers. */
function candleLoader(): (symbol: string) => Promise<Candle[]> {
  const cache = new Map<string, Candle[]>();
  return async (symbol: string) => {
    const cached = cache.get(symbol);
    if (cached) return cached;
    const candles = await fetchKlinesRouted(symbol, SCORE_INTERVAL, SCORE_BARS).catch(() => []);
    cache.set(symbol, candles);
    return candles;
  };
}

/**
 * Score due horizons. Only rows whose horizon has passed and is still null are
 * considered; a filled horizon is never read back, so a second run is a no-op.
 */
export async function scoreLedger(
  supabase: Supa,
  opts: ScoreLedgerOptions = {}
): Promise<{ scored: number; candidates: number }> {
  const nowMs = opts.now ?? Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const max = Math.max(opts.max ?? SCORE_BATCH, 1);
  const oldest = new Date(nowMs - HORIZONS[0].hours * 3_600_000).toISOString();

  const { data, error } = await supabase
    .from('signal_ledger')
    .select('*')
    .not('price', 'is', null)
    .not('benchmark_price', 'is', null)
    .lte('emitted_at', oldest)
    .or('ret_1d.is.null,ret_3d.is.null,ret_7d.is.null')
    .order('emitted_at', { ascending: true })
    .limit(max * 4);
  if (error) throw new Error(`scoreLedger read: ${error.message}`);

  const candidates = (data ?? []) as LedgerRow[];
  const load = candleLoader();

  let scored = 0;
  for (const row of candidates) {
    if (scored >= max) break;

    const emittedSec = Math.floor(Date.parse(row.emitted_at) / 1000);
    const base = row.price;
    const benchBase = row.benchmark_price;
    if (!Number.isFinite(emittedSec) || base == null || benchBase == null) continue;
    if (!(base > 0) || !(benchBase > 0)) continue;

    const due = HORIZONS.filter((h) => emittedSec + h.hours * 3_600 <= nowSec);
    if (due.length === 0) continue;

    const assetCandles = await load(row.asset);
    if (assetCandles.length === 0) continue;
    const benchCandles =
      row.benchmark_symbol === row.asset ? assetCandles : await load(row.benchmark_symbol);
    if (benchCandles.length === 0) continue;

    const patch: Record<string, number | string> = {};
    for (const h of due) {
      if (retOf(row, h.key) != null) continue; // already filled — never overwrite
      const targetSec = emittedSec + h.hours * 3_600;
      const aCandle = nearestCandle(assetCandles, targetSec);
      const bCandle = nearestCandle(benchCandles, targetSec);
      if (!aCandle || !bCandle) continue;
      const alpha = alphaOf(row.direction, base, aCandle.close, benchBase, bCandle.close);
      if (alpha == null) continue;
      patch[`ret_${h.key}`] = Math.round(alpha * 1e6) / 1e6;
      patch[`scored_${h.key}_at`] = new Date(nowMs).toISOString();
    }

    if (Object.keys(patch).length === 0) continue;

    const { error: upErr } = await supabase
      .from('signal_ledger')
      .update(patch)
      .eq('id', row.id);
    if (upErr) {
      console.warn(`[ledger] score ${row.id}: ${upErr.message}`);
      continue;
    }
    scored++;
  }

  return { scored, candidates: candidates.length };
}

/** R outcomes decided per tick. Independent of the alpha batch. */
export const SCORE_R_BATCH = 8;

/**
 * Fill the first-touch outcome for rows that carry levels and have no outcome.
 *
 * Idempotent by `outcome`, not by time: an undecided row stays a candidate, so
 * a tick that finds nothing touched leaves it for the next one. A row whose
 * candle path is gone is marked `lost`, which is terminal — otherwise it would
 * be retried forever and could still be scored from a partial path later.
 */
export async function scoreLedgerR(
  supabase: Supa,
  opts: ScoreLedgerOptions = {}
): Promise<{ scored: number; candidates: number }> {
  const nowMs = opts.now ?? Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const max = Math.max(opts.max ?? SCORE_R_BATCH, 1);

  const { data, error } = await supabase
    .from('signal_ledger')
    .select('*')
    .is('outcome', null)
    .not('stop', 'is', null)
    .not('target', 'is', null)
    .order('emitted_at', { ascending: true })
    .limit(max * 4);
  if (error) throw new Error(`scoreLedgerR read: ${error.message}`);

  const candidates = (data ?? []) as LedgerRow[];
  const load = candleLoader();

  let scored = 0;
  for (const row of candidates) {
    if (scored >= max) break;

    const emittedSec = Math.floor(Date.parse(row.emitted_at) / 1000);
    const entry = row.price;
    if (!Number.isFinite(emittedSec) || entry == null || !(entry > 0)) continue;
    if (row.stop == null || row.target == null) continue;

    const candles = await load(row.asset);
    let res: TouchResult | null;
    if (candles.length === 0) {
      // No data at all for this symbol (delisted, or every source down).
      // Retiring the row once its hold window would have expired keeps a dead
      // symbol from occupying the batch forever; before that the failure may
      // simply be transient, so the row is left for the next tick.
      res =
        nowSec >= emittedSec + MAX_HOLD_SEC
          ? { outcome: 'lost', r: null, bars: 0 }
          : null;
    } else {
      res = firstTouch(candles, row.direction, entry, row.stop, row.target, emittedSec, {
        nowSec,
        holdSec: MAX_HOLD_SEC,
        barSec: FOUR_H_BAR_SEC,
      });
    }
    if (!res) continue; // undecided: try again next tick

    const { error: upErr } = await supabase
      .from('signal_ledger')
      .update({
        outcome: res.outcome,
        r: res.r == null ? null : Math.round(res.r * 1e4) / 1e4,
        scored_r_at: new Date(nowMs).toISOString(),
      })
      .eq('id', row.id);
    if (upErr) {
      console.warn(`[ledger] scoreR ${row.id}: ${upErr.message}`);
      continue;
    }
    scored++;
  }

  return { scored, candidates: candidates.length };
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

/** The fields the aggregates read. Rows are only ever read, never recomputed. */
type StatRow = Pick<
  LedgerRow,
  'ret_1d' | 'ret_3d' | 'ret_7d' | 'pushed' | 'signal' | 'r' | 'outcome' | 'level_convention'
>;

/**
 * Only rows placed under the risk convention the code uses today. Pooling two
 * conventions into one bucket would blend two different stop distances into a
 * single win rate, which is exactly what the versioned column exists to prevent.
 */
const currentConvention = (r: StatRow) => r.level_convention === LEVEL_CONVENTION;

function statsFor(rows: StatRow[]): LedgerStats {
  const horizons = {} as Record<HorizonKey, HorizonStats>;
  for (const h of HORIZONS) {
    const values = rows
      .map((r) => retOf(r, h.key))
      .filter((v): v is number => v != null);
    horizons[h.key] = {
      n: values.length,
      winRate: values.length > 0 ? values.filter((v) => v > 0).length / values.length : null,
      avgAlpha: values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null,
    };
  }
  return { n: rows.length, horizons };
}

/** Zeroed aggregates, for the empty / not-configured view. */
export function emptyStats(): LedgerStats {
  return statsFor([]);
}

/** Page through the lean stat columns until the table is exhausted. */
const STAT_PAGE = 1000;
const STAT_MAX_PAGES = 50; // 50k rows; far beyond what a young ledger holds

async function readStatRows(supabase: Supa): Promise<StatRow[]> {
  const all: StatRow[] = [];
  for (let page = 0; page < STAT_MAX_PAGES; page++) {
    const from = page * STAT_PAGE;
    const { data, error } = await supabase
      .from('signal_ledger')
      .select('ret_1d,ret_3d,ret_7d,pushed,signal,r,outcome,level_convention')
      .order('id', { ascending: true })
      .range(from, from + STAT_PAGE - 1);
    if (error) throw new Error(`readLedger stats: ${error.message}`);
    const batch = (data ?? []) as StatRow[];
    all.push(...batch);
    if (batch.length < STAT_PAGE) break;
  }
  return all;
}

/**
 * Recent rows plus aggregates over the whole table, computed here so there is
 * no stats table to keep in sync. Every aggregate carries the sample size that
 * produced it.
 */
export async function readLedger(supabase: Supa, limit = 200): Promise<LedgerView> {
  const bounded = Math.min(Math.max(limit, 1), 1000);
  // Stats need every row, and PostgREST caps a response at the project's max
  // rows (1000 by default). A silent cap would publish a win rate computed over
  // an arbitrary prefix of the table, so the stats read is paged explicitly.
  const [statRows, rowRes] = await Promise.all([
    readStatRows(supabase),
    supabase
      .from('signal_ledger')
      .select('*')
      .order('emitted_at', { ascending: false })
      .limit(bounded),
  ]);
  if (rowRes.error) throw new Error(`readLedger: ${rowRes.error.message}`);

  return {
    rows: (rowRes.data ?? []) as LedgerRow[],
    all: statsFor(statRows),
    pushed: statsFor(statRows.filter((r) => r.pushed)),
    buckets: bucketStats(statRows.filter((r) => r.pushed && currentConvention(r))),
    bucketsAll: bucketStats(statRows.filter(currentConvention)),
  };
}

/**
 * Calibration only — the same stored rows, without the recent-rows page. Used
 * where the buckets are needed but the record itself is not (AI context).
 */
export async function readCalibration(
  supabase: Supa
): Promise<{ pushed: BucketStats[]; all: BucketStats[] }> {
  const rows = (await readStatRows(supabase)).filter(currentConvention);
  return {
    pushed: bucketStats(rows.filter((r) => r.pushed) as CalibrationRow[]),
    all: bucketStats(rows as CalibrationRow[]),
  };
}

