import type { NextApiRequest, NextApiResponse } from 'next';
import { runAutonomousChunk, ChunkResponse } from '../../lib/autonomousChunk';
import { parseRanges } from '../../lib/ranges';

export const config = { maxDuration: 60 };

function parseIntParam(v: string | string[] | undefined, fallback: number, min: number, max: number): number {
  const raw = Array.isArray(v) ? v[0] : v;
  const n = parseInt(raw || '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * One time-budgeted slice of the autonomous sweep. The browser calls this in
 * a loop (offset/span/skip cursor); the cron worker calls the same engine
 * in-process via lib/autonomousChunk. Response shape is identical for both.
 *
 * Query params:
 *   indexSymbol, depth (all|100|500), order (cap|volume),
 *   universe (curated|all — curated is the default, see lib/curatedUniverse),
 *   offset, span, budgetMs, limit (bars), skip (ranges), universeId
 */
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
  const indexClean = (Array.isArray(indexSymbol) ? indexSymbol[0] : indexSymbol).toUpperCase();
  const universeRaw = Array.isArray(req.query.universe) ? req.query.universe[0] : req.query.universe;
  const universeMode = (universeRaw || 'curated').toLowerCase() === 'all' ? 'all' : 'curated';

  try {
    const chunk = await runAutonomousChunk({
      indexSymbol: indexClean,
      depth: depthRaw,
      order: (req.query.order as string | undefined)?.toLowerCase() === 'volume' ? 'volume' : 'cap',
      universeMode,
      offset,
      span,
      budgetMs,
      bars,
      skipPositions: new Set<number>(skip),
      universeId: Array.isArray(universeId) ? universeId[0] : universeId,
    });
    return res.status(200).json(chunk);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    const status = /No index data/.test(msg) ? 502 : 500;
    return res.status(status).json({
      error: `Autonomous scan failed: ${msg}`,
    });
  }
}
