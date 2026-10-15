import {
  evaluateTimeframe,
  macroNoteFor,
  closedBars,
  closedBarTime,
  alignmentTimeframes,
  FUTURES_INSTRUMENTS,
  FUTURES_TIMEFRAMES,
  type Verdict,
} from '../lib/futures';
import { diffAlerts, buildAlertMessage, fitMessage } from '../lib/futuresAlert';
import type { Candle } from '../lib/types';
import type { FuturesSignal } from '../lib/futuresBook';

/**
 * Assert-based self-check for the futures verdict logic.
 *
 * Two parts: synthetic candles must produce the verdict their shape implies,
 * and one live venue call must return real bars for a builder perp — the xyz
 * dex addressing is the thing most likely to silently return [].
 */

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Deterministic candles: `drift` per bar, `vol` noise, flat volume unless varied. */
function synth(n: number, drift: number, noiseAmp: number, vol = 1000): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    // Fixed pseudo-noise so the run is reproducible.
    const noise = Math.sin(i * 1.7) * noiseAmp;
    const open = price;
    const close = open * (1 + drift + noise * 0.001);
    out.push({
      time: 1700000000 + i * 3600,
      open,
      high: Math.max(open, close) * 1.001,
      low: Math.min(open, close) * 0.999,
      close,
      volume: vol,
    });
    price = close;
  }
  return out;
}

function verdictOf(candles: Candle[], tf: string): Verdict {
  return evaluateTimeframe(candles, tf).verdict;
}

console.log('evaluateTimeframe');
check('uptrend 1h → long', verdictOf(synth(200, 0.004, 8), '1h') === 'long');
check('downtrend 1h → short', verdictOf(synth(200, -0.004, 8), '1h') === 'short');
check('flat 1h → wait', verdictOf(synth(200, 0, 3), '1h') === 'wait');
check('uptrend 4h → long', verdictOf(synth(200, 0.002, 6), '4h') === 'long');
check('uptrend 1w → long', verdictOf(synth(120, 0.006, 5), '1w') === 'long');

const scored = evaluateTimeframe(synth(200, 0.004, 8), '1h');
check('score is a 0..1 fraction', scored.score > 0 && scored.score <= 1, String(scored.score));
check('long produces at least 2 reasons', scored.reasons.length >= 2);

// Volume confirmation must be able to break a tie on its own.
const quiet = evaluateTimeframe(synth(200, 0, 3), '1h');
check('flat tape stays wait even with volume', quiet.verdict === 'wait');

console.log('macroNoteFor');
const highYield = {
  dxy: 105, dxyChangePct: 0.4, vix: 22, vixChangePct: 2,
  us10y: 4.6, fedFunds: 5.25, cpiYoY: 3.1, asOf: '2026-10-13', errors: [],
};
check('high yield warns on commodity', macroNoteFor('commodity', highYield).includes('yield AS'));
check('risk-off warns on equity', macroNoteFor('equity', highYield).includes('risk-off'));
check('risk-off + strong dxy warns on crypto', macroNoteFor('crypto', highYield).includes('risk-off'));
const calm = { ...highYield, dxyChangePct: -0.4, vix: 13, vixChangePct: -3, us10y: 3.6 };
check('weak dxy supports equity', macroNoteFor('equity', calm).includes('angin belakang'));
check('always says something', macroNoteFor('crypto', calm).startsWith('Macro:'));

console.log('universe');
check('13 instruments', FUTURES_INSTRUMENTS.length === 13, String(FUTURES_INSTRUMENTS.length));
check('all on hyperliquid', FUTURES_INSTRUMENTS.every((i) => i.asset.source === 'hyperliquid'));
check(
  'commodities + equities use the xyz dex',
  FUTURES_INSTRUMENTS.filter((i) => i.group !== 'crypto').every((i) => i.id.startsWith('hyperliquid:xyz:'))
);
check('6 timeframes', FUTURES_TIMEFRAMES.length === 6);

console.log('closedBars / alignment');
{
  // A bar stamped 1 minute ago on the 1h timeframe is still forming: drop it.
  const now = Math.floor(Date.now() / 1000);
  const bars: Candle[] = [1, 2, 3].map((i) => ({
    time: now - (3 - i) * 3600,
    open: 100, high: 101, low: 99, close: 100, volume: 10,
  }));
  bars[bars.length - 1].time = now - 60;
  check('in-progress bar is dropped', closedBars(bars, '1h').length === bars.length - 1);
  check('closedBarTime skips the forming bar', closedBarTime(bars, '1h') === bars[bars.length - 2].time);
  check('5m aligns to 1d+1w', JSON.stringify(alignmentTimeframes('5m')) === '["1d","1w"]');
  check('1h aligns to 1d+1w', JSON.stringify(alignmentTimeframes('1h')) === '["1d","1w"]');
  check('1d aligns to 1w only', JSON.stringify(alignmentTimeframes('1d')) === '["1w"]');
  check('1w aligns to nothing', alignmentTimeframes('1w').length === 0);
}

console.log('diffAlerts');
// Minimal signal factory: only the fields diffAlerts reads.
function sig(
  symbol: string,
  verdict: Verdict,
  barTime = 1000,
  group: 'crypto' | 'commodity' | 'equity' = 'crypto'
): FuturesSignal {
  return {
    instrument: { rawId: 'x', id: `hyperliquid:${symbol}`, symbol, name: symbol, group, asset: {} as never },
    verdict, score: 70, price: 100, barTime, changePct: 0.01,
    stop: 98, target: 104, atrPct: 1, reasons: ['r1', 'r2'],
    macroNote: 'Macro: netral.', candles: [], alignment: [], lastSignal: null,
  };
}
{
  const resp = { tf: '1h', signals: [sig('BTC', 'long')], missing: [] as string[] };
  const first = diffAlerts(resp, null);
  check('first run is baseline, no alerts', first.baseline && first.alerts.length === 0);
  const steady = diffAlerts(resp, first.next);
  check('steady signal never re-alerts', steady.alerts.length === 0);
  const flip = diffAlerts({ tf: '1h', signals: [sig('BTC', 'short', 4600)], missing: [] }, first.next);
  check('long->short alerts with from=long', flip.alerts.length === 1 && flip.alerts[0].from === 'long');
  const exit = diffAlerts({ tf: '1h', signals: [sig('BTC', 'wait', 8200)], missing: [] }, flip.next);
  check('short->wait alerts as exit', exit.alerts.length === 1 && exit.alerts[0].verdict === 'wait');
  const blocked = diffAlerts({ tf: '1h', signals: [sig('BTC', 'long', 9000)], missing: ['ETH'] }, exit.next);
  check('incomplete book blocks push', blocked.blocked && blocked.alerts.length === 0);

  // The old code rendered a decayed long as "SHORT". It must read as an exit.
  const waitMsg = buildAlertMessage('1h', exit.alerts, {
    dxy: 100, dxyChangePct: 0, vix: 15, vixChangePct: 0, us10y: 4,
    fedFunds: 4, cpiYoY: 3, asOf: null, errors: [],
  });
  check('wait alert reads as exit, not short', waitMsg.includes('WAIT') && !waitMsg.includes('SHORT BTC'));
  const longMsg = buildAlertMessage('1h', flip.alerts, {
    dxy: 100, dxyChangePct: 0, vix: 15, vixChangePct: 0, us10y: 4,
    fedFunds: 4, cpiYoY: 3, asOf: null, errors: [],
  });
  check('long/short message carries SL+TP', longMsg.includes('SL') && longMsg.includes('TP'));
  const huge = buildAlertMessage('1h', Array.from({ length: 30 }, (_, i) => ({ ...flip.alerts[0], symbol: `S${i}` })), {
    dxy: 100, dxyChangePct: 0, vix: 15, vixChangePct: 0, us10y: 4,
    fedFunds: 4, cpiYoY: 3, asOf: null, errors: [],
  });
  check('fitMessage keeps under limit by dropping whole alerts', fitMessage(huge).length <= 3900);
}

async function main() {
  // Live check: the builder-dex addressing is the part that can silently break.
  const { fetchHyperliquidCandles } = await import('../lib/marketData');
  for (const coin of ['xyz:GOLD', 'xyz:NVDA', 'BTC']) {
    try {
      const candles = await fetchHyperliquidCandles(coin, '1h', 50);
      check(`live ${coin} returns candles`, candles.length > 10, `got ${candles.length}`);
    } catch (err) {
      check(`live ${coin} returns candles`, false, String(err));
    }
  }

  console.log(failures === 0 ? 'FUTURES_OK' : `FUTURES_FAILURES=${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
