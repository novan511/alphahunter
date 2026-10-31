import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs';
import path from 'path';

interface ModelInfo {
  symbol: string;
  interval: string;
  trained_at?: string;
  forward_bars?: number;
  regime_filter?: string;
  prob_threshold?: number;
  gates_passed?: boolean;
  oos_metrics?: any;
  file_exists: boolean;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ModelInfo[] | { error: string }>
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const modelDir = path.join(process.cwd(), 'ml/models');
  const publicDir = path.join(process.cwd(), 'public', 'ml', 'models');

  // Known models from presets / training runs
  const candidates: Array<{ symbol: string; interval: string }> = [
    { symbol: 'SOLUSDT', interval: '4h' },
    { symbol: 'ETHUSDT', interval: '4h' },
    { symbol: 'BTCUSDT', interval: '4h' },
    { symbol: 'BNBUSDT', interval: '4h' },
    { symbol: 'XRPUSDT', interval: '4h' },
  ];

  const results: ModelInfo[] = [];

  for (const c of candidates) {
    const fileName = `${c.symbol}_${c.interval}`;
    const srcExists = fs.existsSync(path.join(modelDir, `${fileName}.json`));
    const pubExists = fs.existsSync(path.join(publicDir, `${fileName}.meta.json`));

    let meta: any = null;
    if (pubExists) {
      try {
        meta = JSON.parse(fs.readFileSync(path.join(publicDir, `${fileName}.meta.json`), 'utf8'));
      } catch {
        meta = null;
      }
    }

    results.push({
      symbol: c.symbol,
      interval: c.interval,
      trained_at: meta?.trained_at,
      forward_bars: meta?.forward_bars,
      regime_filter: meta?.regime_filter,
      prob_threshold: meta?.prob_threshold,
      gates_passed: meta?.gates_passed,
      oos_metrics: meta?.oos_metrics,
      file_exists: srcExists && pubExists,
    });
  }

  // Sort: trained models first, then by trained_at desc
  results.sort((a, b) => {
    if (b.file_exists !== a.file_exists) return b.file_exists ? 1 : -1;
    if (!a.trained_at || !b.trained_at) return 0;
    return new Date(b.trained_at).getTime() - new Date(a.trained_at).getTime();
  });

  return res.status(200).json(results);
}
