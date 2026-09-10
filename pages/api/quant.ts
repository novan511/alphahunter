import type { NextApiRequest, NextApiResponse } from 'next';
import { parseRiskFromQuery } from '../../lib/quant/risk';
import { loadQuantUniverse, resolveUniverseFromQuery } from '../../lib/quant/catalog';
import { runPortfolioBacktest } from '../../lib/quant/portfolioBacktest';
import { runWalkForward } from '../../lib/quant/walkForward';
import { QuantRiskConfig, QuantRunResult } from '../../lib/quant/types';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<QuantRunResult & { errors?: string[]; benchmark?: string | null } | { error: string }>
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const universe = resolveUniverseFromQuery(req.query);
  const risk: QuantRiskConfig = {
    ...parseRiskFromQuery(req.query as Record<string, string | string[] | undefined>),
    interval: universe.interval,
  };

  const limitRaw = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 800;
  const deep = req.query.deep === 'true' || limitRaw > 800;
  const limit = Math.min(Math.max(limitRaw || 800, 120), deep ? 2500 : 1000);
  const walkForward = req.query.walkForward !== 'false';
  const oosWindows =
    typeof req.query.oosWindows === 'string' ? parseInt(req.query.oosWindows, 10) : 3;

  try {
    const { assets, benchmarkCandles, errors } = await loadQuantUniverse(
      universe.assets,
      universe.benchmark,
      universe.interval,
      limit,
      deep
    );

    if (assets.length === 0) {
      return res.status(502).json({
        error: `No market data loaded. ${errors.slice(0, 3).join('; ') || 'Empty universe'}`,
      });
    }

    const full = runPortfolioBacktest(assets, risk);
    const wf = walkForward ? runWalkForward(assets, risk, { oosWindows }) : null;

    const step = Math.max(1, Math.floor(full.equityCurve.length / 400));
    const trimCurve = full.equityCurve.filter((_, i) => i % step === 0);

    const result: QuantRunResult & { errors?: string[]; benchmark?: string | null } = {
      full: { ...full, equityCurve: trimCurve, trades: full.trades.slice(-200) },
      walkForward: wf
        ? {
            windows: wf.windows.map((w) => ({
              ...w,
              inSample: w.inSample
                ? { ...w.inSample, equityCurve: [], trades: w.inSample.trades.slice(0, 20) }
                : null,
              outOfSample: w.outOfSample
                ? { ...w.outOfSample, equityCurve: [], trades: w.outOfSample.trades.slice(0, 20) }
                : null,
            })),
            oosAggregate: wf.oosAggregate,
          }
        : null,
      meta: {
        assetCount: assets.length,
        candleCount: assets[0]?.candles.length || 0,
        interval: universe.interval,
        generatedAt: Date.now(),
      },
      errors,
      benchmark: universe.benchmark?.id ?? null,
    };

    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Quant run failed',
    });
  }
}
