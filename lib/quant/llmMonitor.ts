import { NVIDIA_API_KEY, NVIDIA_INVOKE_URL } from '../config';
import { QuantRunResult } from './types';

export interface SampleFlags {
  minTrades: number;
  fullTrades: number;
  oosTrades: number;
  oosExpectancyR: number;
  oosPositiveWindows: number;
  oosWindowsTotal: number;
  ddHalt: boolean;
  insufficientSample: boolean;
  oosEdgeConfirmed: boolean;
  credibility: 'credible' | 'weak' | 'insufficient' | 'rejected';
}

export interface RiskReviewPayload {
  credibility: SampleFlags['credibility'];
  flags: SampleFlags;
  metrics: {
    full: {
      profitFactor: number;
      sharpeRatio: number;
      sortinoRatio: number;
      maxDrawdownPercent: number;
      totalPnLPercent: number;
      winRate: number;
      totalTrades: number;
      expectancyR: number;
      exposurePctAvg: number;
      alpha: number;
      haltedByDd: boolean;
    };
    oos: {
      avgProfitFactor: number;
      avgSharpe: number;
      avgMaxDrawdownPercent: number;
      avgTotalPnLPercent: number;
      avgExpectancyR: number;
      windowsWithPositiveEdge: number;
      windowsTotal: number;
      totalTrades: number;
    };
    meta: {
      interval: string;
      assetCount: number;
      benchmark: string | null;
      generatedAt: number;
    };
  };
}

export interface RiskReviewResult {
  review: string;
  credibility: SampleFlags['credibility'];
  flags: SampleFlags;
  payload: RiskReviewPayload;
  source: 'llm' | 'rule_fallback';
  savedId?: string | null;
}

const MIN_TRADES = 30;

export function computeSampleFlags(result: QuantRunResult): SampleFlags {
  const fullTrades = result.full?.totalTrades ?? 0;
  const oos = result.walkForward?.oosAggregate;
  const oosTrades = oos?.totalTrades ?? 0;
  const oosExpectancyR = oos?.avgExpectancyR ?? 0;
  const oosPositiveWindows = oos?.windowsWithPositiveEdge ?? 0;
  const oosWindowsTotal = oos?.windowsTotal ?? 0;
  const ddHalt = Boolean(result.full?.haltedByDd);

  const insufficientSample = fullTrades < MIN_TRADES || oosTrades < MIN_TRADES;
  const oosEdgeConfirmed =
    !insufficientSample &&
    oosExpectancyR > 0 &&
    oosWindowsTotal > 0 &&
    oosPositiveWindows / oosWindowsTotal >= 0.5;

  let credibility: SampleFlags['credibility'] = 'weak';
  if (insufficientSample) credibility = 'insufficient';
  else if (!oosEdgeConfirmed && (result.full?.profitFactor ?? 0) >= 1.2) credibility = 'rejected';
  else if (oosEdgeConfirmed && (result.full?.profitFactor ?? 0) >= 1.1) credibility = 'credible';
  else if (oosEdgeConfirmed) credibility = 'weak';

  return {
    minTrades: MIN_TRADES,
    fullTrades,
    oosTrades,
    oosExpectancyR,
    oosPositiveWindows,
    oosWindowsTotal,
    ddHalt,
    insufficientSample,
    oosEdgeConfirmed,
    credibility,
  };
}

export function buildRiskPayload(
  result: QuantRunResult,
  benchmark: string | null
): RiskReviewPayload {
  const flags = computeSampleFlags(result);
  return {
    credibility: flags.credibility,
    flags,
    metrics: {
      full: {
        profitFactor: result.full.profitFactor,
        sharpeRatio: result.full.sharpeRatio,
        sortinoRatio: result.full.sortinoRatio,
        maxDrawdownPercent: result.full.maxDrawdownPercent,
        totalPnLPercent: result.full.totalPnLPercent,
        winRate: result.full.winRate,
        totalTrades: result.full.totalTrades,
        expectancyR: result.full.expectancyR,
        exposurePctAvg: result.full.exposurePctAvg,
        alpha: result.full.alpha,
        haltedByDd: result.full.haltedByDd,
      },
      oos: {
        avgProfitFactor: result.walkForward?.oosAggregate.avgProfitFactor ?? 0,
        avgSharpe: result.walkForward?.oosAggregate.avgSharpe ?? 0,
        avgMaxDrawdownPercent: result.walkForward?.oosAggregate.avgMaxDrawdownPercent ?? 0,
        avgTotalPnLPercent: result.walkForward?.oosAggregate.avgTotalPnLPercent ?? 0,
        avgExpectancyR: result.walkForward?.oosAggregate.avgExpectancyR ?? 0,
        windowsWithPositiveEdge:
          result.walkForward?.oosAggregate.windowsWithPositiveEdge ?? 0,
        windowsTotal: result.walkForward?.oosAggregate.windowsTotal ?? 0,
        totalTrades: result.walkForward?.oosAggregate.totalTrades ?? 0,
      },
      meta: {
        interval: result.meta.interval,
        assetCount: result.meta.assetCount,
        benchmark,
        generatedAt: result.meta.generatedAt,
      },
    },
  };
}

export function ruleFallbackReview(payload: RiskReviewPayload): string {
  const f = payload.flags;
  const lines: string[] = [
    `Credibility: ${f.credibility.toUpperCase()}`,
    `Full trades: ${f.fullTrades} | OOS trades: ${f.oosTrades} (min ${f.minTrades})`,
    `OOS expectancy R: ${f.oosExpectancyR} | positive windows: ${f.oosPositiveWindows}/${f.oosWindowsTotal}`,
    `Full PF: ${payload.metrics.full.profitFactor} | MaxDD: ${payload.metrics.full.maxDrawdownPercent}% | DD halt: ${f.ddHalt ? 'YES' : 'no'}`,
  ];

  if (f.insufficientSample) {
    lines.push(
      'Verdict: INSUFFICIENT SAMPLE — do not treat full-sample PF as edge. Expand history or loosen filters carefully.'
    );
  } else if (!f.oosEdgeConfirmed) {
    lines.push(
      'Verdict: OOS NOT CONFIRMED — in-sample strength did not hold out of sample. Research only; no live sizing.'
    );
  } else if (f.credibility === 'credible') {
    lines.push(
      'Verdict: WEAKLY CREDIBLE — OOS supports a positive expectancy with majority positive windows. Still paper-trade before capital.'
    );
  } else {
    lines.push('Verdict: MIXED — review window-level OOS before any allocation.');
  }

  lines.push('This is a rule-based risk note, not financial advice, not a trade instruction.');
  return lines.join('\n');
}

export function buildMonitorPrompt(payload: RiskReviewPayload): string {
  return `You are a senior systematic risk analyst for a quant research desk.
You review backtest quality. You do NOT give buy/sell instructions.

METRICS_JSON:
${JSON.stringify(payload, null, 2)}

HARD RULES:
- Use ONLY numbers present in METRICS_JSON. Never invent stats.
- If flags.insufficientSample is true → credibility must be insufficient sample.
- If OOS expectancy <= 0 or majority OOS windows not positive → do NOT call the edge confirmed.
- Never instruct the user to open, close, or size a live trade.
- Never promise returns.

OUTPUT (Bahasa Indonesia, plain text, max 180 words):
1) Verdict: CREDIBLE / WEAK / INSUFFICIENT / REJECTED
2) 3 risiko utama sample
3) IS vs OOS: apakah edge bertahan
4) Satu aksi riset berikutnya (bukan eksekusi live)
5) Disclaimer singkat: research only

Write clearly for a trader who will not deploy capital on LLM opinion alone.`;
}

export async function callNvidiaLLM(prompt: string): Promise<string> {
  if (!NVIDIA_API_KEY) {
    throw new Error('NVIDIA_API_KEY missing');
  }
  const response = await fetch(NVIDIA_INVOKE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NVIDIA_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
      max_tokens: 700,
      temperature: 0.3,
      top_p: 0.9,
      stream: false,
    }),
  });
  if (!response.ok) {
    throw new Error(`NVIDIA API error: ${response.status}`);
  }
  const result = await response.json();
  const text = result.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('Empty LLM response');
  return text;
}
