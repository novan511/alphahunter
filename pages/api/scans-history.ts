import type { NextApiRequest, NextApiResponse } from 'next';
import { getSupabase, isSupabaseConfigured } from '../../lib/supabase';
import { parseSignalSummary, ScanHistoryResponse } from '../../lib/scanHistory';

/**
 * GET /api/scans-history?index=BTCUSDT&limit=30
 *
 * Returns the recent autonomous scan timeline for the sparkline + persistence
 * readout on the home page. Reads only the summary columns of `scan_history`:
 * `results` carries the full rankings payload (hundreds of KB per row) and is
 * deliberately never selected here.
 */

/** Narrow projection of scan_history — the columns we actually read. */
interface HistoryRow {
  created_at: string;
  index_symbol: string | null;
  signals_count: number | null;
  total_scanned: number | null;
  buy_signals_summary: string | null;
  sell_signals_summary: string | null;
  regime_label: string | null;
}

const SUMMARY_COLUMNS =
  'created_at, index_symbol, signals_count, total_scanned, buy_signals_summary, sell_signals_summary, regime_label';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ScanHistoryResponse | { error: string }>
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!isSupabaseConfigured()) {
    return res.status(200).json({ configured: false, entries: [] });
  }

  const supabase = getSupabase();
  if (!supabase) {
    return res.status(200).json({ configured: false, entries: [] });
  }

  const indexSymbol =
    typeof req.query.index === 'string' && req.query.index
      ? req.query.index.toUpperCase()
      : undefined;
  const limitRaw = parseInt(typeof req.query.limit === 'string' ? req.query.limit : '', 10);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 30, 1), 90);

  try {
    const { data, error } = await supabase
      .from('scan_history')
      .select(SUMMARY_COLUMNS)
      .eq('mode', 'autonomous')
      .eq('scan_type', 'crypto')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.warn('scans-history read failed:', error.message);
      // Not an error the user should see — the local buffer still renders.
      return res.status(200).json({ configured: true, entries: [] });
    }

    const rows = (data ?? []) as unknown as HistoryRow[];
    const entries = rows
      .map((row) => {
        const scannedAt = Date.parse(row.created_at);
        if (!Number.isFinite(scannedAt)) return null;
        return {
          scannedAt,
          indexSymbol: (row.index_symbol || indexSymbol || 'BTCUSDT').toUpperCase(),
          regimeLabel: row.regime_label ?? null,
          signalsCount: row.signals_count ?? 0,
          totalScanned: row.total_scanned ?? 0,
          buys: parseSignalSummary(row.buy_signals_summary),
          sells: parseSignalSummary(row.sell_signals_summary),
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);

    return res.status(200).json({ configured: true, entries });
  } catch (err) {
    console.warn('scans-history failed:', err);
    return res.status(200).json({ configured: true, entries: [] });
  }
}
