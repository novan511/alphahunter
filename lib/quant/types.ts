import { Candle, DecouplingSignal } from '../types';

export interface QuantRiskConfig {
  initialCapital: number;
  /** Max fraction of equity risked per trade (0.005 = 0.5%). */
  riskPerTrade: number;
  stopLossATR: number;
  takeProfitATR: number;
  maxHoldBars: number;
  feeRate: number;
  slippage: number;
  maxConcurrentPositions: number;
  /** Max gross exposure as fraction of equity (0.4 = 40%). */
  maxExposurePct: number;
  /** Halt new entries if portfolio drawdown exceeds this (0.1 = 10%). */
  maxPortfolioDrawdownPct: number;
  /** Only take signals with strength >= this. */
  minSignalStrength: number;
  /** Long-only is spot-realistic and lower risk. */
  allowShort: boolean;
  interval: string;
}

export interface QuantSignalEvent {
  time: number;
  symbol: string;
  type: 'buy' | 'sell';
  price: number;
  strength: number;
  reason: string;
}

export interface PortfolioPosition {
  symbol: string;
  side: 'long' | 'short';
  entryTime: number;
  entryPrice: number;
  entryATR: number;
  qty: number;
  stopLoss: number;
  takeProfit: number;
  barsHeld: number;
  signalStrength: number;
}

export interface PortfolioTrade {
  symbol: string;
  side: 'long' | 'short';
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  pnl: number;
  pnlPercent: number;
  returnOnRisk: number;
  barsHeld: number;
  exitReason: 'stop_loss' | 'take_profit' | 'time_stop' | 'signal' | 'dd_halt' | 'end_of_data';
}

export interface EquityPoint {
  time: number;
  equity: number;
  exposure: number;
  positions: number;
}

export interface PortfolioBacktestResult {
  trades: PortfolioTrade[];
  equityCurve: EquityPoint[];
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnL: number;
  totalPnLPercent: number;
  profitFactor: number;
  maxDrawdownPercent: number;
  calmarRatio: number;
  sharpeRatio: number;
  sortinoRatio: number;
  avgHoldBars: number;
  avgWinR: number;
  avgLossR: number;
  expectancyR: number;
  exposurePctAvg: number;
  maxConcurrentSeen: number;
  buyHoldReturn: number;
  alpha: number;
  haltedByDd: boolean;
  signalsSeen: number;
  signalsTaken: number;
}

export interface WalkForwardWindow {
  label: string;
  startIndex: number;
  endIndex: number;
  isStart: number;
  isEnd: number;
  oosStart: number;
  oosEnd: number;
  inSample: PortfolioBacktestResult | null;
  outOfSample: PortfolioBacktestResult | null;
}

export interface WalkForwardResult {
  windows: WalkForwardWindow[];
  oosAggregate: {
    totalTrades: number;
    avgProfitFactor: number;
    avgSharpe: number;
    avgSortino: number;
    avgMaxDrawdownPercent: number;
    avgTotalPnLPercent: number;
    avgExpectancyR: number;
    windowsWithPositiveEdge: number;
    windowsTotal: number;
  };
}

export interface QuantAssetData {
  symbol: string;
  candles: Candle[];
  signals: DecouplingSignal[];
}

export interface QuantRunInput {
  assets: QuantAssetData[];
  indexCandles: Candle[];
  risk: QuantRiskConfig;
  /** Fraction of timeline used as in-sample (rest is OOS per window). */
  walkForward?: boolean;
  oosWindows?: number;
}

export interface QuantRunResult {
  full: PortfolioBacktestResult;
  walkForward: WalkForwardResult | null;
  meta: {
    assetCount: number;
    candleCount: number;
    interval: string;
    generatedAt: number;
  };
}
