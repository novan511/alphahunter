export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface RSDataPoint {
  time: number;
  rs: number;
  rsMA: number;
  rsUpperBand: number;
  rsLowerBand: number;
  rsZScore: number;
  rsMomentum: number;
}

export interface DecouplingSignal {
  time: number;
  price: number;
  type: 'buy' | 'sell';
  strength: number;
  rsZScore: number;
  indexReturn: number;
  assetReturn: number;
  volumeRatio: number;
  reason: string;
}

export interface ScanConfig {
  indexSymbol: string;
  assetSymbols: string[];
  interval: string;
  lookback: number;
  rsPeriod: number;
  indexThreshold: number;
  volumeMultiplier: number;
  volumePeriod: number;
}

export interface BacktestTrade {
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  side: 'long' | 'short';
  pnl: number;
  pnlPercent: number;
  exitReason: 'stop_loss' | 'take_profit' | 'signal' | 'end_of_data';
}

export interface BacktestResult {
  trades: BacktestTrade[];
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnL: number;
  totalPnLPercent: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  sharpeRatio: number;
  sortinoRatio: number;
  avgHoldBars: number;
  buyHoldReturn: number;
  alpha: number;
}

export interface BacktestConfig {
  initialCapital: number;
  riskPerTrade: number;
  stopLossATR: number;
  takeProfitATR: number;
  maxHoldBars: number;
  useTrailingStop: boolean;
  trailingStopATR: number;
}

export interface AssetScanResult {
  symbol: string;
  currentRSZScore: number;
  rsMomentum: number;
  assetReturn: number;
  indexReturn: number;
  volumeRatio: number;
  signal: DecouplingSignal | null;
  rank: number;
}

export type Interval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

export interface BinanceKline {
  [0]: number;   // open time
  [1]: string;   // open
  [2]: string;   // high
  [3]: string;   // low
  [4]: string;   // close
  [5]: string;   // volume
  [6]: number;   // close time
  [7]: string;   // quote asset volume
  [8]: number;   // number of trades
  [9]: string;   // taker buy base asset volume
  [10]: string;  // taker buy quote asset volume
  [11]: string;  // ignore
}