import { ScanConfig, BacktestConfig, Interval } from './types';

export const DEFAULT_SCAN_CONFIG: ScanConfig = {
  indexSymbol: 'BTCUSDT',
  assetSymbols: [
    'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT',
    'DOGEUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT', 'MATICUSDT',
    'UNIUSDT', 'LTCUSDT', 'ATOMUSDT', 'NEARUSDT', 'FTMUSDT',
    'ALGOUSDT', 'SANDUSDT', 'MANAUSDT', 'AXSUSDT', 'GALAUSDT',
  ],
  interval: '4h',
  lookback: 6,
  rsPeriod: 20,
  indexThreshold: 0.02,
  volumeMultiplier: 1.5,
  volumePeriod: 20,
};

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  initialCapital: 10000,
  riskPerTrade: 0.02,
  stopLossATR: 2.0,
  takeProfitATR: 3.0,
  maxHoldBars: 24,
  useTrailingStop: true,
  trailingStopATR: 1.5,
};

export const AVAILABLE_INTERVALS: { value: Interval; label: string }[] = [
  { value: '1h', label: '1 Hour' },
  { value: '4h', label: '4 Hours' },
  { value: '1d', label: '1 Day' },
];

export interface AssetCategory {
  name: string;
  symbols: string[];
}

export const ASSET_UNIVERSE: AssetCategory[] = [
  {
    name: 'Layer 1',
    symbols: [
      'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'ADAUSDT', 'AVAXUSDT',
      'DOTUSDT', 'NEARUSDT', 'ATOMUSDT', 'FTMUSDT', 'ALGOUSDT',
      'APTUSDT', 'SUIUSDT', 'SEIUSDT', 'TIAUSDT', 'KASUSDT',
      'HBARUSDT', 'VETUSDT', 'ICPUSDT', 'EOSUSDT', 'XLMUSDT',
      'TRXUSDT', 'THETAUSDT', 'FILUSDT', 'ARUSDT', 'MINAUSDT',
    ],
  },
  {
    name: 'DeFi',
    symbols: [
      'UNIUSDT', 'AAVEUSDT', 'MKRUSDT', 'COMPUSDT', 'SNXUSDT',
      'CRVUSDT', 'SUSHIUSDT', 'YFIUSDT', 'RUNEUSDT', 'DYDXUSDT',
      'GMXUSDT', 'PENDLEUSDT', '1INCHUSDT', 'LDOUSDT', 'RPLUSDT',
      'JOEUSDT', 'STGUSDT', 'VETUSDT', 'FLRUSDT',
    ],
  },
  {
    name: 'AI / Data',
    symbols: [
      'FETUSDT', 'RENDERUSDT', 'OCEANUSDT', 'TAOUSDT', 'WLDUSDT',
      'AKTUSDT', 'NMRUSDT', 'GRTUSDT', 'RNDRUSDT', 'CGLCUSDT',
      'AIUSDT', 'TRACUSDT', 'DATAUSDT', 'OLUSDT',
    ],
  },
  {
    name: 'Meme',
    symbols: [
      'DOGEUSDT', 'SHIBUSDT', 'PEPEUSDT', 'WIFUSDT', 'FLOKIUSDT',
      'BONKUSDT', '1000RATSUSDT', '1000PEPEUSDT', 'MEMEUSDT', 'TURBOUSDT',
      'BRETTUSDT', 'MOGUSDT', 'POPCATUSDT', 'NEIROUSDT',
    ],
  },
  {
    name: 'Gaming / Metaverse',
    symbols: [
      'SANDUSDT', 'MANAUSDT', 'AXSUSDT', 'GALAUSDT', 'ENJUSDT',
      'IMXUSDT', 'GXSUSDT', 'ILVUSDT', 'PYRUSDT', 'ALICEUSDT',
      'TLMUSDT', 'UFOUSDT', 'HEROUSDT', 'GHSTUSDT',
    ],
  },
  {
    name: 'Infrastructure',
    symbols: [
      'LINKUSDT', 'MATICUSDT', 'ARBUSDT', 'OPUSDT', 'INJUSDT',
      'KAVAUSDT', 'ZILUSDT', 'DOTUSDT', 'CKBUSDT', 'SCUSDT',
      'ANKRUSDT', 'PHAUSDT', 'MASKUSDT', 'C98USDT',
    ],
  },
  {
    name: 'Storage / Computing',
    symbols: [
      'FILUSDT', 'ARUSDT', 'SCUSDT', 'STORJUSDT', 'ANKRUSDT',
      'CLOREUSDT', 'RNDRUSDT', 'AKTUSDT', 'OLUSDT',
    ],
  },
  {
    name: 'Exchange Token',
    symbols: [
      'BNBUSDT', 'CROUSDT', 'GTUSDT', 'MXUSDT', 'OKBUSDT',
    ],
  },
  {
    name: 'RWA / Identity',
    symbols: [
      'ONDOUSDT', 'CFGUSDT', 'MPLUSDT', 'TRUUSDT', 'CVCUSDT',
      'IDUSDT', 'GalaxyUSDT',
    ],
  },
];

export const ALL_ASSET_SYMBOLS: string[] = Array.from(new Set(ASSET_UNIVERSE.flatMap((cat) => cat.symbols)));

export const TOP_CRYPTO_SYMBOLS: string[] = [
  'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT',
  'DOGEUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT', 'MATICUSDT',
  'UNIUSDT', 'LTCUSDT', 'ATOMUSDT', 'NEARUSDT', 'FTMUSDT',
  'ALGOUSDT', 'SANDUSDT', 'MANAUSDT', 'AXSUSDT', 'GALAUSDT',
  'AAVEUSDT', 'MKRUSDT', 'COMPUSDT', 'SNXUSDT', 'CRVUSDT',
  'SUSHIUSDT', 'YFIUSDT', 'RUNEUSDT', 'INJUSDT', 'FETUSDT',
];

export const BINANCE_BASE_URL = process.env.BINANCE_BASE_URL || 'https://api.binance.com';

export const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || '';
export const NVIDIA_INVOKE_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';