import type { NextApiRequest, NextApiResponse } from 'next';
import { NVIDIA_API_KEY, NVIDIA_INVOKE_URL } from '../../lib/config';

interface ExplainRequest {
  asset: string;
  regime: string;
  regimeConfidence: number;
  adxValue: number;
  atrPercent: number;
  volPercentile: number;
  timeframes: Array<{
    tf: string;
    trend: string;
    rsZScore: number;
    hasSignal: boolean;
    signalType?: string;
    signalStrength?: number;
    signalPrice?: number;
  }>;
  confluenceScore: number;
  confluenceDirection: string;
  finalSignal: string;
}

function buildPrompt(data: ExplainRequest): string {
  const tfSummary = data.timeframes
    .map((t) => `- ${t.tf}: Trend=${t.trend}, RS Z-Score=${t.rsZScore}${t.hasSignal ? `, Signal=${t.signalType} (strength ${t.signalStrength}, price $${t.signalPrice})` : ''}`)
    .join('\n');

  return `You are a financial analyst explaining market data to a retail investor. Keep it simple, no jargon.

Asset: ${data.asset}
Market Regime: ${data.regime} (${data.regimeConfidence}% confidence)
ADX: ${data.adxValue} | ATR%: ${data.atrPercent}% | Volatility Percentile: ${data.volPercentile}%

Multi-Timeframe Analysis:
${tfSummary}

Confluence Score: ${data.confluenceScore}%
Final Signal: ${data.finalSignal.replace('_', ' ').toUpperCase()}

Explain in 2-3 short sentences (in Indonesian, casual tone) what this means for the investor. Focus on:
1. What the data shows about this asset right now
2. Is it a good time to buy/sell/hold?
3. One simple takeaway

Keep it under 100 words. Use simple language, avoid technical terms.`;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<{ explanation: string } | { error: string }>
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!NVIDIA_API_KEY) {
    return res.status(200).json({
      explanation: `Data menunjukkan ${req.body?.asset || 'aset'} sedang dalam kondisi ${req.body?.confluenceDirection || 'netral'} dengan confluence score ${req.body?.confluenceScore || 0}%. ${req.body?.finalSignal === 'strong_buy' ? 'Ini adalah sinyal BELI yang kuat.' : req.body?.finalSignal === 'buy' ? 'Ada kecenderungan naik.' : req.body?.finalSignal === 'strong_sell' ? 'Ini adalah sinyal JUAL yang kuat.' : req.body?.finalSignal === 'sell' ? 'Ada kecenderungan turun.' : 'Belum ada sinyal yang jelas.'} Gunakan data ini sebagai bahan pertimbangan, bukan satu-satunya acuan keputusan.`,
    });
  }

  const data: ExplainRequest | undefined = req.body;

  if (!data || !data.asset) {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  try {
    const prompt = buildPrompt(data);

    const response = await fetch(NVIDIA_INVOKE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NVIDIA_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: prompt }],
        model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
        max_tokens: 512,
        temperature: 0.6,
        top_p: 0.95,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`NVIDIA API error: ${response.status}`);
    }

    const result = await response.json();
    const explanation = result.choices?.[0]?.message?.content || 'Unable to generate explanation.';

    return res.status(200).json({ explanation });
  } catch (err) {
    const fallbackExplanation = `Data menunjukkan ${data.asset} sedang dalam kondisi ${data.confluenceDirection || 'netral'} dengan confluence score ${data.confluenceScore}%. ${data.finalSignal === 'strong_buy' ? 'Ini adalah sinyal BELI yang kuat.' : data.finalSignal === 'buy' ? 'Ada kecenderungan naik.' : data.finalSignal === 'strong_sell' ? 'Ini adalah sinyal JUAL yang kuat.' : data.finalSignal === 'sell' ? 'Ada kecenderungan turun.' : 'Belum ada sinyal yang jelas.'} Gunakan data ini sebagai bahan pertimbangan, bukan satu-satunya acuan keputusan.`;

    return res.status(200).json({ explanation: fallbackExplanation });
  }
}