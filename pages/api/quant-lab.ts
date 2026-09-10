import type { NextApiRequest, NextApiResponse } from 'next';
import {
  runAndPersistMarket,
  applyBestToDesk,
  lastLabRunAt,
  isLabDue,
  LAB_AUTO_INTERVAL_HOURS,
  LAB_MARKETS,
  loadPaperState,
  savePaperState,
} from '../../lib/quant/labService';
import { rankLabRows, LabBatchRequest } from '../../lib/quant/labEngine';
import { MarketId } from '../../lib/quant/marketProfiles';
import { getSupabase, isSupabaseConfigured } from '../../lib/supabase';

function parseMarket(raw: string): MarketId | null {
  return (LAB_MARKETS as string[]).includes(raw) ? (raw as MarketId) : null;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET,POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const action =
      req.method === 'GET'
        ? String(req.query.action || 'history')
        : String(req.body?.action || 'run');

    if (action === 'history') {
      const marketId = parseMarket(String(req.query.marketId || 'crypto'));
      if (!marketId) return res.status(400).json({ error: 'bad marketId' });
      if (!isSupabaseConfigured()) {
        return res.status(200).json({ ok: true, runs: [], note: 'supabase not configured' });
      }
      const supabase = getSupabase();
      if (!supabase) return res.status(200).json({ ok: true, runs: [] });
      const { data, error } = await supabase
        .from('quant_lab_runs')
        .select('*')
        .eq('market_id', marketId)
        .order('created_at', { ascending: false })
        .limit(8);
      if (error) return res.status(500).json({ error: error.message });
      const lastAt = data?.[0]?.created_at ?? null;
      return res.status(200).json({
        ok: true,
        runs: data || [],
        autoIntervalHours: LAB_AUTO_INTERVAL_HOURS,
        lastRunAt: lastAt,
        due: isLabDue(lastAt),
      });
    }

    if (action === 'run') {
      const body = (req.body || {}) as LabBatchRequest & {
        applyBestToDesk?: boolean;
      };
      const marketId = parseMarket(String(body.marketId || 'crypto'));
      if (!marketId) return res.status(400).json({ error: 'bad marketId' });

      const out = await runAndPersistMarket(marketId, {
        applyBestToDesk: body.applyBestToDesk,
        source: 'manual',
        body,
      });
      return res.status(200).json({
        ok: true,
        marketId: out.marketId,
        runId: out.runId,
        ranked: out.ranked,
        appliedBestToDesk: out.appliedBestToDesk,
      });
    }

    if (action === 'apply') {
      const body = req.body as {
        marketId?: string;
        risk?: Record<string, unknown>;
        label?: string;
      };
      const marketId = parseMarket(String(body.marketId || ''));
      if (!marketId || !body.risk) {
        return res.status(400).json({ error: 'marketId + risk required' });
      }
      const state = await loadPaperState(marketId);
      if (!state) {
        return res.status(404).json({ error: 'desk paper state not found — start agent first' });
      }
      const risk = state.risk as Record<string, unknown>;
      for (const [k, v] of Object.entries(body.risk)) {
        risk[k] = v;
      }
      const log = Array.isArray(state.log) ? (state.log as string[]) : [];
      state.log = [
        `[lab-apply] ${body.label || 'custom'} · manual apply`,
        ...log,
      ].slice(0, 80);
      await savePaperState(marketId, state);
      return res.status(200).json({ ok: true, marketId, applied: true });
    }

    if (action === 'status') {
      const statuses = [];
      for (const m of LAB_MARKETS) {
        const lastAt = await lastLabRunAt(marketIdSafe(m));
        statuses.push({
          marketId: m,
          lastRunAt: lastAt,
          due: isLabDue(lastAt),
          autoIntervalHours: LAB_AUTO_INTERVAL_HOURS,
        });
      }
      return res.status(200).json({ ok: true, markets: statuses });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Quant lab failed',
    });
  }
}

function marketIdSafe(m: string): MarketId {
  return m as MarketId;
}

// silence unused import if tree-shaken oddly
void applyBestToDesk;
void rankLabRows;
