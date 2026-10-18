import type { NextApiRequest, NextApiResponse } from 'next';
import { getSupabase, isSupabaseConfigured } from '../../lib/supabase';
import {
  readLedger,
  emptyStats,
  type LedgerRow,
  type LedgerStats,
} from '../../lib/signalLedger';
import type { BucketStats } from '../../lib/calibration';

export interface TrackRecordResponse {
  configured: boolean;
  rows: LedgerRow[];
  /** Stats over every confident signal. */
  all: LedgerStats;
  /** Stats over the signals actually pushed to Telegram. */
  pushed: LedgerStats;
  /** R-multiple per setup, pushed only — the headline calibration view. */
  buckets: BucketStats[];
  /** Same, over every confident signal. Never mixed with `buckets`. */
  bucketsAll: BucketStats[];
  error?: string;
}

const DEFAULT_LIMIT = 200;

/**
 * Public read of the signal ledger. Forward-only: it returns whatever has been
 * recorded and scored so far, and nothing here is a projection or a backtest.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<TrackRecordResponse | { error: string }>
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!isSupabaseConfigured()) {
    return res.status(200).json({
      configured: false,
      rows: [],
      all: emptyStats(),
      pushed: emptyStats(),
      buckets: [],
      bucketsAll: [],
    });
  }

  const supabase = getSupabase();
  if (!supabase) {
    return res.status(200).json({
      configured: false,
      rows: [],
      all: emptyStats(),
      pushed: emptyStats(),
      buckets: [],
      bucketsAll: [],
    });
  }

  const raw = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : NaN;
  const limit = Number.isFinite(raw) ? raw : DEFAULT_LIMIT;

  try {
    const view = await readLedger(supabase, limit);
    return res.status(200).json({ configured: true, ...view });
  } catch (err) {
    // Still 200 with an empty view: a missing migration must not break the page.
    return res.status(200).json({
      configured: true,
      rows: [],
      all: emptyStats(),
      pushed: emptyStats(),
      buckets: [],
      bucketsAll: [],
      error: err instanceof Error ? err.message : 'Failed to load ledger',
    });
  }
}
