import type { NextApiRequest, NextApiResponse } from 'next';
import { getLastScan, type LastScanResponse } from './scans';
import { sendTelegramMessage, telegramEnv } from '../../lib/serverTelegram';
import { buildSectorHeat } from '../../lib/algorithms/narrativeHeat';
import { buildTradeableList } from '../../lib/algorithms/tradeable';
import { computeMatrix, classifyStrength } from '../../lib/algorithms/correlationMatrix';
import { buildPortfolioPlan, buildRotationDigest } from '../../lib/algorithms/portfolioVerdict';
import { getSupabase } from '../../lib/supabase';
import { callLLM } from '../../lib/quant/marketNarrator';
import { fetchPairRatio, windowStrength } from '../../lib/algorithms/pairRatio';
import { fetchKlinesRouted } from '../../lib/universe';
import type { Candle } from '../../lib/types';

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
const MATRIX_BASKET = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'SUIUSDT', 'HYPE'];

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

/** Ringkasan lengkap scan terakhir untuk konteks analisis hedge fund manager. */
function scanContext(scan: LastScanResponse): string {
  const r = scan.rankings ?? [];
  const buys = r.filter((x) => x.finalSignal.includes('buy')).slice(0, 12);
  const sells = r.filter((x) => x.finalSignal.includes('sell')).slice(0, 12);
  const strongBuys = r.filter((x) => x.finalSignal === 'strong_buy').slice(0, 6);
  const strongSells = r.filter((x) => x.finalSignal === 'strong_sell').slice(0, 6);
  const lines: string[] = [];
  lines.push(
    `Scan terakhir: ${scan.source ?? '—'} pada ${new Date(scan.scannedAt ?? Date.now()).toLocaleString(
      'id-ID',
      { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' },
    )} WIB`
  );
  lines.push(
    `Index: ${scan.indexSymbol ?? 'BTCUSDT'} | Regime: ${(
      scan.regimeLabel ?? scan.regime?.regime ?? '—'
    ).replace(/_/g, ' ')}`
  );
  lines.push(
    `Koindiakan: ${scan.totalScanned ?? r.length} | Sinyal non-netral: ${
      scan.signalsFound ?? r.filter((x) => x.finalSignal !== 'neutral').length
    }`
  );
  if (strongBuys.length) {
    lines.push(
      'STRONG BUY: ' +
        strongBuys.map((x) => `${x.asset.replace('USDT', '')} (conf ${x.confluenceScore}, conv ${Math.round(
          (x.conviction ?? 0) * 100
        )}%)`).join(', ')
    );
  }
  if (buys.length) {
    lines.push(
      'Buy: ' +
        buys.map((x) => `${x.asset.replace('USDT', '')} (conf ${x.confluenceScore})`).join(', ')
    );
  }
  if (strongSells.length) {
    lines.push(
      'STRONG SELL: ' +
        strongSells.map((x) => `${x.asset.replace('USDT', '')} (conf ${x.confluenceScore}, conv ${Math.round(
          (x.conviction ?? 0) * 100
        )}%)`).join(', ')
    );
  }
  if (sells.length) {
    lines.push(
      'Sell: ' +
        sells.map((x) => `${x.asset.replace('USDT', '')} (conf ${x.confluenceScore})`).join(', ')
    );
  }
  const sectors = buildSectorHeat(r);
  const early = sectors.filter((s) => s.phase === 'early' && s.members > 0).slice(0, 4);
  if (early.length) {
    lines.push(
      'Sektor early: ' +
        early.map((s) => `${s.label} (early ${s.earlyScore})`).join(', ')
    );
  }
  const confirmed = sectors.filter((s) => s.phase === 'confirmed' && s.members > 0).slice(0, 4);
  if (confirmed.length) {
    lines.push('Sektor terkonfirmasi: ' + confirmed.map((s) => s.label).join(', '));
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

/** Diskusi natural dengan persona hedge fund manager / elite crypto trader. */
async function handleAsk(question: string): Promise<string> {
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

  const prompt = `Kamu adalah HEDGE FUND MANAGER dan CRYPTO TRADER terbaik di dunia — profitable, berpengalaman tahunan melalui banyak siklus bull dan bear. Kamu ngobrol dengan klien lewat Telegram dalam Bahasa Indonesia yang natural, authoritative, dan ramah — jangan robotis, jangan asisten generik, jangan terlalu formal.

TUGAS:
1. Berikan analisis dan pendapat keuangan (financial opinion) terbaik berdasarkan kondisi pasar sekarang dari data scan terakhir.
2. Kamu BOLEH memberikan saran arah pasar (bullish/bearish/sideways), zona interess, setup long/short/hold/wait, dan risiko — dengan alasan yang kuat dari data.
3. JANGAN janjikan profit, jangan bilang "pasti", "jaminan", "100% aman", atau target harga/SL/TP spesifik.
4. Selalu akhiri dengan disclaimer: "Bukan saran finansial. Konfirmasi dan risiko tanggung sendiri."

Gaya bahasa: Indonesia trader, singkat padat, pakai emoji strategis (📈📉💰🛡️⚠️🔥), maksimal 4 paragraf pendek. Gunakan istilah trader (liquidity, setup, breakout, accumulation, distribution, regime).

DATA SCAN TERAKHIR:
${scanContext(scan)}

Pertanyaan / Perintah: ${question}`;

  try {
    const reply = await callLLM(prompt);
    const head = scanNotice ? `${scanNotice}\n\n` : '';
    return (head + reply).slice(0, 3500);
  } catch {
    return (scanNotice ? scanNotice + '\n\n' : '') + 'LLM tidak bisa menjawab sekarang. Coba /top, /status, atau /hold.';
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method === 'GET') {
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
    else reply = await handleAsk(text);

    await sendTelegramMessage(reply, fromChat);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('telegram-webhook:', err instanceof Error ? err.message : err);
    return res.status(200).json({ ok: false });
  }
}
