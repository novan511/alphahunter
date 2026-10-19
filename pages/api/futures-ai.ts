import type { NextApiRequest, NextApiResponse } from 'next';
import { analyzeFutures, ruleFallback, type FuturesAIInput, type FuturesAIOutput } from '../../lib/quant/futuresAI';

const MAX_INPUT = 8;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<{ results: FuturesAIOutput[]; errors: string[] } | { error: string }>
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const inputs: unknown = req.body;
  if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > MAX_INPUT) {
    return res.status(400).json({ error: `Body harus array 1-${MAX_INPUT} instrumen` });
  }

  const results: FuturesAIOutput[] = [];
  const errors: string[] = [];

  for (const raw of inputs) {
    const input = raw as FuturesAIInput;
    if (!input || typeof input.symbol !== 'string' || !input.price) {
      errors.push(`${String(raw?.symbol ?? input?.symbol ?? '?')}: input tidak lengkap`);
      continue;
    }
    try {
      const result = await analyzeFutures(input);
      results.push(result);
    } catch (err) {
      errors.push(`${input.symbol}: ${err instanceof Error ? err.message : 'gagal dianalisis'}`);
      results.push(ruleFallback(input));
    }
  }

  return res.status(200).json({ results, errors });
}
