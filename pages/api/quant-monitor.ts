import type { NextApiRequest, NextApiResponse } from 'next';
import { QuantRunResult } from '../../lib/quant/types';
import {
  buildMonitorPrompt,
  buildRiskPayload,
  callNvidiaLLM,
  ruleFallbackReview,
  RiskReviewResult,
} from '../../lib/quant/llmMonitor';
import { getSupabase, isSupabaseConfigured } from '../../lib/supabase';

interface MonitorBody {
  result: QuantRunResult;
  benchmark?: string | null;
  persist?: boolean;
}

async function persistReview(
  payload: RiskReviewResult['payload'],
  review: string,
  source: string
): Promise<string | null> {
  if (!isSupabaseConfigured()) return null;
  const supabase = getSupabase();
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from('quant_reviews')
      .insert({
        interval: payload.metrics.meta.interval,
        asset_count: payload.metrics.meta.assetCount,
        benchmark: payload.metrics.meta.benchmark,
        credibility: payload.credibility,
        source,
        review,
        payload,
        created_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (error) {
      console.warn('quant_reviews insert failed:', error.message);
      return null;
    }
    return data?.id ?? null;
  } catch (err) {
    console.warn('quant_reviews persist error', err);
    return null;
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<RiskReviewResult | { error: string }>
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body as MonitorBody;
  if (!body?.result?.full || !body.result.meta) {
    return res.status(400).json({ error: 'Invalid quant result payload' });
  }

  const payload = buildRiskPayload(body.result, body.benchmark ?? null);

  let review: string;
  let source: RiskReviewResult['source'];

  try {
    review = await callNvidiaLLM(buildMonitorPrompt(payload));
    source = 'llm';
  } catch {
    review = ruleFallbackReview(payload);
    source = 'rule_fallback';
  }

  let savedId: string | null = null;
  if (body.persist !== false) {
    savedId = await persistReview(payload, review, source);
  }

  return res.status(200).json({
    review,
    credibility: payload.credibility,
    flags: payload.flags,
    payload,
    source,
    savedId,
  });
}
