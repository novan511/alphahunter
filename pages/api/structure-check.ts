import type { NextApiRequest, NextApiResponse } from 'next';
import { selfCheckMarketStructure } from '../../lib/algorithms/marketStructure';

/**
 * GET /api/structure-check
 *
 * Runs the assert-based self-check for lib/algorithms/marketStructure.ts against
 * known-answer candle series — including series where nothing may be detected.
 * This repo has no test runner, so this is how the pattern geometry gets
 * exercised. Gated by SCAN_CRON_SECRET like the other cron endpoints.
 *
 * shortcut: an API route instead of a test runner, because there is none;
 * delete this and move the assertions into the runner once one exists.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.SCAN_CRON_SECRET;
  const header = req.headers.authorization;
  const bearer = !!secret && !!header && header.startsWith('Bearer ') && header.slice(7) === secret;
  const cron = !!secret && req.headers['x-vercel-cron'] != null;
  if (!bearer && !cron) return res.status(401).json({ error: 'unauthorized' });

  const result = selfCheckMarketStructure();
  return res.status(result.ok ? 200 : 500).json(result);
}
