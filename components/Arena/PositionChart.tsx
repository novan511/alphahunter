import React, { useEffect, useRef, useState } from 'react';
import { createChart, IChartApi, ISeriesApi, ColorType } from 'lightweight-charts';

export interface ArenaPositionChartProps {
  symbol: string; // 'binance:BTCUSDT' / 'yahoo:CL=F' style
  interval: string;
  side: string;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  entryTime: number;
  reason: string;
}

type Candle = { time: number; open: number; high: number; low: number; close: number };

/** Chart satu posisi arena: candle realtime + marker entry + garis SL/TP.
 *  Multiple asset yang dipantau → parent render satu komponen ini per posisi. */
export default function ArenaPositionChart(p: ArenaPositionChartProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const entryMarkerRef = useRef<ISeriesApi<'Candlestick'>['setMarkers'] | null>(null);
  const [live, setLive] = useState<{ px: number; t: number } | null>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const chart = createChart(el, {
      width: el.clientWidth,
      height: 220,
      layout: { background: { type: ColorType.Solid, color: '#0d1117' }, textColor: '#6b7280', fontSize: 9 },
      grid: { vertLines: { visible: false }, horzLines: { color: 'rgba(55,65,81,.25)' } },
      rightPriceScale: { borderColor: '#374151' },
      timeScale: { borderColor: '#374151', timeVisible: true, secondsVisible: false },
      crosshair: { mode: 1 },
    });
    chartRef.current = chart;
    const candles = chart.addCandlestickSeries({
      upColor: '#10b981', downColor: '#ef4444', borderUpColor: '#10b981', borderDownColor: '#ef4444', wickUpColor: '#10b981', wickDownColor: '#ef4444',
    });
    candleRef.current = candles;
    // garis level: entry (putus kuning), SL (merah), TP (hijau)
    const mkLine = (price: number, color: string, title: string, dash: number[] | undefined) =>
      candles.createPriceLine({ price, color, lineWidth: 1, lineStyle: dash ? 2 : 0, axisLabelVisible: true, title });
    const lines = [
      mkLine(p.entryPrice, '#fbbf24', 'ENTRY', [4, 3]),
      mkLine(p.stopLoss, '#ef4444', 'SL', [4, 3]),
      mkLine(p.takeProfit, '#10b981', 'TP', [4, 3]),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entryMarkerRef.current = (candles as any).setMarkers?.bind(candles) ?? null;
    return () => {
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
    };
  }, []);

  const load = async () => {
    try {
      const res = await fetch(`/api/arena-candles?symbol=${encodeURIComponent(p.symbol)}&interval=${encodeURIComponent(p.interval)}&limit=180`);
      const arr: Candle[] = await res.json();
      if (!Array.isArray(arr) || arr.length === 0 || !candleRef.current) return;
      candleRef.current.setData(
        arr.map((c) => ({ time: c.time as never, open: c.open, high: c.high, low: c.low, close: c.close }))
      );
      // mark live granular (5m) supaya floating PnL ikut bergerak, bukan menunggu roll 1h
      let markPx: number | null = null;
      try {
        const gr = await fetch(`/api/arena-candles?symbol=${encodeURIComponent(p.symbol)}&gran=1m&lastOnly=1`);
        const g: Candle[] = await gr.json();
        if (Array.isArray(g) && g.length) markPx = g[g.length - 1].close;
      } catch { /* mark dari candle 1h */ }
      // marker di mana entry dilakukan
      const entryBar = arr.find((c) => Math.abs(c.time * 1000 - p.entryTime) < 4 * 3600_000) || arr[arr.length - 1];
      entryMarkerRef.current?.([
        {
          time: entryBar.time as never,
          position: p.side === 'long' ? 'belowBar' : 'aboveBar',
          color: p.side === 'long' ? '#10b981' : '#ef4444',
          shape: p.side === 'long' ? 'arrowUp' : 'arrowDown',
          text: `${p.side.toUpperCase()} entry`,
        },
      ]);
      const last = arr[arr.length - 1];
      if (markPx) {
        setLive({ px: markPx, t: last.time * 1000 });
      } else {
        setLive({ px: last.close, t: last.time * 1000 });
      }
    } catch {
      /* biarkan chart sebelumnya; refresh berikutnya coba lagi */
    }
  };

  useEffect(() => {
    load();
    // realtime: poll candle terbaru tiap 45 dtk selama tab dibuka
    const id = setInterval(load, 45_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.symbol, p.interval]);

  const rUp = live && live.px >= p.entryPrice;
  const pnlR = live ? ((live.px - p.entryPrice) * (p.side === 'long' ? 1 : -1)) / Math.max(1e-9, Math.abs(p.entryPrice - p.stopLoss)) : 0;

  return (
    <div style={{ border: '1px solid #1f2937', borderRadius: 10, padding: 10, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <b style={{ color: '#f9fafb', fontSize: 13 }}>
          {p.side === 'long' ? '▲' : '▼'} {p.symbol.replace(/^[a-z]+:/i, '')} <span style={{ color: p.side === 'long' ? '#10b981' : '#ef4444' }}>{p.side}</span>
        </b>
        <span style={{ fontSize: 11, color: live ? (rUp ? '#10b981' : '#ef4444') : '#6b7280' }}>
          {live ? `last ${live.px.toPrecision(6)} · ${live.t ? new Date(live.t).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : ''} · ${pnlR >= 0 ? '+' : ''}${pnlR.toFixed(2)}R (floating)` : 'memuat…'}
        </span>
      </div>
      <div ref={boxRef} style={{ marginTop: 6 }} />
      <div style={{ fontSize: 10, color: '#6b7280', marginTop: 4, lineHeight: 1.4 }}>
        🟨 entry {p.entryPrice.toPrecision(6)} · 🟥 SL {p.stopLoss.toPrecision(6)} · 🟩 TP {p.takeProfit > 0 ? p.takeProfit.toPrecision(6) : '—'} · bar {p.interval} · realtime 45 dtk · <span style={{ color: '#9ca3af' }}>{p.reason.slice(0, 90)}</span>
      </div>
    </div>
  );
}
