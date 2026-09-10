import {
  runLabBatch,
  rankLabRows,
  LabRunRow,
  LabBatchRequest,
  LabGridSize,
} from './labEngine';
import { MarketId } from './marketProfiles';
import { getSupabase, isSupabaseConfigured } from '../supabase';

// Vercel Hobby allows only daily cron — keep UI due-check in sync (24h)
export const LAB_AUTO_INTERVAL_HOURS = 24;
export const LAB_MARKETS: MarketId[] = ['crypto', 'commodities', 'gold-silver'];

export async function persistLabBatch(marketId: string, rows: LabRunRow[], source = 'manual') {
  if (!isSupabaseConfigured()) return null;
  const supabase = getSupabase();
  if (!supabase) return null;
  const best = rankLabRows(rows).find((r) => r.status === 'done');
  const payload = {
    market_id: marketId,
    status: 'done',
    combo_count: rows.length,
    best_combo_id: best?.comboId ?? null,
    best_label: best?.label ?? null,
    best_score: best?.metrics?.compositeScore ?? null,
    best_risk: best?.risk ?? null,
    best_metrics: best?.metrics ?? null,
    rows,
    created_at: new Date().toISOString(),
  };

  // Try with source; fallback if column missing in older schema
  let { data, error } = await supabase
    .from('quant_lab_runs')
    .insert({ ...payload, source })
    .select('id')
    .single();

  if (error && String(error.message).includes('source')) {
    ({ data, error } = await supabase
      .from('quant_lab_runs')
      .insert(payload)
      .select('id')
      .single());
  }

  if (error) {
    console.warn('quant_lab_runs insert failed', error.message);
    return null;
  }
  return data?.id as string | null;
}

export async function loadPaperState(agentId: string) {
  if (!isSupabaseConfigured()) return null;
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase
    .from('paper_trading_state')
    .select('state')
    .eq('id', agentId)
    .maybeSingle();
  return (data?.state as Record<string, unknown>) || null;
}

export async function savePaperState(agentId: string, state: Record<string, unknown>) {
  if (!isSupabaseConfigured()) return;
  const supabase = getSupabase();
  if (!supabase) return;
  await supabase.from('paper_trading_state').upsert({
    id: agentId,
    state,
    updated_at: new Date().toISOString(),
  });
}

export async function applyBestToDesk(marketId: MarketId, best: LabRunRow): Promise<boolean> {
  const state = await loadPaperState(marketId);
  if (!state?.risk) return false;
  const risk = state.risk as Record<string, unknown>;
  const src = best.risk as Record<string, unknown>;
  for (const k of [
    'riskPerTrade',
    'minSignalStrength',
    'stopLossATR',
    'takeProfitATR',
    'maxConcurrentPositions',
    'maxExposurePct',
    'allowShort',
    'interval',
  ]) {
    if (src[k] !== undefined) risk[k] = src[k];
  }
  const log = Array.isArray(state.log) ? (state.log as string[]) : [];
  state.log = [
    `[lab-apply] ${best.label} · score ${best.metrics?.compositeScore} · oosPF ${best.metrics?.oosPF}`,
    ...log,
  ].slice(0, 80);
  await savePaperState(marketId, state);
  return true;
}

export async function lastLabRunAt(marketId: MarketId): Promise<string | null> {
  if (!isSupabaseConfigured()) return null;
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase
    .from('quant_lab_runs')
    .select('created_at')
    .eq('market_id', marketId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.created_at ?? null;
}

export function isLabDue(lastAt: string | null, now = Date.now()): boolean {
  if (!lastAt) return true;
  const t = Date.parse(lastAt);
  if (Number.isNaN(t)) return true;
  return now - t >= LAB_AUTO_INTERVAL_HOURS * 3600_000;
}

export async function runAndPersistMarket(
  marketId: MarketId,
  options: {
    applyBestToDesk?: boolean;
    source?: string;
    body?: LabBatchRequest;
    gridSize?: LabGridSize;
  } = {}
) {
  const rows = await runLabBatch({
    marketId,
    combos: options.body?.combos,
    gridSize: options.gridSize || options.body?.gridSize || 'standard',
    walkForward: true,
  });
  const ranked = rankLabRows(rows);
  const runId = await persistLabBatch(marketId, ranked, options.source || 'manual');

  let applied = false;
  if (options.applyBestToDesk) {
    const best = ranked.find((r) => r.status === 'done' && r.metrics?.credible);
    if (best) {
      applied = await applyBestToDesk(marketId, best);
    }
  }

  return { marketId, runId, ranked, appliedBestToDesk: applied };
}
