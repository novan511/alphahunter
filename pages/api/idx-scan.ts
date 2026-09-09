import type { NextApiRequest, NextApiResponse } from 'next';
import { Candle, ScanConfig } from '../../lib/types';
import { ALL_IDX_TICKERS, getYahooParams } from '../../lib/idxConfig';
import { detectDecoupling } from '../../lib/algorithms/decouplingDetector';
import { calculateRSData } from '../../lib/algorithms/relativeStrength';
import { sma } from '../../lib/algorithms/indicators';

interface YahooChartResult {
  chart: {
    result: Array<{
      timestamp: number[];
      indicators: {
        quote: Array<{
          open: number[];
          high: number[];
          low: number[];
          close: number[];
          volume: number[];
        }>;
      };
    }>;
    error: string | null;
  };
}

function toYahooSymbol(symbol: string): string {
  if (symbol.startsWith('^')) return symbol;
  if (symbol.includes('.')) return symbol;
  return `${symbol}.JK`;
}

async function fetchYahooChart(
  symbol: string,
  interval: string,
  range: string
): Promise<Candle[]> {
  const yahooSymbol = toYahooSymbol(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${interval}&range=${range}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });

  if (!res.ok) {
    throw new Error(`Yahoo Finance error for ${symbol}: ${res.status}`);
  }

  const data: YahooChartResult = await res.json();

  if (data.chart.error) {
    throw new Error(`Yahoo Finance: ${data.chart.error}`);
  }

  const result = data.chart.result?.[0];
  if (!result) return [];

  const timestamps = result.timestamp;
  const quote = result.indicators.quote[0];

  if (!timestamps || !quote) return [];

  const candles: Candle[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const o = quote.open?.[i];
    const h = quote.high?.[i];
    const l = quote.low?.[i];
    const c = quote.close?.[i];
    const v = quote.volume?.[i];

    if (o == null || h == null || l == null || c == null) continue;

    candles.push({
      time: timestamps[i],
      open: o,
      high: h,
      low: l,
      close: c,
      volume: v || 0,
    });
  }

  return candles;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface IDXScanResult {
  ticker: string;
  name: string;
  sector: string;
  currentRSZScore: number;
  rsMomentum: number;
  stockReturn: number;
  indexReturn: number;
  volumeRatio: number;
  signal: {
    type: 'buy' | 'sell';
    strength: number;
    rsZScore: number;
    indexReturn: number;
    assetReturn: number;
    volumeRatio: number;
    reason: string;
  } | null;
  rank: number;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<IDXScanResult[] | { error: string }>
) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    tickers,
    interval = '1d',
    lookback = '6',
    indexThreshold = '0.02',
    volumeMultiplier = '1.5',
    volumePeriod = '20',
  } = req.query;

  const tickerList = tickers && typeof tickers === 'string'
    ? tickers.split(',').map((t) => t.trim().toUpperCase())
    : ALL_IDX_TICKERS;

  const config: ScanConfig = {
    indexSymbol: '^JKSE',
    assetSymbols: tickerList,
    interval: interval as string,
    lookback: parseInt(lookback as string, 10),
    rsPeriod: 20,
    indexThreshold: parseFloat(indexThreshold as string),
    volumeMultiplier: parseFloat(volumeMultiplier as string),
    volumePeriod: parseInt(volumePeriod as string, 10),
  };

  try {
    const yahooParams = getYahooParams(interval as string);

    let indexCandles: Candle[];
    try {
      indexCandles = await fetchYahooChart('^JKSE', yahooParams.yahooInterval, yahooParams.yahooRange);
    } catch (err) {
      console.error('Failed to fetch IHSG index:', err);
      indexCandles = [];
    }

    if (indexCandles.length === 0) {
      return res.status(200).json([]);
    }

    const results: IDXScanResult[] = [];

    for (let i = 0; i < tickerList.length; i += 3) {
      const batch = tickerList.slice(i, i + 3);

      const batchResults = await Promise.allSettled(
        batch.map(async (ticker) => {
          try {
            await sleep(300);
            const stockCandles = await fetchYahooChart(ticker, yahooParams.yahooInterval, yahooParams.yahooRange);

            if (stockCandles.length < 30 || indexCandles.length < 30) {
              return null;
            }

            const minLen = Math.min(stockCandles.length, indexCandles.length);
            const trimmedStock = stockCandles.slice(-minLen);
            const trimmedIndex = indexCandles.slice(-minLen);

            const signals = detectDecoupling(trimmedStock, trimmedIndex, config);

            const rsData = calculateRSData(trimmedStock, trimmedIndex, config.rsPeriod);
            const lastRS = rsData[rsData.length - 1];

            const stockCloses = trimmedStock.map((c) => c.close);
            const indexCloses = trimmedIndex.map((c) => c.close);

            const stockReturns = stockCloses.map((close, idx) => {
              if (idx < config.lookback) return 0;
              return (close - stockCloses[idx - config.lookback]) / stockCloses[idx - config.lookback];
            });

            const indexReturns = indexCloses.map((close, idx) => {
              if (idx < config.lookback) return 0;
              return (close - indexCloses[idx - config.lookback]) / indexCloses[idx - config.lookback];
            });

            const volumes = trimmedStock.map((c) => c.volume);
            const volMA = sma(volumes, config.volumePeriod);
            const lastVolMA = volMA[volMA.length - 1];
            const lastVol = trimmedStock[trimmedStock.length - 1].volume;

            const latestSignal = signals.length > 0 ? signals[signals.length - 1] : null;

            return {
              ticker,
              name: '',
              sector: '',
              currentRSZScore: Math.round(lastRS.rsZScore * 100) / 100,
              rsMomentum: Math.round(lastRS.rsMomentum * 10000) / 10000,
              stockReturn: Math.round(stockReturns[stockReturns.length - 1] * 10000) / 100,
              indexReturn: Math.round(indexReturns[indexReturns.length - 1] * 10000) / 100,
              volumeRatio: lastVolMA > 0 ? Math.round((lastVol / lastVolMA) * 100) / 100 : 0,
              signal: latestSignal ? {
                type: latestSignal.type,
                strength: latestSignal.strength,
                rsZScore: latestSignal.rsZScore,
                indexReturn: latestSignal.indexReturn,
                assetReturn: latestSignal.assetReturn,
                volumeRatio: latestSignal.volumeRatio,
                reason: latestSignal.reason,
              } : null,
              rank: 0,
            };
          } catch (err) {
            console.error(`Error scanning ${ticker}:`, err);
            return null;
          }
        })
      );

      for (const r of batchResults) {
        if (r.status === 'fulfilled' && r.value !== null) {
          results.push(r.value);
        }
      }

      if (i + 3 < tickerList.length) {
        await sleep(500);
      }
    }

    results.sort((a, b) => {
      const scoreA = a.currentRSZScore * 0.4 + a.rsMomentum * 100 * 0.3 + a.volumeRatio * 0.3;
      const scoreB = b.currentRSZScore * 0.4 + b.rsMomentum * 100 * 0.3 + b.volumeRatio * 0.3;
      return scoreB - scoreA;
    });

    results.forEach((r, i) => {
      r.rank = i + 1;
    });

    return res.status(200).json(results);
  } catch (err) {
    return res.status(500).json({
      error: `IDX scan failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
    });
  }
}