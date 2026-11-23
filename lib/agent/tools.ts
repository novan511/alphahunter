/**
 * Concrete tools exposed to the agent.
 *
 * Every tool wraps an existing, already-tested backend function. Read tools
 * return compact projections (never raw 100KB scan payloads) so the model's
 * context stays small. The only write tool is confirmation-gated by policy.
 */

import { DEFAULT_SCAN_CONFIG } from '../config';
import { calibrationLines } from '../calibration';
import { analyzeStructure } from '../algorithms/marketStructure';
import { detectDecoupling } from '../algorithms/decouplingDetector';
import { runBacktest } from '../algorithms/backtestEngine';
import { getSupabase } from '../supabase';
import { readCalibration } from '../signalLedger';
import { fetchKlinesRouted } from '../universe';
import { sendTelegramMessage } from '../serverTelegram';
import { getLastScan } from '../../pages/api/scans';
import type { BacktestConfig, ScanConfig } from '../types';
import type { ToolDefinition } from './types';

const SYMBOL = /^[A-Z0-9]{3,15}$/;

function normaliseSymbol(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return SYMBOL.test(s) ? s : null;
}

const getLastScanTool: ToolDefinition = {
  name: 'get_last_scan',
  description:
    'Ambil ringkasan scan terakhir yang tersimpan: regime, breadth, dan koin teratas beserta skor serta status timingnya. Gunakan ini sebelum menjawab pertanyaan pasar umum.',
  scope: 'read',
  params: {},
  run: async () => {
    const scan = await getLastScan('BTCUSDT');
    if (!scan.configured) return { ok: false, error: 'Supabase belum dikonfigurasi.' };
    if (!scan.found || !scan.rankings?.length) {
      return { ok: false, error: 'Belum ada scan tersimpan. Suruh pengguna jalankan scan dari web.' };
    }
    return {
      ok: true,
      data: {
        scannedAt: scan.scannedAt ? new Date(scan.scannedAt).toISOString() : null,
        regime: scan.regimeLabel ?? scan.regime?.regime ?? 'tidak diketahui',
        totalScanned: scan.totalScanned ?? 0,
        top: scan.rankings.slice(0, 5).map((r) => ({
          symbol: r.asset,
          signal: r.finalSignal,
          score: r.confluenceScore,
          ageBars: r.newestSignalAgeBars,
        })),
      },
    };
  },
};

const analyzeStructureTool: ToolDefinition = {
  name: 'analyze_structure',
  description:
    'Hitung struktur harga (support, resistance, trend, pola) dari candle untuk satu koin. Pakai ini kalau ditanya level atau pola — jangan menebak dari ingatan.',
  scope: 'read',
  params: {
    symbol: {
      type: 'string',
      description: 'Simbol koin, misalnya BTCUSDT',
      required: true,
    },
    interval: {
      type: 'string',
      description: 'Timeframe candle',
      enum: ['4h', '1d'],
      required: false,
    },
  },
  run: async (args) => {
    const symbol = normaliseSymbol(args.symbol);
    if (!symbol) return { ok: false, error: 'Simbol tidak valid.' };
    const interval = args.interval === '1d' ? '1d' : '4h';
    const candles = await fetchKlinesRouted(symbol, interval, 200);
    const analysis = analyzeStructure(candles);
    if (!analysis) {
      return { ok: false, error: `Data ${symbol} ${interval} belum cukup untuk analisis struktur.` };
    }
    return {
      ok: true,
      data: {
        symbol,
        interval,
        trend: analysis.trend.label,
        support: analysis.support?.price ?? null,
        resistance: analysis.resistance?.price ?? null,
        patterns: analysis.patterns.slice(0, 3).map((p) => ({
          name: p.name,
          confirmed: p.confirmed,
          confidence: p.confidence,
        })),
        summary: analysis.summary,
      },
    };
  },
};

const runBacktestTool: ToolDefinition = {
  name: 'run_backtest',
  description:
    'Jalankan backtest deterministik untuk satu koin terhadap index. Kembalikan win rate, PnL, drawdown, Sharpe, dan alpha. Hanya untuk pertanyaan historical/validasi strategi.',
  scope: 'read',
  params: {
    symbol: { type: 'string', description: 'Simbol koin, misalnya ETHUSDT', required: true },
    index: { type: 'string', description: 'Simbol index, default BTCUSDT' },
    interval: { type: 'string', description: 'Timeframe', enum: ['4h', '1d'] },
  },
  run: async (args) => {
    const asset = normaliseSymbol(args.symbol);
    if (!asset) return { ok: false, error: 'Simbol tidak valid.' };
    const index = normaliseSymbol(args.index) ?? 'BTCUSDT';
    const interval = args.interval === '1d' ? '1d' : '4h';

    const scanConfig: ScanConfig = {
      ...DEFAULT_SCAN_CONFIG,
      indexSymbol: index,
      assetSymbols: [asset],
      interval,
    };
    const btConfig: BacktestConfig = {
      initialCapital: 10000,
      riskPerTrade: 0.02,
      stopLossATR: 2.0,
      takeProfitATR: 3.0,
      maxHoldBars: 24,
      useTrailingStop: true,
      trailingStopATR: 1.5,
      feeRate: 0.001,
      slippage: 0.0005,
      interval,
    };

    const [indexCandles, assetCandles] = await Promise.all([
      fetchKlinesRouted(index, interval, 500),
      fetchKlinesRouted(asset, interval, 500),
    ]);
    const n = Math.min(assetCandles.length, indexCandles.length);
    if (n < 40) return { ok: false, error: 'Candle tidak cukup untuk backtest.' };
    const a = assetCandles.slice(-n);
    const b = indexCandles.slice(-n);
    const signals = detectDecoupling(a, b, scanConfig);
    const result = runBacktest(a, b, signals, btConfig);

    return {
      ok: true,
      data: {
        symbol: asset,
        interval,
        totalTrades: result.totalTrades,
        winRate: result.winRate,
        totalPnLPercent: result.totalPnLPercent,
        profitFactor: result.profitFactor,
        maxDrawdownPercent: result.maxDrawdownPercent,
        sharpeRatio: result.sharpeRatio,
        alpha: result.alpha,
      },
    };
  },
};

const getCalibrationTool: ToolDefinition = {
  name: 'get_calibration',
  description:
    'Ambil rekam jejak live sinyal yang sudah lewat. Teks sudah otomatis menyembunyikan angka bila sampel belum cukup. Pakai ini kalau ditanya performa historis sinyal.',
  scope: 'read',
  params: {},
  run: async () => {
    const supabase = getSupabase();
    if (!supabase) return { ok: false, error: 'Supabase belum dikonfigurasi.' };
    const { pushed } = await readCalibration(supabase);
    return { ok: true, data: { lines: calibrationLines(pushed) } };
  },
};

const notifyTool: ToolDefinition = {
  name: 'send_telegram_notification',
  description:
    'Kirim pesan ke chat Telegram owner. Tool ini berEFEK SAMPING dan hanya boleh dijalankan setelah pengguna mengonfirmasi.',
  scope: 'write',
  params: {
    text: {
      type: 'string',
      description: 'Isi pesan yang akan dikirim',
      required: true,
      max: 4000,
    },
  },
  run: async (args) => {
    const text = String(args.text ?? '').slice(0, 4000);
    const result = await sendTelegramMessage(text);
    return { ok: result.ok, error: result.error, preview: text.slice(0, 160) };
  },
};

export const MARKET_TOOLS: ToolDefinition[] = [
  getLastScanTool,
  analyzeStructureTool,
  runBacktestTool,
  getCalibrationTool,
  notifyTool,
];

export const READ_ONLY_TOOLS = MARKET_TOOLS.filter((t) => t.scope === 'read');

export const AGENT_POLICY = {
  maxSteps: 4,
  maxToolCalls: 3,
  allowedTools: MARKET_TOOLS.map((t) => t.name),
  requireConfirmationFor: ['send_telegram_notification'],
};
