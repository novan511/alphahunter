import type { NextApiRequest, NextApiResponse } from 'next';
import { Candle, BacktestResult, BacktestConfig, ScanConfig } from '../../lib/types';
import { fetchBinanceKlines } from '../../lib/api';
import { detectDecoupling } from '../../lib/algorithms/decouplingDetector';
import { runBacktest } from '../../lib/algorithms/backtestEngine';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<{ signals: any[]; backtest: BacktestResult } | { error: string }>
) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    indexSymbol = 'BTCUSDT',
    assetSymbol = 'ETHUSDT',
    interval = '4h',
    limit = '500',
    lookback = '6',
    rsPeriod = '20',
    indexThreshold = '0.02',
    volumeMultiplier = '1.5',
    volumePeriod = '20',
    initialCapital = '10000',
    riskPerTrade = '0.02',
    stopLossATR = '2.0',
    takeProfitATR = '3.0',
    maxHoldBars = '24',
    useTrailingStop = 'true',
    trailingStopATR = '1.5',
    feeRate = '0.001',
    slippage = '0.0005',
  } = req.query;

  const scanConfig: ScanConfig = {
    indexSymbol: (indexSymbol as string).toUpperCase(),
    assetSymbols: [(assetSymbol as string).toUpperCase()],
    interval: interval as string,
    lookback: parseInt(lookback as string, 10),
    rsPeriod: parseInt(rsPeriod as string, 10),
    indexThreshold: parseFloat(indexThreshold as string),
    volumeMultiplier: parseFloat(volumeMultiplier as string),
    volumePeriod: parseInt(volumePeriod as string, 10),
  };

  const btConfig: BacktestConfig = {
    initialCapital: parseFloat(initialCapital as string),
    riskPerTrade: parseFloat(riskPerTrade as string),
    stopLossATR: parseFloat(stopLossATR as string),
    takeProfitATR: parseFloat(takeProfitATR as string),
    maxHoldBars: parseInt(maxHoldBars as string, 10),
    useTrailingStop: useTrailingStop === 'true',
    trailingStopATR: parseFloat(trailingStopATR as string),
    feeRate: parseFloat(feeRate as string),
    slippage: parseFloat(slippage as string),
    interval: scanConfig.interval,
  };

  try {
    const parsedLimit = Math.min(Math.max(parseInt(limit as string, 10) || 500, 200), 1000);

    const [indexCandles, assetCandles] = await Promise.all([
      fetchBinanceKlines(scanConfig.indexSymbol, scanConfig.interval, parsedLimit),
      fetchBinanceKlines((assetSymbol as string).toUpperCase(), scanConfig.interval, parsedLimit),
    ]);

    const minLength = Math.min(assetCandles.length, indexCandles.length);
    const trimmedAsset = assetCandles.slice(-minLength);
    const trimmedIndex = indexCandles.slice(-minLength);

    const signals = detectDecoupling(trimmedAsset, trimmedIndex, scanConfig);
    const backtestResult = runBacktest(trimmedAsset, trimmedIndex, signals, btConfig);

    return res.status(200).json({
      signals,
      backtest: backtestResult,
    });
  } catch (err) {
    return res.status(500).json({
      error: `Backtest failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
    });
  }
}