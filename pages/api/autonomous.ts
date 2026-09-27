import type { NextApiRequest, NextApiResponse } from 'next';
import { Candle, ScanConfig } from '../../lib/types';
import { detectMarketRegime, RegimeResult } from '../../lib/algorithms/marketRegime';
import { computeAutonomousParams, AutonomousParams } from '../../lib/algorithms/autonomousParams';
import { analyzeMultiTimeframe, MultiTimeframeResult } from '../../lib/algorithms/multiTimeframe';
import {
  UniverseEntry,
  UniverseSource,
  fetchKlinesRouted,
  getUniverse,
} from '../../lib/universe';
import { parseRanges } from '../../lib/ranges';

export const config = { maxDuration: 60 };

const TIMEFRAMES = ['1h', '4h', '1d'];
const SOURCE_ORDER: UniverseSource[] = ['binance', 'gate', 'hyperliquid'];

// Pacing per source (measured: Gate tolerates ~19 rps @ conc 20; Binance by weight; HL very permissive).
const SOURCE_CONCURRENCY: Record<UniverseSource, number> = {
  binance: 6,
  gate: 8,
  hyperliquid: 4,
};

class ScanBudgetExceeded extends Error {
  constructor(public readonly detail: string) {
    super(`scan budget exceeded (${detail})`);
  }
}

interface ChunkResponse {
  universeId: string;
  universeTotal: number;
  /** Depth-sliced total actually being scanned this run. */
  total: number;
  sources: Record<UniverseSource, number>;
  /** Universe position of each returned ranking (parallel array). */
  positions: number[];
  progress: {
    offset: number;
    nextOffset: number;
    scannedInChunk: number;
    done: boolean;
    elapsedMs: number;
    ratePerSec: number;
    etaSec: number | null;
  };
  regime: RegimeResult;
  autonomousParams: AutonomousParams;
  rankings: MultiTimeframeResult[];
}

function parseIntParam(v: string | string[] | undefined, fallback: number, min: number, max: number): number {
  const raw = Array.isArray(v) ? v[0] : v;
  const n = parseInt(raw || '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

async function fetchSymbolTimeframes(
  entry: UniverseEntry,
  indexData: { [tf: string]: Candle[] },
  bars: number,
  deadline: number
): Promise<{ [tf: string]: { asset: Candle[]; index: Candle[] } }> {
  const timeframeData: { [tf: string]: { asset: Candle[]; index: Candle[] } } = {};
  let hasData = false;
  let softErrors = 0;

  for (const tf of TIMEFRAMES) {
    // Abort cleanly at the budget so the symbol is retried fresh next chunk
    // instead of being ranked on partial timeframe data.
    if (Date.now() > deadline) throw new ScanBudgetExceeded(`${entry.symbol} before ${tf}`);

    const indexCandles = indexData[tf];
    if (!indexCandles || indexCandles.length === 0) continue;

    let assetCandles: Candle[];
    const t0 = Date.now();
    try {
      assetCandles = await fetchKlinesRouted(entry.symbol, tf, bars);
    } catch (err) {
      const e = err as { message?: string; cause?: { code?: string; message?: string } };
      const cause = e?.cause ? ` cause=${e.cause.code || e.cause.message || ''}` : '';
      const msg = `${e?.message || err}${cause}`;
      // 404/400 = the listing truly has no data; anything else (cert hijack, 429,
      // timeout…) is transient and worth retrying next chunk.
      if (!/Invalid symbol|INVALID_CURRENCY_PAIR|HTTP 400|HTTP 404|No market data/i.test(msg)) {
        softErrors++;
      }
      if (Date.now() - t0 > 4000 || softErrors > 0) {
        console.warn(`[kline-fail] ${entry.symbol} ${entry.source} ${tf} ${Date.now() - t0}ms: ${msg}`);
      }
      continue;
    }
    const dt = Date.now() - t0;
    if (dt > 4000) console.log(`[kline-slow] ${entry.symbol} ${tf} ${dt}ms`);
    if (assetCandles.length === 0) continue;

    hasData = true;
    const minLen = Math.min(indexCandles.length, assetCandles.length);
    if (minLen < 50) continue; // too short to analyze this TF — but the venue is alive
    timeframeData[tf] = {
      asset: assetCandles.slice(-minLen),
      index: indexCandles.slice(-minLen),
    };
  }

  if (!hasData) {
    if (softErrors > 0) {
      throw new Error(`all timeframes failed (transient) for ${entry.symbol}`);
    }
    throw new Error(`no candle data for ${entry.symbol}`);
  }

  return timeframeData;
}

async function runQueue<T>(
  queue: T[],
  concurrency: number,
  deadline: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (cursor < queue.length) {
      if (Date.now() > deadline) return;
      const idx = cursor++;
      await worker(queue[idx]);
    }
  });
  await Promise.all(runners);
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ChunkResponse | { error: string }>
) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    indexSymbol = 'BTCUSDT',
    depth = 'all',
    universeId,
  } = req.query;

  const offset = parseIntParam(req.query.offset, 0, 0, 1_000_000);
  const span = parseIntParam(req.query.span, 500, 1, 2000);
  const budgetMs = parseIntParam(req.query.budgetMs, 15_000, 3_000, 45_000);
  const bars = parseIntParam(req.query.limit, 200, 100, 500);
  const skip = parseRanges(req.query.skip);

  const depthRaw = Array.isArray(depth) ? depth[0] : depth;
  const depthN = depthRaw === 'all' ? Infinity : parseIntParam(depthRaw, 100, 10, 100_000);
  const indexClean = (Array.isArray(indexSymbol) ? indexSymbol[0] : indexSymbol).toUpperCase();

  try {
    const universe = await getUniverse();
    const tIndex = Date.now();

    // Depth slice of the volume-ranked universe, with the benchmark asset removed.
    const symbols = universe.entries
      .filter((e) => e.symbol !== indexClean)
      .slice(0, depthN === Infinity ? undefined : depthN);
    const total = symbols.length;

    // Absolute universe positions covered by this chunk.
    const positions: number[] = [];
    for (let p = offset; p < Math.min(offset + span, total); p++) positions.push(p);

    // Positions the client already has — skip network work for them.
    const donePositions = new Set<number>(positions.filter((p) => skip.has(p)));
    const scanPositions = positions.filter((p) => !skip.has(p));

    // Index candles for all timeframes (shared by every symbol in the slice).
    const indexData: { [tf: string]: Candle[] } = {};
    for (const tf of TIMEFRAMES) {
      try {
        indexData[tf] = await fetchKlinesRouted(indexClean, tf, bars);
      } catch (err) {
        console.error(`index fetch failed for ${indexClean} ${tf}:`, err);
        indexData[tf] = [];
      }
    }
    if (!indexData['4h']?.length && !indexData['1h']?.length) {
      return res.status(502).json({ error: `No index data for ${indexClean}` });
    }
    console.log(`[autonomous] index fetch ${Date.now() - tIndex}ms`);

    const regime = detectMarketRegime(indexData['4h']?.length ? indexData['4h'] : indexData['1h'], 20);
    const autonomousParams = computeAutonomousParams(
      regime.regime,
      regime.confidence,
      regime.atrPercent,
      regime.volatilityPercentile
    );

    const scanConfig: ScanConfig = {
      indexSymbol: indexClean,
      assetSymbols: symbols.map((e) => e.symbol),
      interval: '4h',
      lookback: autonomousParams.lookback,
      rsPeriod: autonomousParams.rsPeriod,
      indexThreshold: autonomousParams.indexThreshold,
      volumeMultiplier: autonomousParams.volumeMultiplier,
      volumePeriod: autonomousParams.volumePeriod,
    };

    const startedAt = Date.now();
    const deadline = startedAt + budgetMs;

    const completed = new Set<number>(donePositions);
    const resultsByPos = new Map<number, MultiTimeframeResult>();

    const buckets = SOURCE_ORDER.map((source) => ({
      source,
      items: scanPositions
        .filter((p) => symbols[p].source === source)
        .map((p) => ({ entry: symbols[p], pos: p })),
    }));

    await Promise.all(
      buckets.map((bucket) =>
        runQueue(
          bucket.items,
          SOURCE_CONCURRENCY[bucket.source],
          deadline,
          async ({ entry, pos }) => {
            try {
              const timeframeData = await fetchSymbolTimeframes(entry, indexData, bars, deadline);
              const result = analyzeMultiTimeframe(entry.symbol, timeframeData, scanConfig);
              resultsByPos.set(pos, result);
              completed.add(pos);
            } catch (err) {
              if (err instanceof ScanBudgetExceeded) {
                // Budget hit mid-symbol — leave the position undone for the next chunk.
                console.log(`[budget-abort] ${err.detail}`);
                return;
              }
              const msg = err instanceof Error ? err.message : String(err);
              if (/transient|429|Max retries|abort|ETIMEDOUT|ECONNRESET|fetch failed|socket/i.test(msg)) {
                // Transient network/rate-limit issue — retry this position next chunk
                // instead of silently dropping the coin from coverage.
                console.warn(`[transient] ${entry.symbol}: ${msg}`);
                return;
              }
              console.warn(`scan failed for ${entry.symbol}:`, msg);
              // Treat hard data failures as scanned-without-result so dead listings don't loop forever.
              completed.add(pos);
            }
          }
        )
      )
    );

    const scannedPositions = Array.from(resultsByPos.keys()).sort((a, b) => a - b);
    const rankings = scannedPositions
      .map((p) => resultsByPos.get(p)!)
      .sort((a, b) => b.confluenceScore - a.confluenceScore);
    const rankedPositions = scannedPositions
      .slice()
      .sort((a, b) => {
        const ra = resultsByPos.get(a)!;
        const rb = resultsByPos.get(b)!;
        return rb.confluenceScore - ra.confluenceScore;
      });

    // First position of this chunk range that still needs work (skip counts as done).
    let nextOffset = offset;
    while (nextOffset < offset + positions.length && completed.has(nextOffset)) nextOffset++;
    if (nextOffset >= offset + positions.length && offset + positions.length >= total) {
      nextOffset = total;
    }

    const newlyScanned = scannedPositions.length;
    const elapsedMs = Date.now() - startedAt;
    const ratePerSec = elapsedMs > 0 ? (newlyScanned / elapsedMs) * 1000 : 0;
    // Positions below `offset` are known-done by client protocol; above the window unknown.
    const doneGlobal = offset + completed.size;
    const remaining = Math.max(total - doneGlobal, 0);
    const etaSec =
      ratePerSec > 0 && remaining > 0
        ? Math.round(remaining / ratePerSec)
        : remaining === 0
        ? 0
        : null;

    return res.status(200).json({
      universeId: universe.id,
      universeTotal: universe.universeTotal,
      total,
      sources: universe.sourceCounts,
      positions: rankedPositions,
      progress: {
        offset,
        nextOffset,
        scannedInChunk: newlyScanned,
        done: doneGlobal >= total,
        elapsedMs,
        ratePerSec: Math.round(ratePerSec * 10) / 10,
        etaSec,
      },
      regime,
      autonomousParams,
      rankings,
    });
  } catch (err) {
    return res.status(500).json({
      error: `Autonomous scan failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
    });
  }
}
