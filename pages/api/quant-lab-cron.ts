import type { NextApiRequest, NextApiResponse } from 'next';
import {
  LAB_MARKETS,
  LAB_AUTO_INTERVAL_HOURS,
  isLabDue,
  lastLabRunAt,
  runAndPersistMarket,
} from '../../lib/quant/labService';
import { isSupabaseConfigured } from '../../lib/supabase';

/**
 * Auto discovery cron.
 * GET /api/quant-lab-cron              → run any market due (interval hours)
 * GET /api/quant-lab-cron?force=1      → run all 3 markets now
 * GET /api/quant-lab-cron?market=crypto
 *
 * Vercel Cron can hit this on a schedule (see vercel.json).
 * UI also calls it when last run is older than LAB_AUTO_INTERVAL_HOURS.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET,POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const force = req.query.force === '1' || req.query.force === 'true';
    const marketParam = typeof req.query.market === 'string' ? req.query.market : '';
    const applyBest = req.query.apply !== '0';

    if (!isSupabaseConfigured()) {
      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: 'supabase not configured — lab history needs DB',
      });
    }

    const targets = marketParam
      ? LAB_MARKETS.filter((m) => m === marketParam)
      : LAB_MARKETS;

    const results: Array<{
      marketId: string;
      skipped: boolean;
      reason?: string;
      runId?: string | null;
      appliedBestToDesk?: boolean;
      bestScore?: number | null;
      bestLabel?: string | null;
    }> = [];

    for (const marketId of targets) {
      const lastAt = await lastLabRunAt(marketId);
      if (!force && !isLabDue(lastAt)) {
        results.push({
          marketId,
          skipped: true,
          reason: `last run ${lastAt} — next due after ${LAB_AUTO_INTERVAL_HOURS}h`,
        });
        continue;
      }

      const out = await runAndPersistMarket(marketId, {
        applyBestToDesk: applyBest,
        source: 'auto',
      });
      const best = out.ranked.find((r) => r.status === 'done' && r.metrics);
      results.push({
        marketId,
        skipped: false,
        runId: out.runId,
        appliedBestToDesk: out.appliedBestToDesk,
        bestScore: best?.metrics?.compositeScore ?? null,
        bestLabel: best?.label ?? null,
      });
    }

    return res.status(200).json({
      ok: true,
      autoIntervalHours: LAB_AUTO_INTERVAL_HOURS,
      ranAt: new Date().toISOString(),
      results,
    });
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'lab cron failed',
    });
  }
}
