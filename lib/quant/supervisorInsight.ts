import { NVIDIA_API_KEY, NVIDIA_INVOKE_URL } from '../config';
import { MarketId } from './marketProfiles';
import { getKpiForAgent } from './autoTune';

export interface DeskSnapshot {
  agentId: MarketId | string;
  running: boolean;
  equity: number;
  cash: number;
  openPositions: number;
  totalTrades: number;
  winRate: number;
  pnlPercent: number;
  paceMonthlyPercent: number;
  kpiStatus: string;
  activity: string;
  updatedAt: number | null;
  monthlyTargetLow: number;
  monthlyTargetHigh: number;
  capitalStart: number;
  recentTrades: Array<{
    symbol: string;
    side: string;
    pnl: number;
    pnlPercent: number;
    exitReason: string;
  }>;
  openList: Array<{
    symbol: string;
    side: string;
    entryPrice: number;
    markPrice?: number;
    unrealizedPnl?: number;
  }>;
  lastActivityLog: string[];
  equityHistory: Array<{ time: number; equity: number }>;
}

export interface SupervisorPayload {
  generatedAt: number;
  desks: DeskSnapshot[];
  portfolio: {
    totalEquity: number;
    totalCapital: number;
    totalPnlPct: number;
    runningDesks: number;
    openPositions: number;
    totalClosedTrades: number;
  };
}

export interface SupervisorInsight {
  insight: string;
  source: 'llm' | 'rule_fallback';
  payload: SupervisorPayload;
  generatedAt: number;
}

export function buildSupervisorPayload(desks: DeskSnapshot[]): SupervisorPayload {
  const totalEquity = desks.reduce((a, d) => a + d.equity, 0);
  const totalCapital = desks.reduce((a, d) => a + d.capitalStart, 0);
  return {
    generatedAt: Date.now(),
    desks,
    portfolio: {
      totalEquity: Math.round(totalEquity * 100) / 100,
      totalCapital,
      totalPnlPct:
        totalCapital > 0
          ? Math.round(((totalEquity - totalCapital) / totalCapital) * 10000) / 100
          : 0,
      runningDesks: desks.filter((d) => d.running).length,
      openPositions: desks.reduce((a, d) => a + d.openPositions, 0),
      totalClosedTrades: desks.reduce((a, d) => a + d.totalTrades, 0),
    },
  };
}

const DESK_LABEL: Record<string, string> = {
  crypto: 'Crypto',
  commodities: 'Commodities',
  'gold-silver': 'Gold & Silver',
};

const EXIT_LABEL: Record<string, string> = {
  stop_loss: 'hit the stop-loss (price moved against us and was cut)',
  take_profit: 'hit take-profit (target reached)',
  time_stop: 'time was up, so the position was closed without a big move',
  dd_halt: 'closed by the drawdown protection brake',
  end_of_data: 'closed at the end of the data window',
  signal: 'closed because a new signal appeared',
};

function money(n: number): string {
  const sign = n >= 0 ? '' : '-';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function pct(n: number): string {
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function prettySymbol(sym: string): string {
  return sym.replace(/^.*:/, '').replace(/USDT$/, '').replace(/=F$/, '');
}

function exitHuman(reason: string): string {
  return EXIT_LABEL[reason] || reason.replace(/_/g, ' ');
}

function deskMood(d: DeskSnapshot): string {
  if (!d.running) return 'offline (not started yet)';
  if (d.kpiStatus === 'critical') return 'in caution mode after a drawdown';
  if (d.pnlPercent > 1) return 'healthy and still green';
  if (d.pnlPercent >= -1) return 'pretty flat — not much movement yet';
  if (d.pnlPercent >= -3) return 'a bit under pressure';
  return 'taking a noticeable hit and needs attention';
}

/**
 * Plain-English briefing for non-specialists. No raw metric dumps.
 */
export function ruleSupervisorFallback(payload: SupervisorPayload): string {
  const p = payload.portfolio;
  const started = payload.desks.filter((d) => d.running);
  const parts: string[] = [];

  if (p.runningDesks === 0) {
    parts.push(
      'No paper-trading bots are running yet. Open Crypto / Commodities / Gold & Silver, hit Start Agent, wait a bit, then refresh this panel.'
    );
    return parts.join('\n\n');
  }

  const diff = p.totalEquity - p.totalCapital;
  const openWord = p.openPositions === 1 ? '1 open position' : `${p.openPositions} open positions`;
  const tradeWord = p.totalClosedTrades === 1 ? '1 closed trade' : `${p.totalClosedTrades} closed trades`;

  parts.push(
    `Big picture: combined paper capital is about ${money(p.totalEquity)} (started from ${money(
      p.totalCapital
    )}), so we are ${diff >= 0 ? 'still above starting capital' : 'a bit below starting capital'} (${pct(
      p.totalPnlPct
    )}). ${started.length} of 3 desks are live, with ${openWord} still open and ${tradeWord} already closed.`
  );

  for (const d of payload.desks) {
    const label = DESK_LABEL[d.agentId] || d.agentId;
    const cfg = getKpiForAgent(d.agentId);
    const target = `+${(cfg.monthlyTargetLow * 100).toFixed(0)}–${(cfg.monthlyTargetHigh * 100).toFixed(
      0
    )}% / month`;

    if (!d.running) {
      parts.push(
        `${label} desk: still idle. Start its agent on that page if you want it included in the briefing.`
      );
      continue;
    }

    const openNames =
      d.openList.length > 0
        ? d.openList.map((o) => prettySymbol(o.symbol)).join(', ')
        : 'nothing';

    let tradeLine = 'No closed trades on this desk yet.';
    if (d.recentTrades.length > 0) {
      const last = d.recentTrades[0];
      const lastWord = last.pnl >= 0 ? 'a small gain' : 'a small loss';
      tradeLine = `Latest trade: ${last.side === 'long' ? 'long' : 'short'} ${prettySymbol(
        last.symbol
      )}, exited with ${lastWord} (${money(last.pnl)}) — ${exitHuman(last.exitReason)}.`;
    }

    const wrNote =
      d.totalTrades >= 5
        ? d.winRate >= 45
          ? 'win rate is still reasonable'
          : d.winRate >= 25
            ? 'win rate is still thin'
            : 'win rate is low — normal if the sample is small'
        : 'not enough closed trades to judge seriously';

    parts.push(
      `${label} desk: ${deskMood(d)}. Equity on this desk is ${money(d.equity)} (${pct(
        d.pnlPercent
      )}). Holding: ${openNames}. Monthly target is ${target}; current pace ${
        d.paceMonthlyPercent >= cfg.monthlyTargetLow * 100
          ? 'is inside the target band'
          : 'is not there yet'
      }. ${wrNote}. ${tradeLine}`
    );
  }

  const allExit = payload.desks.flatMap((d) => d.recentTrades.map((t) => t.exitReason));
  const timeStops = allExit.filter((r) => r === 'time_stop').length;
  const losses = payload.desks.flatMap((d) => d.recentTrades).filter((t) => t.pnl < 0).length;
  const closed = p.totalClosedTrades;

  if (closed > 0 && timeStops >= Math.max(1, Math.floor(allExit.length * 0.5))) {
    parts.push(
      'Interesting pattern: many positions are exiting because time ran out, not because they hit profit or a stop. That often means price went nowhere in the chosen timeframe, or TP/SL are too wide for how long we hold. Worth researching tighter targets or shorter holds.'
    );
  }

  if (closed > 0 && losses > closed * 0.6) {
    parts.push(
      'Most closed trades are still red. That is not automatically a disaster if the sample is small, but it is a signal: do not raise risk yet. Collect more paper data first.'
    );
  }

  if (p.openPositions >= 6) {
    parts.push(
      `Quite a few positions are open at once (${p.openPositions}). Mentally, the book is getting full — if markets reverse together, everything can turn red at the same time.`
    );
  }

  if (closed < 10) {
    parts.push(
      'Honest note: fewer than 10 closed trades so far. This is not enough to call the system profitable. Keep the agents running for days or weeks before drawing conclusions.'
    );
  }

  parts.push(
    'This is an automatic paper-trading research briefing, not buy/sell advice. If NVIDIA_API_KEY is set, the AI version can dig into cross-desk patterns and anomalies as well.'
  );

  return parts.join('\n\n');
}

export function buildSupervisorPrompt(payload: SupervisorPayload): string {
  return `You are a quantitative research supervisor overseeing 3 paper-trading market desks.

Your job: explain results to a smart person who is NOT a full-time trader. Human briefing, not a terminal dump. No metric tables as the opener.

DATA (JSON) — use these numbers, but do not dump them raw on the reader:
${JSON.stringify(payload, null, 2)}

Write in clear English (max ~200 words). Sound like a calm research lead giving a stand-up update.

Cover naturally:
1) Portfolio health in 1-2 sentences
2) Each desk briefly: Crypto / Commodities / Gold & Silver — what is open, why results look like that, dominant exit type
3) Human patterns (e.g. "many exits are time-based, not TP/SL")
4) Calm warnings (small sample, low win rate, crowded book)
5) 2-3 research next steps (not live trade instructions)

HARD RULES:
- Only use numbers present in JSON. Never invent stats.
- Never tell the user to buy or sell real assets.
- Never promise returns.
- If all desks are offline, say that in plain English.
- If totalClosedTrades < 10, say the sample is insufficient.
- Do not start with "PORTFOLIO:", "WR", "pace/mo", or "RUN · PnL". Write like a person.`;
}

export async function callNvidiaForSupervisor(prompt: string): Promise<string> {
  if (!NVIDIA_API_KEY) throw new Error('NVIDIA_API_KEY missing');
  const res = await fetch(NVIDIA_INVOKE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NVIDIA_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
      max_tokens: 700,
      temperature: 0.55,
      top_p: 0.92,
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`NVIDIA ${res.status}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('empty LLM');
  return text;
}

export async function generateSupervisorInsight(
  payload: SupervisorPayload
): Promise<SupervisorInsight> {
  let insight: string;
  let source: SupervisorInsight['source'] = 'llm';
  try {
    insight = await callNvidiaForSupervisor(buildSupervisorPrompt(payload));
  } catch {
    insight = ruleSupervisorFallback(payload);
    source = 'rule_fallback';
  }
  return { insight, source, payload, generatedAt: Date.now() };
}
