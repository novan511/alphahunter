import type { NextApiRequest, NextApiResponse } from 'next';
import { Candle } from '../../lib/types';
import { fetchKlinesRouted } from '../../lib/universe';
import { runMLBacktest } from '../../lib/ml/backtest';

interface MLBacktestResponse {
  symbol: string;
  interval: string;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalReturnPercent: number;
  profitFactor: number;
  maxDrawdownPercent: number;
  expectancyR: number;
  avgBarsHeld: number;
  equityCurve: Array<{ time: number; equity: number }>;
  trades: any[];
  tradesByMonth: any[];
  error?: string;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<MLBacktestResponse>
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed', symbol: '', interval: '', totalTrades: 0, winningTrades: 0, losingTrades: 0, winRate: 0, totalReturnPercent: 0, profitFactor: 0, maxDrawdownPercent: 0, expectancyR: 0, avgBarsHeld: 0, equityCurve: [], trades: [], tradesByMonth: [] });
  }

  const { symbol = 'SOLUSDT', interval = '4h', lookback = '2000' } = req.query;
  const sym = (symbol as string).toUpperCase().replace(/USDT$/, '') + 'USDT';
  const iv = interval as string;
  const parsedLimit = Math.min(Math.max(parseInt(lookback as string, 10) || 2000, 200), 5000);

  try {
    const [assetCandles, btcCandles] = await Promise.all([
      fetchKlinesRouted(sym, iv, parsedLimit),
      fetchKlinesRouted('BTCUSDT', iv, parsedLimit),
    ]);

    if (assetCandles.length < 100 || btcCandles.length < 100) {
      return res.status(400).json({
        error: 'Insufficient candle data',
        symbol: sym,
        interval: iv,
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        winRate: 0,
        totalReturnPercent: 0,
        profitFactor: 0,
        maxDrawdownPercent: 0,
        expectancyR: 0,
        avgBarsHeld: 0,
        equityCurve: [],
        trades: [],
        tradesByMonth: [],
      });
    }

    const config = {
      initialCapital: 1000,
      riskPerTrade: 0.01,
      stopLossATR: 2.0,
      takeProfitATR: 2.5,
      maxHoldBars: 30,
      probThreshold: 0.55,
      regimeFilter: 'bull_only',
      feeRate: 0.001,
      slippage: 0.0005,
    };

    const result = await runMLBacktest(sym, iv, assetCandles, btcCandles, config);

    return res.status(200).json({
      symbol: result.symbol,
      interval: result.interval,
      totalTrades: result.totalTrades,
      winningTrades: result.winningTrades,
      losingTrades: result.losingTrades,
      winRate: result.winRate,
      totalReturnPercent: result.totalReturnPercent,
      profitFactor: result.profitFactor,
      maxDrawdownPercent: result.maxDrawdownPercent,
      expectancyR: result.expectancyR,
      avgBarsHeld: result.avgBarsHeld,
      equityCurve: result.equityCurve,
      trades: result.trades,
      tradesByMonth: result.tradesByMonth,
    });
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Unknown error',
      symbol: sym,
      interval: iv,
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRate: 0,
      totalReturnPercent: 0,
      profitFactor: 0,
      maxDrawdownPercent: 0,
      expectancyR: 0,
      avgBarsHeld: 0,
      equityCurve: [],
      trades: [],
      tradesByMonth: [],
    });
  }
}
