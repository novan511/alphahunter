import type { NextApiRequest, NextApiResponse } from 'next';
import { getLastScan, type LastScanResponse } from './scans';
import { sendTelegramMessage, telegramEnv } from '../../lib/serverTelegram';
import { buildSectorHeat } from '../../lib/algorithms/narrativeHeat';
import { buildTradeableList } from '../../lib/algorithms/tradeable';
import { computeMatrix, classifyStrength } from '../../lib/algorithms/correlationMatrix';
import { buildPortfolioPlan, buildRotationDigest } from '../../lib/algorithms/portfolioVerdict';
import { getSupabase } from '../../lib/supabase';
import { calibrationLines } from '../../lib/calibration';
import { readCalibration } from '../../lib/signalLedger';
import { callLLM } from '../../lib/quant/marketNarrator';
import { fetchPairRatio, windowStrength } from '../../lib/algorithms/pairRatio';
import { fetchKlinesRouted } from '../../lib/universe';
import { fetchCoinFlow, flowLine } from '../../lib/quant/derivatives';
import { signalLabel } from '../../lib/tgMessage';
import { analyzeStructure } from '../../lib/algorithms/marketStructure';
import { MAX_STRUCTURE_TARGETS } from '../../lib/signalLedger';
import { TELEGRAM_SYSTEM_PROMPT } from '../../lib/telegramPersona';
import type { Candle } from '../../lib/types';

// The morning-report GET runs a live data fetch + an LLM round trip; the
// default 10s budget is not enough on a cold function.
export const config = { maxDuration: 60 };

/**
 * Incoming Telegram webhook — makes the bot conversational.
 *
 * Setup (once, after deploy):
 *   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<domain>/api/telegram-webhook
 * Check:
 *   https://api.telegram.org/bot<TOKEN>/getWebhookInfo
 *
 * Security: only the configured TELEGRAM_CHAT_ID is answered. Anyone else
 * gets silence — replying "unauthorized" would confirm the bot to strangers.
 *
 * Commands:
 *   Reads from the last persisted scan in Supabase:
 *     /status         → regime + scan age + early/confirmed sectors
 *     /top            → top 5 tradeable coins
 *     /watch          → watchlist near-misses
 *   Computed live from exchange candles (same math as the web panel):
 *     /matrix [tf] [window] → pairwise strength ranking, e.g. /matrix 4h 30
 *     /pair A B [tf]        → A/B ratio read, e.g. /pair SOL BTC
 *     /hold [tf] [window]    → rotation verdict: what to hold / trim / drop
 *   /start | /help  → command list
 */

interface TgMessage {
  message_id: number;
  chat?: { id?: number | string; type?: string };
  text?: string;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

const HELP = [
  'Perintah yang tersedia:',
  '/status — ringkasan scan terakhir + sektor early',
  '/top — 5 koin paling tradeable',
  '/watch — koin yang dipantau (tren ada, pemicu belum)',
  '/matrix [tf] [window] — ranking kekuatan antar-koin, mis. /matrix 4h 30',
  '/pair A B [tf] — chart ratio A/B dalam kata-kata, mis. /pair SOL BTC',
  '/hold [tf] [window] — tahan / kurangi / buang, mis. /hold 4h 30',
  '/scan — pindai pasar baru + analisis ulang',
  '/help — pesan ini',
  'Kamu juga bisa mengobrol bahasa natural (tanpa slash) untuk diskusi dengan AI trader.',
].join('\n');

/** Default basket for /matrix — bare symbols, same set as the web panel. */
const MATRIX_BASKET = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'SUIUSDT', 'HYPEUSDT'];

/** System prompt untuk Telegram bot: paksa bahasa Indonesia natural, jangan JSON. */
/** Simple in-memory rate limiter for AI chat to prevent DeepSeek spam.
 *  Key = chatId, value = last request timestamp. Cooldown: 30 seconds.
 *
 *  shortcut: disimpan per instance (Map di memori), jadi di Vercel multi-
 *  instance batasnya bisa dilewati N× dan hilang tiap deploy; cukup selama
 *  satu chat dilayani — pindahkan ke satu baris Postgres saat multi-pengguna (E).
 */
const AI_RATE_LIMIT_MS = 30_000;
const aiLastAsk: Map<string, number> = new Map();

function aiRateLimited(chatId: string): { limited: boolean; retryAfter?: number } {
  const now = Date.now();
  const last = aiLastAsk.get(chatId);
  if (last != null && now - last < AI_RATE_LIMIT_MS) {
    return { limited: true, retryAfter: Math.ceil((AI_RATE_LIMIT_MS - (now - last)) / 1000) };
  }
  aiLastAsk.set(chatId, now);
  // Trim old entries to prevent unbounded growth.
  if (aiLastAsk.size > 500) {
    aiLastAsk.forEach((v, k) => {
      if (now - v > AI_RATE_LIMIT_MS * 10) aiLastAsk.delete(k);
    });
  }
  return { limited: false };
}

function short(sym: string): string {
  const bare = sym.includes(':') ? sym.slice(sym.indexOf(':') + 1) : sym;
  return bare.replace(/USDT$|USDC$/, '');
}

function fmtSigned(x: number, digits = 2): string {
  return `${x >= 0 ? '+' : ''}${x.toFixed(digits)}`;
}

function parseTf(raw: string | undefined, fallback: string): string {
  const v = (raw || '').toLowerCase();
  return v === '1h' || v === '4h' || v === '1d' ? v : fallback;
}

function parseWindow(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw || '', 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 10), 200) : fallback;
}

export async function handleMatrix(args: string[]): Promise<string> {
  const tf = parseTf(args[0], '4h');
  const windowBars = parseWindow(args[1], 30);

  const settled = await Promise.allSettled(
    MATRIX_BASKET.map((s) => fetchKlinesRouted(s, tf, windowBars * 3 + 60)),
  );
  const series: Record<string, Candle[]> = {};
  const failed: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value.length > 0) series[MATRIX_BASKET[i]] = r.value;
    else failed.push(short(MATRIX_BASKET[i]));
  });

  const available = Object.keys(series);
  if (available.length < 2) {
    return `Gagal memuat basket (${failed.join(', ') || 'unknown'}). Coba lagi sebentar.`;
  }

  const m = computeMatrix(series, available, windowBars, tf);
  if (!m) {
    return `Histori overlap kurang untuk window ${windowBars} bar di ${tf}. Coba window lebih kecil, mis. /matrix ${tf} 30.`;
  }

  const sorted = [...m.coins].sort((a, b) => a.dominanceRank - b.dominanceRank);
  const lines = [
    `Matrix ${tf} x${windowBars} (${m.symbols.length} koin, corr rata2 ${m.basketCorr.toFixed(2)})${m.basketCorr > 0.85 ? ' — basket bergerak serempak, rotasi terbatas' : ''}`,
  ];
  for (const c of sorted) {
    const v = classifyStrength(c);
    lines.push(`${c.dominanceRank + 1}. ${short(c.symbol)} ${fmtSigned(c.dominance)}% ${v.label}`);
  }
  const lead = sorted[0];
  const lag = sorted[sorted.length - 1];
  lines.push(`Terkuat vs semua: ${short(lead.symbol)} · Terlemah: ${short(lag.symbol)}`);
  if (failed.length > 0) lines.push(`Skip: ${failed.join(', ')}`);
  return lines.join('\n');
}

export async function handlePair(args: string[]): Promise<string> {
  if (args.length < 2) {
    return 'Format: /pair A B [tf]\nContoh: /pair SOL BTC  — atau  /pair HYPE SOL 1d';
  }
  const tf = parseTf(args[2], '4h');

  let pair;
  try {
    pair = await fetchPairRatio(args[0], args[1], tf, 120);
  } catch (err) {
    return `Gagal memuat ${args[0].toUpperCase()}/${args[1].toUpperCase()}: ${err instanceof Error ? err.message : 'unknown'}`;
  }

  const b = short(pair.base);
  const q = short(pair.quote);
  const w30 = windowStrength(pair, 30);
  const ma20 = pair.ratio.slice(-20).reduce((s, x) => s + x, 0) / 20;
  const last = pair.ratio[pair.ratio.length - 1];
  const above = last >= ma20;
  const dir = pair.change > 1 ? 'menguat' : pair.change < -1 ? 'melemah' : 'sideways';

  return [
    `${b}/${q} ${tf} x${pair.bars}: ${fmtSigned(pair.change)}% — ${b} ${dir} vs ${q}`,
    `Window 30 bar: ${fmtSigned(w30)}%`,
    `Ratio ${above ? 'di atas' : 'di bawah'} MA20 (${ma20.toFixed(2)}) — momentum ${above ? 'masih searah tren' : 'berbalik, tren melemah'}.`,
  ].join('\n');
}

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s} dtk lalu`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} mnt lalu`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} jam lalu`;
  return `${Math.floor(h / 24)} hari lalu`;
}

async function handleStatus(): Promise<string> {
  let scan;
  try {
    scan = await getLastScan('BTCUSDT');
  } catch {
    return 'Gagal membaca scan terakhir — Supabase tidak terjangkau.';
  }
  if (!scan.configured) return 'Supabase belum dikonfigurasi di server.';
  if (!scan.found || !scan.rankings?.length) {
    return 'Belum ada scan tersimpan. Jalankan scan dari web dulu.';
  }

  const sectors = buildSectorHeat(scan.rankings);
  const early = sectors.filter((s) => s.phase === 'early' && s.members > 0);
  const confirmed = sectors.filter((s) => s.phase === 'confirmed' && s.members > 0);
  const buys = scan.rankings.filter((r) => r.finalSignal.includes('buy')).length;
  const sells = scan.rankings.filter((r) => r.finalSignal.includes('sell')).length;

  const lines = [
    `Status scan ${timeAgo(scan.scannedAt ?? Date.now())} (${scan.rankings.length} koin)`,
    `Regime: ${(scan.regimeLabel ?? scan.regime?.regime ?? '—').replace(/_/g, ' ')} · ${buys} buy / ${sells} sell`,
    '',
  ];
  if (early.length > 0) {
    lines.push('Mulai naik:');
    for (const s of early.slice(0, 3)) {
      lines.push(`- ${s.icon} ${s.label} (early ${s.earlyScore}, ${s.buyCount} buy) — ${s.leaders.join(', ') || '—'}`);
    }
  } else {
    lines.push('Tidak ada sektor di fase early saat ini.');
  }
  if (confirmed.length > 0) {
    lines.push(`Terkonfirmasi: ${confirmed.slice(0, 3).map((s) => s.label).join(', ')}`);
  }
  return lines.join('\n');
}

async function handleTop(): Promise<string> {
  let scan;
  try {
    scan = await getLastScan('BTCUSDT');
  } catch {
    return 'Gagal membaca scan terakhir — Supabase tidak terjangkau.';
  }
  if (!scan.configured) return 'Supabase belum dikonfigurasi di server.';
  if (!scan.found || !scan.rankings?.length) {
    return 'Belum ada scan tersimpan. Jalankan scan dari web dulu.';
  }
  const { trades } = buildTradeableList(scan.rankings, {});
  if (trades.length === 0) return 'Tidak ada koin yang lolos gate tradeable saat ini.';
  const lines = ['Top tradeable:'];
  for (const t of trades.slice(0, 5)) {
    const arrow = t.direction === 'long' ? 'LONG' : 'SHORT';
    lines.push(
      `- ${t.ticker} ${arrow} · conf ${t.confluenceScore} · risiko ${t.riskTier} · budget <=${t.riskBudgetPct}%`
    );
  }
  return lines.join('\n');
}

async function handleWatch(): Promise<string> {
  let scan;
  try {
    scan = await getLastScan('BTCUSDT');
  } catch {
    return 'Gagal membaca scan terakhir — Supabase tidak terjangkau.';
  }
  if (!scan.configured) return 'Supabase belum dikonfigurasi di server.';
  if (!scan.found || !scan.rankings?.length) {
    return 'Belum ada scan tersimpan. Jalankan scan dari web dulu.';
  }
  const { watchlist } = buildTradeableList(scan.rankings, {});
  if (watchlist.length === 0) return 'Watchlist kosong — tidak ada tren tanpa pemicu saat ini.';
  const lines = ['Dipantau:'];
  for (const w of watchlist.slice(0, 8)) {
    lines.push(`- ${w.ticker} (bias +${Math.round(w.netBias * 100)}%, conf ${w.confluenceScore})`);
  }
  return lines.join('\n');
}

/**
 * Rotation verdict over the shared basket — the same computation the cron
 * push runs, so the phone and the web panel never disagree.
 *
 * Reads the basket from correlation_settings (what the panel saved), not from
 * a hardcoded list, so adding a coin in the UI immediately changes what
 * /hold recommends.
 */
export async function handleHold(args: string[]): Promise<string> {
  const tf = parseTf(args[0], '4h');
  const windowBars = parseWindow(args[1], 30);

  const supabase = getSupabase();
  let basket: string[] = [];
  let history: Array<{
    symbol: string;
    created_at: string;
    dominance: number | null;
    dominance_rank: number | null;
  }> = [];

  if (supabase) {
    const { data: settings } = await supabase
      .from('correlation_settings')
      .select('symbols')
      .eq('id', 'default')
      .limit(1)
      .maybeSingle();
    const syms = (settings as { symbols?: string[] } | null)?.symbols;
    if (Array.isArray(syms) && syms.length >= 2) basket = syms.slice(0, 16);
  }

  // No shared basket configured: fall back to the bot default so the command
  // always answers something useful.
  if (basket.length < 2) basket = MATRIX_BASKET;

  const settled = await Promise.allSettled(
    basket.map((s) => fetchKlinesRouted(s, tf, windowBars * 3 + 60)),
  );
  const series: Record<string, Candle[]> = {};
  const failed: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value.length > 0) series[basket[i]] = r.value;
    else failed.push(basket[i]);
  });
  const available = Object.keys(series);
  if (available.length < 2) {
    return `Gagal memuat basket (${failed.join(', ') || 'unknown'}). Coba lagi sebentar.`;
  }

  const matrix = computeMatrix(series, available, windowBars, tf);
  if (!matrix) {
    return `Histori overlap kurang untuk window ${windowBars} bar di ${tf}. Coba window lebih kecil, mis. /hold ${tf} 30.`;
  }

  if (supabase) {
    const { data } = await supabase
      .from('correlation_dominance_history')
      .select('symbol, created_at, dominance, dominance_rank')
      .in('symbol', matrix.symbols)
      .eq('interval', tf)
      .eq('window_bars', windowBars)
      .order('created_at', { ascending: false })
      .limit(matrix.symbols.length * 10);
    history = (data ?? []) as typeof history;
  }

  const plan = buildPortfolioPlan(matrix, history as Parameters<typeof buildPortfolioPlan>[1]);
  const digest = buildRotationDigest(plan);
  return failed.length > 0 ? `${digest}\n\nSkip: ${failed.map(short).join(', ')}` : digest;
}

/**
 * Structure and patterns for the coins already in the context.
 *
 * Only 4h and 1d are read. The 200-bar window is ~33 days on 4h and ~200 days on
 * 1d, which is what multi-pivot shapes need; on 1h the same 200 bars are ~8 days,
 * where "no pattern" and "no history" cannot be told apart. Reporting 1h would
 * mean reporting absence we cannot actually claim, so it is left out.
 */
async function structureLinesFor(
  assets: string[],
  max = MAX_STRUCTURE_TARGETS
): Promise<string[]> {
  const out: string[] = [];
  const perCoin = await Promise.all(
    assets.slice(0, max).map(async (asset) => {
      const reads: { tf: string; summary: string; trend: string }[] = [];
      const results = await Promise.all(
        ['4h', '1d'].map(async (tf) => {
          try {
            const s = analyzeStructure(await fetchKlinesRouted(asset, tf, 200));
            return s ? { tf, summary: s.summary, trend: s.trend.label } : null;
          } catch {
            return null; // best-effort: structure never blocks the analysis
          }
        })
      );
      for (const r of results) if (r) reads.push(r);
      return { asset, reads };
    })
  );

  for (const { asset, reads } of perCoin) {
    if (reads.length === 0) continue;
    out.push(`• ${asset.replace('USDT', '')}`);
    for (const r of reads) out.push(`  ${r.tf}: ${r.summary.replace(/\n/g, ' | ')}`);
    if (reads.length === 2 && reads[0].trend !== reads[1].trend) {
      out.push(
        `  ⚠ KONFLIK TIMEFRAME: ${reads[0].tf} ${reads[0].trend} vs ${reads[1].tf} ${reads[1].trend}`
      );
    }
  }
  return out;
}

/** Ringkasan lengkap scan terakhir untuk konteks analisis profesional. */
async function scanContext(scan: LastScanResponse): Promise<string> {
  const r = scan.rankings ?? [];
  const strongBuys = r.filter((x) => x.finalSignal === 'strong_buy').slice(0, 8);
  const buys = r.filter((x) => x.finalSignal === 'buy').slice(0, 8);
  const strongSells = r.filter((x) => x.finalSignal === 'strong_sell').slice(0, 8);
  const sells = r.filter((x) => x.finalSignal === 'sell').slice(0, 8);
  const lines: string[] = [];
  lines.push(
    `Scan terakhir: ${scan.source ?? '—'} pada ${new Date(scan.scannedAt ?? Date.now()).toLocaleString(
      'id-ID',
      { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' },
    )} WIB`
  );
  const regime = scan.regime;
  lines.push(
    `Index: ${scan.indexSymbol ?? 'BTCUSDT'} | Regime: ${(
      scan.regimeLabel ?? regime?.regime ?? '—'
    ).replace(/_/g, ' ')}${
      regime
        ? ` (conf ${regime.confidence}%, ADX ${regime.adxValue}, ATR ${regime.atrPercent}%, vol pct ${regime.volatilityPercentile})`
        : ''
    }`
  );
  // Why the detector was tuned the way it was — the regime cause, not just its name.
  if (scan.autonomousParams?.reason) {
    lines.push(`Detektor disetel: ${scan.autonomousParams.reason}`);
  }
  lines.push(
    `Koindiakan: ${scan.totalScanned ?? r.length} | Sinyal non-netral: ${
      scan.signalsFound ?? r.filter((x) => x.finalSignal !== 'neutral').length
    }`
  );
  if (strongBuys.length) {
    lines.push(
      'STRONG BUY: ' +
        strongBuys
          .map(
            (x) =>
              `${x.asset.replace('USDT', '')} (conf ${x.confluenceScore}, conv ${Math.round(
                (x.conviction ?? 0) * 100
              )}%, agree ${Math.round((x.agreement ?? 0) * 100)}%)`
          )
          .join(', ')
    );
  }
  if (buys.length) {
    lines.push(
      'BUY: ' +
        buys.map((x) => `${x.asset.replace('USDT', '')} (conf ${x.confluenceScore})`).join(', ')
    );
  }
  if (strongSells.length) {
    lines.push(
      'STRONG SELL: ' +
        strongSells
          .map(
            (x) =>
              `${x.asset.replace('USDT', '')} (conf ${x.confluenceScore}, conv ${Math.round(
                (x.conviction ?? 0) * 100
              )}%)`
          )
          .join(', ')
    );
  }
  if (sells.length) {
    lines.push(
      'SELL: ' +
        sells.map((x) => `${x.asset.replace('USDT', '')} (conf ${x.confluenceScore})`).join(', ')
    );
  }

  // The engine's own reasoning, which used to be thrown away before reaching the
  // model: per-coin narrative, trigger freshness and invalidation. Trigger age
  // is what tells "masih segar" from "sudah telat" — the difference between
  // acting and chasing.
  const tradeByAsset = new Map(buildTradeableList(r, {}).trades.map((t) => [t.asset, t]));
  const topCoins = [...strongBuys, ...strongSells, ...buys, ...sells].slice(0, 6);
  if (topCoins.length) {
    lines.push('', 'ALASAN & RISIKO PER KOIN (dari engine):');
    for (const c of topCoins) {
      const t = tradeByAsset.get(c.asset);
      const age = c.newestSignalAgeBars;
      const timing =
        age == null
          ? 'tanpa trigger segar — murni continuation'
          : age === 0
            ? 'trigger BAR INI (segar)'
            : `trigger ${age} bar lalu (${age >= 4 ? 'SUDAH TELAT, jangan kejar' : 'masih segar'})`;
      lines.push(
        `• ${c.asset.replace('USDT', '')} ${signalLabel(c.finalSignal)} | konv ${Math.round(
          (c.conviction ?? 0) * 100
        )}% | ${timing}`
      );
      if (c.narrative) lines.push(`  ${c.narrative}`);
      if (t) {
        lines.push(
          `  Risiko ${t.riskTier} (budget maks ${t.riskBudgetPct}%) | horizon ${t.horizon}${
            t.counterTrend ? ' | MELAWAN tren harian' : ''
          }`
        );
      }
      if (t?.invalidation?.length) lines.push(`  Invalidasi: ${t.invalidation.join(' ')}`);
    }
  }

  // Market structure: where price sits relative to prior price action, and any
  // pattern the engine can actually define. Candles are fetched here because
  // structure is not part of the persisted scan payload — labelled live, like
  // the flow data below, so the model never mixes it with the scan timestamp.
  try {
    const structure = await structureLinesFor(topCoins.map((c) => c.asset));
    if (structure.length) {
      lines.push('', 'STRUKTUR & POLA (dihitung dari candle 4h & 1d, live):', ...structure);
    }
  } catch {
    // Structure failed — the analysis still runs without it.
  }

  const sectors = buildSectorHeat(r);
  const early = sectors.filter((s) => s.phase === 'early' && s.members > 0).slice(0, 5);
  if (early.length) {
    lines.push(
      'Sektor early: ' +
        early.map((s) => `${s.label} (early ${s.earlyScore}, ${s.buyCount} buy)`).join(', ')
    );
  }
  const confirmed = sectors.filter((s) => s.phase === 'confirmed' && s.members > 0).slice(0, 5);
  if (confirmed.length) {
    lines.push(
      'Sektor terkonfirmasi: ' +
        confirmed.map((s) => `${s.label} (heat ${s.heat})`).join(', ')
    );
  }

  // Live derivatives + spot order flow for the coins that matter. Fetched
  // separately because the scan itself only sees candles — labelled as live so
  // the model never mixes it with the persisted scan timestamp.
  const flowCoins = Array.from(
    new Set([
      scan.indexSymbol ?? 'BTCUSDT',
      ...strongBuys.map((x) => x.asset),
      ...buys.map((x) => x.asset),
      ...strongSells.map((x) => x.asset),
      ...sells.map((x) => x.asset),
    ])
  );
  try {
    const flow = await fetchCoinFlow(flowCoins);
    const flowLines = Array.from(flow.values())
      .map(flowLine)
      .filter((l): l is string => Boolean(l));
    if (flowLines.length) {
      lines.push('', 'FUNDING & CVD SPOT (data live, bukan bagian scan):', ...flowLines);
    }
  } catch {
    // Data live gagal — analisis tetap jalan dengan data scan saja.
  }

  // Forward record: what actually happened to signals already emitted. Reads are
  // anonymous (RLS select); nothing here is a forecast. The gate lives in
  // calibration.ts — a bucket below the sample floor prints words, not a number,
  // so the model cannot quote an edge the record does not support.
  try {
    const supabase = getSupabase();
    if (supabase) {
      const { pushed: buckets } = await readCalibration(supabase);
      const recordLines = calibrationLines(buckets);
      if (recordLines.length) {
        lines.push(
          '',
          'REKAM JEJAK LIVE (outcome sinyal yang sudah lewat — bukan prediksi, bukan backtest):',
          ...recordLines
        );
      }
    }
  } catch {
    // Rekam jejak tidak terbaca — analisis tetap jalan.
  }
  return lines.join('\n');
}

/** Perintah /scan: coba panggil scan-cron agar data segar, lalu analisis. */
async function handleScan(): Promise<string> {
  const secret = process.env.SCAN_CRON_SECRET;
  const host = process.env.VERCEL_URL;
  if (secret && host) {
    try {
      const res = await fetch(`https://${host}/api/scan-cron`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ notify: false, universe: 'curated', maxChunks: 1 }),
      });
      if (res.ok) {
        return 'Scan dipanggil — data segar akan segera tersedia. Ketik pertanyaanmu lagi untuk analisis baru.';
      }
    } catch {
      // fallthrough ke analisis scan terakhir
    }
  }
  return 'Trigger scan belum tersedia di environment ini. Analisis pakai scan terakhir di bawah.';
}

/** Laporan pagi otomatis (07:00 WIB) — dikirim ke TELEGRAM_CHAT_ID. */
async function handleMorningReport(): Promise<string> {
  let scan: LastScanResponse;
  try {
    scan = await getLastScan('BTCUSDT');
  } catch {
    return 'Gagal membaca scan terakhir untuk laporan pagi.';
  }
  if (!scan.configured || !scan.found || !scan.rankings?.length) {
    return 'Belum ada scan tersimpan untuk laporan pagi.';
  }

  const prompt = `Kamu adalah HEDGE FUND MANAGER dan ELITE CRYPTO TRADER terbaik di dunia — profitable selama bertahun-tahun melalui siklus bull dan bear, sangat sensitif terhadap perubahan pasar. Buat LAPORAN PAGI (07:00 WIB) dalam Bahasa Indonesia untuk klien, berdasarkan data scan terakhir dari engine Althunter (jangkar inti yang tidak boleh diabaikan).

FRAMEWORK ANALISIS YANG HARUS DIGUNAKAN:
1. MAKRO: DXY, VIX, US10Y, likuiditas global, risk-on/risk-off, macro regime (akumulasi / distribusi / ekspansi / kontraksi).
2. STRUKTUR PASAR: BOS (Break of Structure), CHoCH (Change of Character), liquidity sweep, order block, fair value gap, inducement.
3. INDIKATOR TEKNIS: RSI (overbought >70 / oversold <30 / divergence), EMA alignment (20/50/200), volume profile, momentum.
4. POLA HARGA — daftar ini KOSAKATA, bukan tugas mencari: double top/bottom, head and shoulders, wedge, triangle, flag, divergence. Kamu HANYA boleh menyebut pola yang ada di bagian "STRUKTUR & POLA" di bawah. Cup & handle tidak dihitung engine — jangan pernah menyebutnya.
5. ICT / SMC: market structure shift, breaker block, mitigation block, optimal trade entry (OTE), premium/discount zone, killzone (Asia/London/NY).
6. SENTIMEN & ORDER FLOW: funding rate, spot CVD (taker delta), open interest, long/short ratio, fear & greed context. Bagian "FUNDING & CVD SPOT" di bawah adalah data live — pakai untuk membaca siapa yang agresif (buyer atau seller) dan apakah crowd sedang long/short.

ATURAN KERAS (JANGAN DILANGGAR):
- DATA SCAN ADALAH JANGKAR: Pendapat dan rekomendasi HARUS didasarkan pada data scan terakhir di bawah. Jangan halusinasi indikator yang tidak ada dalam data. Jika data tidak cukup untuk menyimpulkan sesuatu, katakan "data tidak cukup" dan arahkan ke web.
- STRUKTUR ADALAH DATA, BUKAN TEMA: sebut level/pola HANYA dari bagian "STRUKTUR & POLA". Kalau di situ tertulis polanya tidak ada, katakan tidak ada — jangan mencarinya sendiri. Pola berlabel "BELUM terkonfirmasi" wajib kamu sebut belum terkonfirmasi.
- BOLEH memberikan arah pasar (bullish/bearish/sideways), zona interess, setup long/short/hold/wait, dan analisis risiko — dengan alasan yang kuat.
- JANGAN janjikan profit, jangan bilang "pasti", "jaminan", "100% aman", atau target harga / SL / TP spesifik.
- Selalu akhiri dengan disclaimer: "Bukan saran finansial. Konfirmasi dan risiko tanggung sendiri."

URUTAN REASONING (WAJIB, jangan dilompati):
1. MAKRO & REGIME — kondisi pasar sekarang dan artinya untuk agresivitas (pakai angka regime + alasan detektor disetel).
2. BREADTH & ROTASI — berapa koin long vs short, sektor mana yang memimpin/memudar.
3. RELATIVE STRENGTH — dari engine: siapa kuat/lemah terhadap index dan sebesar apa.
4. STRUKTUR & ORDER FLOW — posisi harga vs support/resistance dan pola dari bagian "STRUKTUR & POLA" (kalau ada konflik timeframe, sebut konfliknya), lalu funding/CVD live: siapa yang agresif (buyer atau seller).
5. RISIKO & INVALIDASI — pakai bagian "ALASAN & RISIKO PER KOIN" apa adanya, jangan dikarang.
6. SKENARIO — base / bull / bear, dan apa yang mengonfirmasi tiap skenario.
7. AKSI — per koin teratas: MASUK SEKARANG / TUNGGU TRIGGER / SUDAH TELAT.

- WAJIB sebut status timing tiap koin dari engine (trigger bar ini = segar; >=4 bar = sudah telat). Klien sering ragu lalu telat masuk — jangan biarkan itu terjadi.
- WAJIB pilih SATU alasan terkuat dan SATU hal yang paling bisa membatalkan tesis. Jangan menyamaratakan semua alasan.
- Kalau masih segar, dorong bertindak tegas; kalau sudah telat, katakan tunggu pullback. Jangan menyamarkan.

Gaya: Bahasa Indonesia trader, authoritative tapi ramah, pakai emoji strategis (📈📉💰🛡️⚠️🔥🌅), Maksimal 6 paragraf pendek, terstruktur dengan judul paragraf singkat. Gunakan istilah trader profesional.

DATA SCAN TERAKHIR (JANGKAR):
${await scanContext(scan)}

Buat laporan pagi sekarang.`;

  try {
    const reply = await callLLM(prompt, { system: TELEGRAM_SYSTEM_PROMPT });
    return reply.slice(0, 4000);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    return `Laporan pagi gagal dihasilkan (${msg}). Coba lagi nanti atau cek /status.`;
  }
}

/** Diskusi natural dengan persona hedge fund manager / elite crypto trader. */
async function handleAsk(chatId: string, question: string): Promise<string> {
  // Rate limit: mencegah spam DeepSeek API.
  const limit = aiRateLimited(chatId);
  if (limit.limited) {
    return `Tunggu sebentar dulu ya (${limit.retryAfter} detik lagi) sebelum tanya lagi — biar API-nya tidak overlimit.`;
  }

  let scanNotice = '';
  const isScanRequest = /scan|pindai|rescan|cari koin|lihat pasar/i.test(question);
  if (isScanRequest) {
    scanNotice = await handleScan();
  }

  let scan: LastScanResponse;
  try {
    scan = await getLastScan('BTCUSDT');
  } catch {
    return 'Gagal membaca scan terakhir — Supabase tidak terjangkau.';
  }
  if (!scan.configured) return 'Supabase belum dikonfigurasi di server.';
  if (!scan.found || !scan.rankings?.length) {
    return 'Belum ada scan tersimpan. Jalankan scan dari web dulu.';
  }

  const prompt = `Kamu adalah HEDGE FUND MANAGER dan ELITE CRYPTO TRADER terbaik di dunia — profitable selama bertahun-tahun melalui banyak siklus bull dan bear, sangat sensitif terhadap perubahan pasar. Kamu ngobrol dengan klien lewat Telegram dalam Bahasa Indonesia yang natural, authoritative, dan ramah — jangan robotis, jangan asisten generik, jangan terlalu formal.

FRAMEWORK ANALISIS YANG HARUS DIGUNAKAN:
1. MAKRO: DXY, VIX, US10Y, likuiditas global, risk-on/risk-off, macro regime.
2. STRUKTUR PASAR: BOS, CHoCH, liquidity sweep, order block, fair value gap.
3. INDIKATOR TEKNIS: RSI, EMA alignment (20/50/200), volume profile, momentum.
4. POLA HARGA — kosakata, bukan tugas mencari: double top/bottom, head and shoulders, wedge, triangle, flag, divergence. Sebut hanya yang ADA di bagian "STRUKTUR & POLA" di bawah. Cup & handle tidak dihitung engine — jangan menyebutnya.
5. ICT / SMC: market structure shift, breaker block, mitigation block, OTE, premium/discount zone, killzone.
6. SENTIMEN & ORDER FLOW: funding rate, spot CVD (taker delta), open interest, long/short ratio. Bagian "FUNDING & CVD SPOT" di bawah adalah data live — pakai untuk membaca siapa yang agresif (buyer atau seller) dan apakah crowd sedang long/short.

TUGAS:
1. Berikan analisis dan pendapat keuangan (financial opinion) terbaik berdasarkan kondisi pasar sekarang dari data scan terakhir.
2. Kamu BOLEH memberikan saran arah pasar (bullish/bearish/sideways), zona interess, setup long/short/hold/wait, dan risiko — dengan alasan yang kuat dari data.
3. JANGAN janjikan profit, jangan bilang "pasti", "jaminan", "100% aman", atau target harga/SL/TP spesifik.
4. Selalu akhiri dengan disclaimer: "Bukan saran finansial. Konfirmasi dan risiko tanggung sendiri."

ATURAN KERAS: DATA SCAN ADALAH JANGKAR. Pendapat HARUS didasarkan pada data scan terakhir. Jangan halusinasi indikator yang tidak ada. Jika data tidak cukup, katakan "data tidak cukup" dan arahkan ke web. Sebut level/pola HANYA dari bagian "STRUKTUR & POLA"; kalau di situ tertulis tidak ada, katakan tidak ada. Pola "BELUM terkonfirmasi" wajib disebut belum terkonfirmasi.

URUTAN REASONING (WAJIB, jangan dilompati):
1. MAKRO & REGIME — kondisi pasar dan artinya untuk agresivitas.
2. BREADTH & ROTASI — long vs short, sektor yang memimpin.
3. RELATIVE STRENGTH — dari engine: siapa kuat/lemah vs index.
4. STRUKTUR & ORDER FLOW — posisi harga vs level dan pola dari "STRUKTUR & POLA" (sebut konflik timeframe bila ada), lalu funding/CVD: siapa yang agresif.
5. RISIKO & INVALIDASI — pakai bagian "ALASAN & RISIKO PER KOIN" apa adanya, jangan dikarang.
6. SKENARIO — base / bull / bear, apa yang mengonfirmasi tiap skenario.
7. AKSI — MASUK SEKARANG / TUNGGU TRIGGER / SUDAH TELAT untuk koin teratas.

- WAJIB sebut status timing tiap koin dari engine (trigger bar ini = segar; >=4 bar = sudah telat). Klien sering ragu lalu telat masuk — jangan biarkan itu terjadi.
- WAJIB pilih SATU alasan terkuat dan SATU hal yang paling bisa membatalkan tesis.
- Kalau masih segar, dorong bertindak tegas; kalau sudah telat, katakan tunggu pullback. Jangan menyamarkan.

Gaya bahasa: Indonesia trader, singkat padat, pakai emoji strategis (📈📉💰🛡️⚠️🔥), maksimal 5 paragraf pendek. Gunakan istilah trader profesional.

DATA SCAN TERAKHIR (JANGKAR):
${await scanContext(scan)}

Pertanyaan / Perintah: ${question}`;

  try {
    const reply = await callLLM(prompt, { system: TELEGRAM_SYSTEM_PROMPT });
    const head = scanNotice ? `${scanNotice}\n\n` : '';
    return (head + reply).slice(0, 3500);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    return (scanNotice ? scanNotice + '\n\n' : '') +
      `AI trader sedang sibuk atau error (${msg}). Coba lagi sebentar, atau gunakan /top, /status, /hold.`;
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method === 'GET') {
    // Morning-report endpoint for cron (07:00 WIB = 00:00 UTC). Protected like
    // the other cron routes: SCAN_CRON_SECRET bearer or x-vercel-cron header.
    if (req.query.morning_report === '1') {
      const secret = process.env.SCAN_CRON_SECRET;
      if (!secret) return res.status(500).json({ ok: false, reason: 'SCAN_CRON_SECRET not set' });
      const header = req.headers.authorization;
      const ok =
        (header && header.startsWith('Bearer ') && header.slice(7) === secret) ||
        req.headers['x-vercel-cron'] != null;
      if (!ok) return res.status(401).json({ error: 'unauthorized' });
      const { chatId } = telegramEnv();
      if (!chatId) return res.status(200).json({ ok: false, reason: 'TELEGRAM_CHAT_ID not set' });
      const report = await handleMorningReport();
      await sendTelegramMessage(report, String(chatId));
      return res.status(200).json({ ok: true, sent: true });
    }
    // Health check for the operator (browser), not for Telegram.
    return res.status(200).json({ ok: true, usage: 'Telegram POSTs updates here; set via setWebhook' });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET,POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Always 200 quickly — Telegram retries anything else, which would
  // double-answer. All real failures are logged, not returned.
  try {
    const { configured, chatId } = telegramEnv();
    if (!configured) {
      return res.status(200).json({ ok: false, reason: 'telegram not configured' });
    }

    const update = req.body as TgUpdate;
    const msg = update?.message;
    const fromChat = msg?.chat?.id != null ? String(msg.chat.id) : '';
    const text = (msg?.text || '').trim();

    // Not our owner, or not a text message → silence.
    if (!fromChat || fromChat !== String(chatId) || !text) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const cmd = text.split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');

    const args = text.split(/\s+/).slice(1);

    let reply: string;
    if (cmd === '/status') reply = await handleStatus();
    else if (cmd === '/top') reply = await handleTop();
    else if (cmd === '/watch') reply = await handleWatch();
    else if (cmd === '/matrix') reply = await handleMatrix(args);
    else if (cmd === '/pair') reply = await handlePair(args);
    else if (cmd === '/hold' || cmd === '/buang') reply = await handleHold(args);
    else if (cmd === '/scan') reply = await handleScan() + '\n\nKetik pertanyaan untuk analisis scan terbaru.';
    else if (cmd === '/start' || cmd === '/help') reply = HELP;
    else if (cmd.startsWith('/'))
      reply = 'Perintah tidak dikenali. Ketik /help untuk daftar perintah.';
    else reply = await handleAsk(fromChat, text);

    await sendTelegramMessage(reply, fromChat);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('telegram-webhook:', err instanceof Error ? err.message : err);
    return res.status(200).json({ ok: false });
  }
}
