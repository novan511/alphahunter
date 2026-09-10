import type { NextApiRequest, NextApiResponse } from 'next';
import { getSupabase, isSupabaseConfigured } from '../../lib/supabase';

interface IdxSignal {
  type: 'buy' | 'sell';
  strength: number;
  rsZScore: number;
  indexReturn: number;
  assetReturn: number;
  volumeRatio: number;
  reason: string;
}

export interface IDXScanResult {
  ticker: string;
  currentRSZScore: number;
  rsMomentum: number;
  stockReturn: number;
  indexReturn: number;
  volumeRatio: number;
  signal: IdxSignal | null;
  rank: number;
}

export interface IdxScanHistoryRow {
  created_at: string;
  index_symbol: string;
  interval: string;
  results: IDXScanResult[] | null;
  total_scanned: number | null;
  signals_count: number | null;
  buy_signals_summary: string | null;
  sell_signals_summary: string | null;
  autonomous_params: {
    indexThreshold?: number;
    volumeMultiplier?: number;
    categories?: string[];
  } | null;
}

export interface LastIdxScanResponse {
  configured: boolean;
  found: boolean;
  scannedAt?: number;
  interval?: string;
  indexThreshold?: number;
  volumeMultiplier?: number;
  categories?: string[];
  results?: IDXScanResult[];
  totalScanned?: number;
  signalsFound?: number;
  buySummary?: string;
  sellSummary?: string;
  source?: 'scan_history';
}

function buildSummaries(results: IDXScanResult[]) {
  const buys = results
    .filter((r) => r.signal?.type === 'buy')
    .sort((a, b) => (b.signal?.strength ?? 0) - (a.signal?.strength ?? 0))
    .slice(0, 20)
    .map((r) => `${r.ticker}(${r.currentRSZScore.toFixed(2)})`)
    .join(', ');

  const sells = results
    .filter((r) => r.signal?.type === 'sell')
    .sort((a, b) => (b.signal?.strength ?? 0) - (a.signal?.strength ?? 0))
    .slice(0, 20)
    .map((r) => `${r.ticker}(${r.currentRSZScore.toFixed(2)})`)
    .join(', ');

  return { buys, sells };
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<LastIdxScanResponse | { ok: true; id?: string } | { error: string; configured?: boolean }>
) {
  if (!isSupabaseConfigured()) {
    if (req.method === 'GET') {
      return res.status(200).json({ configured: false, found: false });
    }
    return res.status(200).json({ error: 'Supabase not configured', configured: false });
  }

  const supabase = getSupabase();
  if (!supabase) {
    return res.status(500).json({ error: 'Supabase client unavailable' });
  }

  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('scan_history')
        .select(
          'created_at, index_symbol, interval, results, total_scanned, signals_count, buy_signals_summary, sell_signals_summary, autonomous_params'
        )
        .eq('scan_type', 'idx')
        .eq('mode', 'manual')
        .order('created_at', { ascending: false })
        .limit(1);

      if (error) {
        console.warn('idx scan_history read failed:', error.message);
        return res.status(200).json({ configured: true, found: false });
      }

      const row = data?.[0] as IdxScanHistoryRow | undefined;
      if (!row?.results?.length) {
        return res.status(200).json({ configured: true, found: false });
      }

      return res.status(200).json({
        configured: true,
        found: true,
        source: 'scan_history',
        scannedAt: Date.parse(row.created_at) || Date.now(),
        interval: row.interval || '1d',
        indexThreshold: row.autonomous_params?.indexThreshold,
        volumeMultiplier: row.autonomous_params?.volumeMultiplier,
        categories: row.autonomous_params?.categories,
        results: row.results,
        totalScanned: row.total_scanned ?? row.results.length,
        signalsFound: row.signals_count ?? row.results.filter((r) => r.signal).length,
        buySummary: row.buy_signals_summary ?? undefined,
        sellSummary: row.sell_signals_summary ?? undefined,
      });
    } catch (err) {
      return res.status(200).json({
        configured: true,
        found: false,
      });
    }
  }

  if (req.method === 'POST') {
    const body = req.body as {
      scannedAt?: number;
      interval?: string;
      indexThreshold?: number;
      volumeMultiplier?: number;
      categories?: string[];
      results?: IDXScanResult[];
    };

    if (!Array.isArray(body?.results) || body.results.length === 0) {
      return res.status(400).json({ error: 'Invalid IDX scan payload' });
    }

    const scannedAt = body.scannedAt || Date.now();
    const { buys, sells } = buildSummaries(body.results);
    const signalsCount = body.results.filter((r) => r.signal).length;

    try {
      const { data, error } = await supabase
        .from('scan_history')
        .insert({
          scan_type: 'idx',
          mode: 'manual',
          index_symbol: '^JKSE',
          interval: body.interval || '1d',
          autonomous_params: {
            indexThreshold: body.indexThreshold,
            volumeMultiplier: body.volumeMultiplier,
            categories: body.categories ?? [],
          },
          results: body.results,
          total_scanned: body.results.length,
          signals_count: signalsCount,
          buy_signals_summary: buys,
          sell_signals_summary: sells,
          regime_label: '',
          created_at: new Date(scannedAt).toISOString(),
        })
        .select('id')
        .single();

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      return res.status(200).json({ ok: true, id: data?.id });
    } catch (err) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to save IDX scan',
      });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
