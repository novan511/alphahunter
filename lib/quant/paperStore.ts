import { getSupabase, isSupabaseConfigured } from '../supabase';
import { PaperTrade, PaperState } from './paperEngine';
import { AgentKpi } from './autoTune';

export type AgentId = 'crypto' | 'commodities' | 'gold-silver' | 'default';

export async function persistPaperTrade(
  trade: PaperTrade,
  state: PaperState,
  equityAfter: number,
  agentId: AgentId = 'default'
): Promise<void> {
  if (!isSupabaseConfigured()) return;
  const supabase = getSupabase();
  if (!supabase) return;

  const { error } = await supabase.from('paper_trades').insert({
    agent_id: agentId,
    entry_time: new Date(trade.entryTime * 1000).toISOString(),
    exit_time: new Date(trade.exitTime * 1000).toISOString(),
    symbol: trade.symbol,
    side: trade.side,
    entry_price: trade.entryPrice,
    exit_price: trade.exitPrice,
    qty: trade.qty,
    pnl: trade.pnl,
    pnl_percent: trade.pnlPercent,
    exit_reason: trade.exitReason,
    signal_reason: trade.reason,
    interval: state.risk.interval,
    equity_after: equityAfter,
  });

  if (error) console.warn('persist paper trade failed', error.message);
}

export async function persistParamTune(
  reason: string,
  kpi: AgentKpi,
  oldParams: unknown,
  newParams: unknown,
  agentId: AgentId = 'default'
): Promise<void> {
  if (!isSupabaseConfigured()) return;
  const supabase = getSupabase();
  if (!supabase) return;
  const { error } = await supabase.from('paper_param_history').insert({
    agent_id: agentId,
    reason,
    kpi,
    old_params: oldParams,
    new_params: newParams,
  });
  if (error) console.warn('persist param tune failed', error.message);
}

export async function persistKpiSnapshot(
  kpi: AgentKpi,
  openPositions: number,
  agentId: AgentId = 'default'
): Promise<void> {
  if (!isSupabaseConfigured()) return;
  const supabase = getSupabase();
  if (!supabase) return;
  const { error } = await supabase.from('paper_kpi_snapshots').insert({
    agent_id: agentId,
    capital_start: kpi.capitalStart,
    equity: kpi.equity,
    pnl_percent: kpi.pnlPercent,
    monthly_target_low: kpi.monthlyTargetLow,
    monthly_target_high: kpi.monthlyTargetHigh,
    days_elapsed: kpi.daysElapsed,
    pace_monthly_percent: kpi.paceMonthlyPercent,
    status: kpi.status,
    open_positions: openPositions,
    total_trades: kpi.totalTrades,
    win_rate: kpi.winRate,
  });
  if (error) console.warn('persist kpi failed', error.message);
}

export async function fetchPaperTrades(limit = 50, agentId: AgentId = 'default') {
  if (!isSupabaseConfigured()) return [];
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('paper_trades')
    .select('*')
    .eq('agent_id', agentId)
    .order('exit_time', { ascending: false })
    .limit(limit);
  if (error) {
    console.warn('fetch paper trades failed', error.message);
    return [];
  }
  return data || [];
}

export async function fetchParamHistory(limit = 10, agentId: AgentId = 'default') {
  if (!isSupabaseConfigured()) return [];
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('paper_param_history')
    .select('*')
    .eq('agent_id', agentId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return [];
  return data || [];
}

export async function fetchKpiHistory(limit = 20, agentId: AgentId = 'default') {
  if (!isSupabaseConfigured()) return [];
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('paper_kpi_snapshots')
    .select('*')
    .eq('agent_id', agentId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return [];
  return data || [];
}
