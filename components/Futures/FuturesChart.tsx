import React, { useEffect, useRef } from 'react';
import { createChart, IChartApi, ISeriesApi, CandlestickData, ColorType } from 'lightweight-charts';
import type { Candle } from '../../lib/types';
import { ema, sma, rsi } from '../../lib/algorithms/indicators';

interface FuturesChartProps {
  candles: Candle[];
  /** Bar time of the freshest signal, drawn as a marker. */
  marker?: { time: number; type: 'buy' | 'sell' } | null;
  height?: number;
}

/** Periods must match lib/futures.ts evaluateTimeframe for the active tf (4h). */
const MA_FAST_PERIOD = 20;
const MA_SLOW_PERIOD = 50;
const RSI_PERIOD = 14;

type LineSeries = ISeriesApi<'Line'>;

/** Convert indicator array + candles into lightweight-charts line points, dropping NaN. */
function toLinePoints(
  candles: Candle[],
  values: number[]
): { time: CandlestickData['time']; value: number }[] {
  return candles
    .slice(-120)
    .map((c, i) => {
      const idx = candles.length - 120 + i;
      const v = values[idx] ?? NaN;
      return Number.isFinite(v) ? { time: c.time as CandlestickData['time'], value: v } : null;
    })
    .filter((p): p is { time: CandlestickData['time']; value: number } => p !== null);
}

export default function FuturesChart({ candles, marker, height = 200 }: FuturesChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const emaRef = useRef<LineSeries | null>(null);
  const smaRef = useRef<LineSeries | null>(null);
  const rsiRef = useRef<LineSeries | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || candles.length === 0) return;

    const closes = candles.map((c) => c.close);
    const emaValues = ema(closes, MA_FAST_PERIOD);
    const smaValues = sma(closes, MA_SLOW_PERIOD);
    const rsiValues = rsi(closes, RSI_PERIOD);

    const chart = createChart(el, {
      width: el.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: '#111827' },
        textColor: '#6b7280',
        fontSize: 9,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: 'rgba(55, 65, 81, 0.25)' } },
      rightPriceScale: { borderColor: '#374151', scaleMargins: { top: 0.15, bottom: 0.2 } },
      timeScale: { borderColor: '#374151', timeVisible: true, secondsVisible: false },
      crosshair: { mode: 1 },
      handleScale: { axisPressedMouseMove: false },
    });
    chartRef.current = chart;

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#10b981',
      downColor: '#ef4444',
      borderVisible: false,
      wickUpColor: '#10b981',
      wickDownColor: '#ef4444',
    });
    candleRef.current = candleSeries;

    const candleData: CandlestickData[] = candles.slice(-120).map((c) => ({
      time: c.time as CandlestickData['time'],
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    candleSeries.setData(candleData);

    // EMA(20) — blue line on main pane
    const emaSeries = chart.addLineSeries({
      color: '#3b82f6',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    emaRef.current = emaSeries;
    emaSeries.setData(toLinePoints(candles, emaValues));

    // SMA(50) — light blue line on main pane
    const smaSeries = chart.addLineSeries({
      color: '#93c5fd',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    smaRef.current = smaSeries;
    smaSeries.setData(toLinePoints(candles, smaValues));

    // RSI(14) — orange line on its own price scale (right side)
    const rsiSeries = chart.addLineSeries({
      priceScaleId: 'rsi',
      color: '#f59e0b',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    rsiRef.current = rsiSeries;
    rsiSeries.setData(toLinePoints(candles, rsiValues));
    chart.priceScale('rsi').applyOptions({ scaleMargins: { top: 0.7, bottom: 0.05 } });

    if (marker) {
      candleSeries.setMarkers([
        {
          time: marker.time as CandlestickData['time'],
          position: marker.type === 'buy' ? 'belowBar' : 'aboveBar',
          color: marker.type === 'buy' ? '#22c55e' : '#f97316',
          shape: marker.type === 'buy' ? 'arrowUp' : 'arrowDown',
          text: marker.type === 'buy' ? 'BUY' : 'SELL',
        },
      ]);
    }

    chart.timeScale().fitContent();

    const onResize = () => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth, height });
      }
    };
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      emaRef.current = null;
      smaRef.current = null;
      rsiRef.current = null;
    };
  }, [candles, marker, height]);

  return (
    <div ref={containerRef} style={{ width: '100%', position: 'relative' }}>
      <div style={{
        position: 'absolute',
        bottom: 2,
        left: 4,
        right: 4,
        display: 'flex',
        gap: '8px',
        fontSize: '9px',
        color: '#9ca3af',
        pointerEvents: 'none',
      }}>
        <span style={{ color: '#3b82f6', fontWeight: 800 }}>EMA20</span>
        <span style={{ color: '#93c5fd', fontWeight: 800 }}>SMA50</span>
        <span style={{ color: '#f59e0b', fontWeight: 800 }}>RSI14</span>
      </div>
    </div>
  );
}
