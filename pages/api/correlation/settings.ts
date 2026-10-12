import type { NextApiRequest, NextApiResponse } from 'next';
import { getSupabase, isSupabaseConfigured } from '../../../lib/supabase';

const MAX_SYMBOLS = 16;
const MIN_SYMBOLS = 2;

export function toBareSymbol(raw: string): string {
  const trimmed = (raw || '').trim();
  const colon = trimmed.indexOf(':');
  const bare = colon >= 0 ? trimmed.slice(colon + 1) : trimmed;
  return bare.toUpperCase().replace(/[\s_/\\().[\]-]/g, '');
}

export function sanitizeBasket(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const b = toBareSymbol(raw);
    if (!b || b.length > 24) continue;
    if (!out.includes(b)) out.push(b);
    if (out.length >= MAX_SYMBOLS) break;
  }
  return out.length >= MIN_SYMBOLS ? out : null;
}

type Response =
  | { configured: false }
  | { configured: true; symbols: string[] | null; updatedAt?: string }
  | { error: string };

/**
 * The matrix basket, shared across devices via Supabase.
 *
 * GET  → { configured, symbols } (symbols null when never saved)
 * POST → { symbols } to save. Body: { symbols: string[] }.
 *
 * The client keeps localStorage as fallback so the panel works with no
 * backend. This route only persists the shared copy.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Response | { configured: true; symbols: string[]; updatedAt: string }>
) {
  if (!isSupabaseConfigured()) {
    return res.status(200).json({ configured: false });
  }
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(200).json({ configured: false });
  }

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('correlation_settings')
      .select('symbols, updated_at')
      .eq('id', 'default')
      .limit(1)
      .maybeSingle();
    if (error) {
      return res.status(500).json({ error: `gagal membaca basket: ${error.message}` });
    }
    if (!data) {
      return res.status(200).json({ configured: true, symbols: null });
    }
    return res.status(200).json({
      configured: true,
      symbols: Array.isArray(data.symbols) ? data.symbols : null,
      updatedAt: data.updated_at,
    });
  }

  if (req.method === 'POST') {
    const symbols = sanitizeBasket(req.body?.symbols);
    if (!symbols) {
      return res.status(400).json({
        error: `symbols harus array ${MIN_SYMBOLS}..${MAX_SYMBOLS} simbol valid`,
      });
    }
    const { error } = await supabase.from('correlation_settings').upsert(
      { id: 'default', symbols, updated_at: new Date().toISOString() },
      { onConflict: 'id' },
    );
    if (error) {
      return res.status(500).json({ error: `gagal menyimpan basket: ${error.message}` });
    }
    return res.status(200).json({ configured: true, symbols, updatedAt: new Date().toISOString() });
  }

  res.setHeader('Allow', 'GET,POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
