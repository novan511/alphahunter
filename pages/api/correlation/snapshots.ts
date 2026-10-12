import type { NextApiRequest, NextApiResponse } from 'next';
import { getSupabase, isSupabaseConfigured } from '../../../lib/supabase';
import { sanitizeBasket } from './settings';

const VALID_INTERVALS = ['1h', '4h', '1d'];

export interface DominanceRow {
  symbol: string;
  created_at: string;
  interval: string;
  window_bars: number;
  dominance: number | null;
  dominance_rank: number | null;
  extension_z: number | null;
  regime_label: string | null;
}

function isMatrix(v: unknown, n: number): boolean {
  return (
    Array.isArray(v) &&
    v.length === n &&
    v.every((row) => Array.isArray(row) && row.length === n && row.every((x) => typeof x === 'number'))
  );
}

/**
 * Matrix snapshot persistence.
 *
 * POST → save one matrix. Body: { symbols, interval, window, basketCorr,
 *   rs, corr, beta, coins, missing?, barsUsed?, regimeLabel?,
 *   regimeConfidence? }. Returns { ok, id }.
 * GET  → dominance history for a basket from the
 *   correlation_dominance_history view. Params: symbols (comma-separated),
 *   interval, window, limit (snapshots, default 10, max 30).
 *   Returns { configured, rows } with rows newest-first.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (!isSupabaseConfigured()) {
    return res.status(200).json({ configured: false });
  }
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(200).json({ configured: false });
  }

  if (req.method === 'GET') {
    const symbols = sanitizeBasket(
      typeof req.query.symbols === 'string' ? req.query.symbols.split(',') : [],
    );
    if (!symbols) {
      return res.status(400).json({ error: 'symbols (2..16, comma-separated) is required' });
    }
    const interval =
      typeof req.query.interval === 'string' && VALID_INTERVALS.includes(req.query.interval)
        ? req.query.interval
        : '4h';
    const windowBars = Math.min(
      Math.max(parseInt(req.query.window as string, 10) || 30, 10),
      200,
    );
    const snapshots = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 10, 1), 30);

    const { data, error } = await supabase
      .from('correlation_dominance_history')
      .select('symbol, created_at, interval, window_bars, dominance, dominance_rank, extension_z, regime_label')
      .in('symbol', symbols)
      .eq('interval', interval)
      .eq('window_bars', windowBars)
      .order('created_at', { ascending: false })
      .limit(snapshots * symbols.length);

    if (error) {
      return res.status(500).json({ error: `gagal membaca riwayat: ${error.message}` });
    }
    return res.status(200).json({ configured: true, rows: (data ?? []) as DominanceRow[] });
  }

  if (req.method === 'POST') {
    const b = req.body ?? {};
    const symbols = sanitizeBasket(b.symbols);
    if (!symbols) {
      return res.status(400).json({ error: 'symbols (2..16 simbol valid) is required' });
    }
    const n = symbols.length;
    const interval =
      typeof b.interval === 'string' && VALID_INTERVALS.includes(b.interval) ? b.interval : '4h';
    const windowBars =
      Number.isInteger(b.window) && b.window >= 10 && b.window <= 200 ? b.window : 30;

    if (!isMatrix(b.rs, n) || !isMatrix(b.corr, n) || !isMatrix(b.beta, n)) {
      return res.status(400).json({ error: `rs/corr/beta harus matrix ${n}x${n} angka` });
    }
    if (!Array.isArray(b.coins) || b.coins.length !== n) {
      return res.status(400).json({ error: `coins harus array ${n} profil` });
    }

    const { data, error } = await supabase
      .from('correlation_snapshots')
      .insert({
        symbols,
        interval,
        window_bars: windowBars,
        basket_corr: typeof b.basketCorr === 'number' ? b.basketCorr : null,
        rs: b.rs,
        corr: b.corr,
        beta: b.beta,
        coins: b.coins,
        missing: Array.isArray(b.missing) ? b.missing.filter((x: unknown) => typeof x === 'string') : [],
        bars_used: Number.isInteger(b.barsUsed) ? b.barsUsed : null,
        regime_label: typeof b.regimeLabel === 'string' ? b.regimeLabel : null,
        regime_confidence: typeof b.regimeConfidence === 'number' ? b.regimeConfidence : null,
      })
      .select('id')
      .single();

    if (error) {
      return res.status(500).json({ error: `gagal menyimpan snapshot: ${error.message}` });
    }
    return res.status(200).json({ ok: true, id: data?.id });
  }

  res.setHeader('Allow', 'GET,POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
