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

/** A target is only scored from a candle within this window of the exact due time. */
export const SCORE_TOLERANCE_MS = 6 * 60 * 60 * 1000;

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
}

/* ------------------------------------------------------------------ */
/* Pure helpers (self-checked in scripts/smoke-ledger.ts)              */
/* ------------------------------------------------------------------ */

/** Candle whose timestamp is nearest `targetMs`, or null beyond the tolerance. */
export function nearestCandle(
  candles: Candle[],
  targetMs: number,
  tolMs: number = SCORE_TOLERANCE_MS
): Candle | null {
  let best: Candle | null = null;
  let bestDist = Infinity;
  for (const c of candles) {
    const d = Math.abs(c.time - targetMs);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best && bestDist <= tolMs ? best : null;
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
const MAX_STRUCTURE_TARGETS = 6;

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
    return {
      emitted_at: emittedAt,
      asset: r.asset,
      direction: r.finalSignal.includes('sell') ? 'short' : 'long',
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
    };
  });

  // ignoreDuplicates maps to ON CONFLICT DO NOTHING: the first emit of the day wins.
  const { error } = await supabase
    .from('signal_ledger')
    .upsert(rows, { onConflict: 'asset,direction,emit_day', ignoreDuplicates: true });
  if (error) throw new Error(`recordSignals: ${error.message}`);
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

/**
 * Score due horizons. Only rows whose horizon has passed and is still null are
 * considered; a filled horizon is never read back, so a second run is a no-op.
 */
export async function scoreLedger(
  supabase: Supa,
  opts: ScoreLedgerOptions = {}
): Promise<{ scored: number; candidates: number }> {
  const nowMs = opts.now ?? Date.now();
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
  const candleCache = new Map<string, Candle[]>();
  const load = async (symbol: string): Promise<Candle[]> => {
    const cached = candleCache.get(symbol);
    if (cached) return cached;
    const candles = await fetchKlinesRouted(symbol, SCORE_INTERVAL, SCORE_BARS).catch(() => []);
    candleCache.set(symbol, candles);
    return candles;
  };

  let scored = 0;
  for (const row of candidates) {
    if (scored >= max) break;

    const emittedMs = Date.parse(row.emitted_at);
    const base = row.price;
    const benchBase = row.benchmark_price;
    if (!Number.isFinite(emittedMs) || base == null || benchBase == null) continue;
    if (!(base > 0) || !(benchBase > 0)) continue;

    const due = HORIZONS.filter((h) => emittedMs + h.hours * 3_600_000 <= nowMs);
    if (due.length === 0) continue;

    const assetCandles = await load(row.asset);
    if (assetCandles.length === 0) continue;
    const benchCandles =
      row.benchmark_symbol === row.asset ? assetCandles : await load(row.benchmark_symbol);
    if (benchCandles.length === 0) continue;

    const patch: Record<string, number | string> = {};
    for (const h of due) {
      if (retOf(row, h.key) != null) continue; // already filled — never overwrite
      const targetMs = emittedMs + h.hours * 3_600_000;
      const aCandle = nearestCandle(assetCandles, targetMs);
      const bCandle = nearestCandle(benchCandles, targetMs);
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

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

/** The fields the aggregates read. Rows are only ever read, never recomputed. */
type StatRow = Pick<LedgerRow, 'ret_1d' | 'ret_3d' | 'ret_7d' | 'pushed'>;

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
      .select('ret_1d,ret_3d,ret_7d,pushed')
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
  };
}
