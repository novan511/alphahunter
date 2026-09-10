import type { NextApiRequest, NextApiResponse } from 'next';
import { getSupabase, isSupabaseConfigured } from '../../lib/supabase';
import { RegimeResult } from '../../lib/algorithms/marketRegime';
import { AutonomousParams } from '../../lib/algorithms/autonomousParams';
import { MultiTimeframeResult } from '../../lib/algorithms/multiTimeframe';

export interface SaveScanBody {
  scannedAt?: number;
  indexSymbol: string;
  regime: RegimeResult;
  autonomousParams: AutonomousParams;
  rankings: MultiTimeframeResult[];
  totalScanned?: number;
}

function buildSummaries(rankings: MultiTimeframeResult[]) {
  const buys = rankings
    .filter((r) => r.finalSignal === 'buy' || r.finalSignal === 'strong_buy')
    .sort((a, b) => b.confluenceScore - a.confluenceScore)
    .slice(0, 20)
    .map((r) => `${r.asset.replace('USDT', '')}(${r.confluenceScore.toFixed(1)})`)
    .join(', ');

  const sells = rankings
    .filter((r) => r.finalSignal === 'sell' || r.finalSignal === 'strong_sell')
    .sort((a, b) => b.confluenceScore - a.confluenceScore)
    .slice(0, 20)
    .map((r) => `${r.asset.replace('USDT', '')}(${r.confluenceScore.toFixed(1)})`)
    .join(', ');

  return { buys, sells };
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<{ ok: true; id?: string } | { error: string; configured?: boolean }>
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!isSupabaseConfigured()) {
    return res.status(200).json({ error: 'Supabase not configured', configured: false });
  }

  const supabase = getSupabase();
  if (!supabase) {
    return res.status(500).json({ error: 'Supabase client unavailable' });
  }

  const body = req.body as SaveScanBody;
  if (!body?.regime || !body?.autonomousParams || !Array.isArray(body.rankings) || body.rankings.length === 0) {
    return res.status(400).json({ error: 'Invalid scan payload' });
  }

  const indexSymbol = (body.indexSymbol || 'BTCUSDT').toUpperCase();
  const scannedAt = body.scannedAt || Date.now();
  const { buys, sells } = buildSummaries(body.rankings);
  const signalsCount = body.rankings.filter((r) => r.finalSignal !== 'neutral').length;

  try {
    // Primary: scan_history (matches existing production schema)
    const { data, error } = await supabase
      .from('scan_history')
      .insert({
        scan_type: 'crypto',
        mode: 'autonomous',
        index_symbol: indexSymbol,
        interval: '4h',
        market_regime: body.regime,
        autonomous_params: body.autonomousParams,
        results: body.rankings,
        total_scanned: body.totalScanned ?? body.rankings.length,
        signals_count: signalsCount,
        buy_signals_summary: buys,
        sell_signals_summary: sells,
        regime_label: body.regime.regime,
        created_at: new Date(scannedAt).toISOString(),
      })
      .select('id')
      .single();

    if (error) {
      // Fallback: autonomous_scans if scan_history insert is blocked
      const { data: fallback, error: fallbackError } = await supabase
        .from('autonomous_scans')
        .insert({
          index_symbol: indexSymbol,
          created_at: new Date(scannedAt).toISOString(),
          payload: {
            scannedAt,
            indexSymbol,
            regime: body.regime,
            autonomousParams: body.autonomousParams,
            rankings: body.rankings,
            totalScanned: body.totalScanned ?? body.rankings.length,
          },
        })
        .select('id')
        .single();

      if (fallbackError) {
        return res.status(500).json({
          error: `scan_history: ${error.message}; autonomous_scans: ${fallbackError.message}`,
        });
      }

      return res.status(200).json({ ok: true, id: fallback?.id });
    }

    return res.status(200).json({ ok: true, id: data?.id });
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to save scan',
    });
  }
}
