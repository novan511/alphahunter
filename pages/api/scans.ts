import type { NextApiRequest, NextApiResponse } from 'next';
import { getSupabase, isSupabaseConfigured } from '../../lib/supabase';
import { RegimeResult } from '../../lib/algorithms/marketRegime';
import { AutonomousParams } from '../../lib/algorithms/autonomousParams';
import { MultiTimeframeResult } from '../../lib/algorithms/multiTimeframe';

export interface LastScanResponse {
  configured: boolean;
  found: boolean;
  scannedAt?: number;
  indexSymbol?: string;
  regime?: RegimeResult;
  autonomousParams?: AutonomousParams;
  rankings?: MultiTimeframeResult[];
  totalScanned?: number;
  signalsFound?: number;
  buySummary?: string;
  sellSummary?: string;
  regimeLabel?: string;
  source?: 'scan_history' | 'autonomous_scans';
}

interface ScanHistoryRow {
  created_at: string;
  index_symbol: string;
  market_regime: RegimeResult | null;
  autonomous_params: AutonomousParams | null;
  results: MultiTimeframeResult[] | null;
  total_scanned: number | null;
  signals_count: number | null;
  buy_signals_summary: string | null;
  sell_signals_summary: string | null;
  regime_label: string | null;
}

interface AutonomousScanRow {
  created_at: string;
  index_symbol: string;
  payload: {
    scannedAt?: number;
    regime?: RegimeResult;
    autonomousParams?: AutonomousParams;
    rankings?: MultiTimeframeResult[];
    totalScanned?: number;
  } | null;
}

function normalizeRankings(rankings: MultiTimeframeResult[] | null | undefined): MultiTimeframeResult[] {
  if (!Array.isArray(rankings)) return [];
  return rankings.map((r) => ({
    ...r,
    timeframes: Array.isArray(r.timeframes)
      ? r.timeframes.map((tf) => ({
          ...tf,
          signalAgeBars: tf.signalAgeBars ?? null,
        }))
      : [],
    newestSignalAgeBars: r.newestSignalAgeBars ?? null,
  }));
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<LastScanResponse | { error: string }>
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!isSupabaseConfigured()) {
    return res.status(200).json({ configured: false, found: false });
  }

  const supabase = getSupabase();
  if (!supabase) {
    return res.status(500).json({ error: 'Supabase client unavailable' });
  }

  const indexSymbol =
    typeof req.query.indexSymbol === 'string'
      ? req.query.indexSymbol.toUpperCase()
      : 'BTCUSDT';

  try {
    // Prefer the richer scan_history table used by the original app
    const { data: historyRows, error: historyError } = await supabase
      .from('scan_history')
      .select(
        'created_at, index_symbol, market_regime, autonomous_params, results, total_scanned, signals_count, buy_signals_summary, sell_signals_summary, regime_label'
      )
      .eq('index_symbol', indexSymbol)
      .eq('mode', 'autonomous')
      .order('created_at', { ascending: false })
      .limit(1);

    if (historyError) {
      // fall through to autonomous_scans if scan_history is missing/unreadable
      console.warn('scan_history read failed:', historyError.message);
    } else if (historyRows && historyRows.length > 0) {
      const row = historyRows[0] as ScanHistoryRow;
      const rankings = normalizeRankings(row.results);
      if (rankings.length === 0) {
        return res.status(200).json({ configured: true, found: false });
      }

      return res.status(200).json({
        configured: true,
        found: true,
        source: 'scan_history',
        scannedAt: Date.parse(row.created_at) || Date.now(),
        indexSymbol: row.index_symbol,
        regime: row.market_regime ?? undefined,
        autonomousParams: row.autonomous_params ?? undefined,
        rankings,
        totalScanned: row.total_scanned ?? rankings.length,
        signalsFound: row.signals_count ?? rankings.filter((r) => r.finalSignal !== 'neutral').length,
        buySummary: row.buy_signals_summary ?? undefined,
        sellSummary: row.sell_signals_summary ?? undefined,
        regimeLabel: row.regime_label ?? undefined,
      });
    }

    // Fallback: older/alternate table
    const { data: autoRows, error: autoError } = await supabase
      .from('autonomous_scans')
      .select('created_at, index_symbol, payload')
      .eq('index_symbol', indexSymbol)
      .order('created_at', { ascending: false })
      .limit(1);

    if (autoError) {
      console.warn('autonomous_scans read failed:', autoError.message);
      return res.status(200).json({ configured: true, found: false });
    }

    if (!autoRows || autoRows.length === 0) {
      return res.status(200).json({ configured: true, found: false });
    }

    const row = autoRows[0] as AutonomousScanRow;
    const payload = row.payload;
    if (!payload) {
      return res.status(200).json({ configured: true, found: false });
    }

    const rankings = normalizeRankings(payload.rankings);

    return res.status(200).json({
      configured: true,
      found: rankings.length > 0,
      source: 'autonomous_scans',
      scannedAt: payload.scannedAt || Date.parse(row.created_at) || Date.now(),
      indexSymbol: row.index_symbol,
      regime: payload.regime,
      autonomousParams: payload.autonomousParams,
      rankings,
      totalScanned: payload.totalScanned ?? rankings.length,
      signalsFound: rankings.filter((r) => r.finalSignal !== 'neutral').length,
    });
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to load last scan',
    });
  }
}
