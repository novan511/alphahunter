/**
 * Analisis sekunder untuk AI Arena — SEMUA angka dihitung engine dari candle
 * nyata (bukan cengengesan LLM). LLM hanya menafsirkan & boleh menolak kandidat.
 * SMC: swing structure (HH/HL vs LH/LL), BOS, Fair Value Gap, order block,
 * equal highs/lows (likuiditas). Pattern: engulfing, pin bar. Indikator:
 * RSI14, ADX14, MACD, EMA20/50. Macro: DXY, VIX, US10Y (cache 15 menit).
 */
import { Candle } from '../types';
import { atr } from '../algorithms/indicators';
import { parseAssetId, fetchAssetCandles } from '../marketData';

function wilderSmooth(vals: number[], period: number): number[] {
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < vals.length; i++) {
    if (i < period) { acc += vals[i]; if (i === period - 1) out.push(acc / period); continue; }
    acc = out[out.length - 1] + (vals[i] - out[out.length - 1]) / period;
    out.push(acc);
  }
  return out;
}

export function rsi14(c: Candle[], period = 14): number {
  if (c.length < period + 1) return NaN;
  const diffs = [];
  for (let i = 1; i < c.length; i++) diffs.push(c[i].close - c[i - 1].close);
  const gains = diffs.map((d) => Math.max(0, d));
  const losses = diffs.map((d) => Math.max(0, -d));
  const wg = wilderSmooth(gains, period);
  const wl = wilderSmooth(losses, period);
  const g = wg[wg.length - 1], l = wl[wl.length - 1];
  if (l <= 0) return 99;
  return 100 - 100 / (1 + g / l);
}

function ema(vals: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [vals[0]];
  for (let i = 1; i < vals.length; i++) out.push(vals[i] * k + out[out.length - 1] * (1 - k));
  return out;
}

export function macdState(c: Candle[]): string {
  if (c.length < 30) return 'n/a';
  const closes = c.map((x) => x.close);
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  const lines = e12.map((v, i) => v - e26[i]);
  const sig = ema(lines, 9);
  const d = lines[lines.length - 1] - sig[sig.length - 1];
  const prev = lines[lines.length - 2] - sig[sig.length - 2];
  return d > 0 && prev <= 0 ? 'bull cross baru' : d < 0 && prev >= 0 ? 'bear cross baru' : d > 0 ? 'di atas signal' : 'di bawah signal';
}

export function adx14(c: Candle[], period = 14): number {
  if (c.length < period * 2 + 2) return NaN;
  const trs: number[] = [], pdm: number[] = [], ndm: number[] = [];
  for (let i = 1; i < c.length; i++) {
    const up = c[i].high - c[i - 1].high, dn = c[i - 1].low - c[i].low;
    pdm.push(up > dn && up > 0 ? up : 0);
    ndm.push(dn > up && dn > 0 ? dn : 0);
    trs.push(Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close)));
  }
  const atrS = wilderSmooth(trs, period);
  const pdiS = wilderSmooth(pdm, period);
  const ndiS = wilderSmooth(ndm, period);
  if (!atrS.length || !pdiS.length || !ndiS.length) return NaN;
  const a = Math.max(atrS[atrS.length - 1], 1e-9);
  const pdi = pdiS[pdiS.length - 1] / a * 100;
  const ndi = ndiS[ndiS.length - 1] / a * 100;
  const sum = pdi + ndi || 1e-9;
  return Math.round((100 * Math.abs(pdi - ndi) / sum) * 10) / 10;
}

interface Swing { i: number; price: number; kind: 'high' | 'low' }

function swings(c: Candle[], span = 2): Swing[] {
  const out: Swing[] = [];
  for (let i = span; i < c.length - span; i++) {
    let isH = true, isL = true;
    for (let j = i - span; j <= i + span; j++) {
      if (j === i) continue;
      if (c[j].high >= c[i].high) isH = false;
      if (c[j].low <= c[i].low) isL = false;
    }
    if (isH) out.push({ i, price: c[i].high, kind: 'high' });
    if (isL) out.push({ i, price: c[i].low, kind: 'low' });
  }
  return out;
}

/** Blok teks analisis sekunder per simbol — dihitung dari candle mentah. */
export function secondaryAnalysis(symbol: string, c: Candle[]): string {
  if (!c || c.length < 30) return `${symbol}: data kurang untuk analisis struktural`;
  const win = c.slice(-60);
  const last = win[win.length - 1];
  const px = last.close;
  const a = (atr(win, 14)[win.length - 1] || 0) || px * 0.01;
  const lines: string[] = [`${symbol} (analisis mandiri dari data mentah):`];

  // struktur swing HH/HL vs LH/LL + BOS
  const sw = swings(win);
  const hs = sw.filter((s) => s.kind === 'high').slice(-2);
  const ls = sw.filter((s) => s.kind === 'low').slice(-2);
  let structure = 'range';
  if (hs.length === 2 && ls.length === 2) {
    structure = hs[1].price > hs[0].price && ls[1].price > ls[0].price ? 'HH+HL (uptrend sehat)'
      : hs[1].price < hs[0].price && ls[1].price < ls[0].price ? 'LH+LL (downtrend sehat)' : 'range/antisipasi break';
  }
  const lastH = hs[hs.length - 1]?.price, lastL = ls[ls.length - 1]?.price;
  const bos = lastH != null && px > lastH ? `BOS up: price menembus swing high ${lastH.toFixed(4)} — struktur bull terkonfirmasi`
    : lastL != null && px < lastL ? `BOS down: price menembus swing low ${lastL.toFixed(4)} — struktur bear terkonfirmasi`
    : lastH != null && lastL != null ? `inside range ${lastL.toFixed(4)}–${lastH.toFixed(4)} (menunggu break)` : 'struktur belum matang';
  lines.push(`- struktur: ${structure}; ${bos}`);

  // Fair Value Gap (3-candle imbalance, hanya yang belum di-mitigasi dari 15 bar terakhir)
  let fvg = '';
  for (let i = win.length - 2; i >= Math.max(2, win.length - 16); i--) {
    if (win[i].low > win[i - 2].high) {
      const top = win[i].low, bot = win[i - 2].high;
      const mitigated = win.slice(i + 1).some((x) => x.low <= top);
      if (!mitigated) { fvg = `bullish FVG ${bot.toFixed(4)}–${top.toFixed(4)} (${(((top - bot) / px) * 100).toFixed(2)}% dari harga, belum di-isi) — area support/entry pullback`; break; }
    }
    if (win[i].high < win[i - 2].low) {
      const bot = win[i].high, top = win[i - 2].low;
      const mitigated = win.slice(i + 1).some((x) => x.high >= bot);
      if (!mitigated) { fvg = `bearish FVG ${bot.toFixed(4)}–${top.toFixed(4)} (${(((top - bot) / px) * 100).toFixed(2)}% dari harga, belum di-isi) — area resistance/short pullback`; break; }
    }
  }
  if (fvg) lines.push(`- ${fvg}`);

  // order block: bearish candle terakhir sebelum impulse yang menembus max high 5 bar sebelumnya
  let impulseIdx = -1;
  for (let i = win.length - 2; i >= Math.max(6, win.length - 12); i--) {
    const maxPre = Math.max(...win.slice(i - 5, i).map((x) => x.high));
    if (win[i].close > maxPre) { impulseIdx = i; break; }
    const minPre = Math.min(...win.slice(i - 5, i).map((x) => x.low));
    if (win[i].close < minPre) { impulseIdx = i; break; }
  }
  if (impulseIdx > 0) {
    const prev = win[impulseIdx - 1];
    const up = win[impulseIdx].close > win[impulseIdx].open;
    const ob = (up && prev.close < prev.open) || (!up && prev.close > prev.open);
    if (ob) lines.push(`- order block ${up ? 'demand' : 'supply'}: ${prev.low.toFixed(4)}–${prev.high.toFixed(4)} (candle ${up ? 'bearish' : 'bullish'} sebelum impulse ${up ? 'naik' : 'turun'}), belum absorbed`);
  }

  // equal highs/lows = likuiditas yang biasa dijebol lalu hunt
  for (let k = 0; k < hs.length - 1; k++) if (Math.abs(hs[k].price - hs[k + 1].price) < 0.2 * a) { lines.push(`- equal highs ${hs[k].price.toFixed(4)}≈${hs[k + 1].price.toFixed(4)} — likuiditas di atas (waspadai sweep lalu reverse)`); break; }
  for (let k = 0; k < ls.length - 1; k++) if (Math.abs(ls[k].price - ls[k + 1].price) < 0.2 * a) { lines.push(`- equal lows ${ls[k].price.toFixed(4)}≈${ls[k + 1].price.toFixed(4)} — likuiditas di bawah (waspadai sweep lalu reverse)`); break; }

  // pattern candle terakhir
  const b1 = win[win.length - 1], b2 = win[win.length - 2];
  const body1 = Math.abs(b1.close - b1.open), body2 = Math.abs(b2.close - b2.open);
  const upWick1 = b1.high - Math.max(b1.open, b1.close), dnWick1 = Math.min(b1.open, b1.close) - b1.low;
  if (b1.close > b1.open && b2.close < b2.open && b1.close > b2.open && body1 > body2) lines.push('- pattern: bullish engulfing (bar terakhir)');
  else if (b1.close < b1.open && b2.close > b2.open && b1.close < b2.open && body1 > body2) lines.push('- pattern: bearish engulfing (bar terakhir)');
  else if (dnWick1 > 2 * body1 && dnWick1 > upWick1) lines.push('- pattern: pin bar bullish (lower-wick panjang — rejection bawah)');
  else if (upWick1 > 2 * body1 && upWick1 > dnWick1) lines.push('- pattern: pin bar bearish (upper-wick panjang — rejection atas)');

  // panel indikator lengkap — platform kasih semua, LLM pilih sendiri metodenya
  const closes = win.map((x) => x.close);
  const e20 = ema(closes, 20).slice(-1)[0];
  const e50 = ema(closes, 50).slice(-1)[0];
  const e200 = closes.length >= 200 ? ema(closes, 200).slice(-1)[0] : NaN;
  const s50 = closes.slice(-50).reduce((a, b) => a + b, 0) / Math.min(50, closes.length);
  // Bollinger 20,2
  const b20 = closes.slice(-20);
  const m = b20.reduce((a, b) => a + b, 0) / 20;
  const sd = Math.sqrt(b20.reduce((a, b) => a + (b - m) ** 2, 0) / 20);
  const bbUp = m + 2 * sd, bbLo = m - 2 * sd;
  const bbPct = sd > 0 ? (px - bbLo) / (2 * sd * 2) * 100 : 50;
  const bbWid = (bbUp - bbLo) / px * 100;
  // Stochastic %K/%D (14/3)
  const stochs = win.slice(-19).map((_, i, arr) => {
    const w = arr.slice(i, i + 14); if (w.length < 5) return NaN;
    const hh = Math.max(...w.map((x) => x.high)), ll = Math.min(...w.map((x) => x.low));
    return ((w[w.length - 1].close - ll) / (hh - ll || 1e-9)) * 100;
  }).filter(Number.isFinite);
  const k = stochs.slice(-1)[0];
  const d = stochs.slice(-3).reduce((a, b) => a + b, 0) / Math.min(3, stochs.length) || NaN;
  // OBV slope 5 bar
  let obv = 0; const obvRow: number[] = [];
  for (let i = 1; i < win.length; i++) { obv += win[i].close > win[i - 1].close ? win[i].volume : win[i].close < win[i - 1].close ? -win[i].volume : 0; obvRow.push(obv); }
  const obvSlope = obvRow.length >= 6 ? (obvRow[obvRow.length - 1] - obvRow[obvRow.length - 6]) : 0;
  const avgVol = win.slice(-20).reduce((a, x) => a + x.volume, 0) / Math.min(20, win.length) || 0;
  const volRatio = avgVol > 0 ? last.volume / avgVol : 0;
  lines.push(`- panel: EMA20=${e20.toFixed(4)} ${px > e20 ? '▲' : '▼'} · EMA50=${e50.toFixed(4)} ${px > e50 ? '▲' : '▼'}${Number.isFinite(e200) ? ` · EMA200=${e200.toFixed(4)} ${px > e200 ? '▲' : '▼'}` : ''} · SMA50=${s50.toFixed(4)} · BB%b=${bbPct.toFixed(0)}% width=${bbWid.toFixed(2)}% (mid=${m.toFixed(4)}) · Stoch %K=${k.toFixed(0)}/%D=${d.toFixed(0)} · RSI14=${rsi14(win).toFixed(0)} · ADX14=${adx14(win).toFixed(0)} · MACD=${macdState(win)} · OBV5=${obvSlope >= 0 ? '+' : ''}${obvSlope.toFixed(0)} · vol=${volRatio.toFixed(1)}x rata²20 · ATR%=${((a / px) * 100).toFixed(2)}%`);

  return lines.join('\n');
}

/* ---- Macro brief: DXY, VIX, US10Y — cache 15 menit, shared semua agen ---- */
let macroCache: { t: number; text: string } = { t: 0, text: '' };

export async function macroBrief(): Promise<string> {
  if (macroCache.t && Date.now() - macroCache.t < 15 * 60_000) return macroCache.text;
  const rows = await Promise.allSettled(
    ['yahoo:DX-Y.NYB', 'yahoo:^VIX', 'yahoo:^TNX'].map(async (raw) => {
      const a = parseAssetId(raw);
      const c = await fetchAssetCandles(a, '1d', 8);
      if (!c || c.length < 6) return null;
      const last = c[c.length - 1].close;
      const back = c[c.length - 6].close;
      const chg = ((last - back) / back) * 100;
      const label = raw.includes('DX') ? 'DXY (dollar index)' : raw.includes('VIX') ? 'VIX (fear)' : 'US10Y (yield)';
      return `${label}: ${last.toFixed(2)} · perubahan 5 hari ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%`;
    })
  );
  const ok = rows.filter((r) => r.status === 'fulfilled' && r.value).map((r) => (r as PromiseFulfilledResult<string>).value);
  const text = ok.join(' | ');
  if (ok.length) { macroCache.t = Date.now(); macroCache.text = text; }
  return text;
}
