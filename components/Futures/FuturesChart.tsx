import React, { useEffect, useRef } from 'react';
import { createChart, IChartApi, ISeriesApi, CandlestickData, ColorType } from 'lightweight-charts';
import type { Candle } from '../../lib/types';

interface FuturesChartProps {
  candles: Candle[];
  /** Bar time of the freshest signal, drawn as a marker. */
  marker?: { time: number; type: 'buy' | 'sell' } | null;
  height?: number;
}

/**
 * One instrument card chart.
 *
 * Deliberately its own component rather than a reuse of DecouplingChart: that
 * one keys its series off a `DecouplingSignal` list and sizes itself for a
 * full-width detail panel, while these cards are a dense grid where 13 live
 * charts must each own and release their instance independently.
 */
export default function FuturesChart({ candles, marker, height = 150 }: FuturesChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || candles.length === 0) return;

    const chart = createChart(el, {
      width: el.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: '#111827' },
        textColor: '#6b7280',
        fontSize: 10,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: 'rgba(55, 65, 81, 0.25)' } },
      rightPriceScale: { borderColor: '#374151', scaleMargins: { top: 0.15, bottom: 0.15 } },
      timeScale: { borderColor: '#374151', timeVisible: true, secondsVisible: false },
      crosshair: { mode: 1 },
      handleScale: { axisPressedMouseMove: false },
    });
    chartRef.current = chart;

    const series = chart.addCandlestickSeries({
      upColor: '#10b981',
      downColor: '#ef4444',
      borderVisible: false,
      wickUpColor: '#10b981',
      wickDownColor: '#ef4444',
    });
    seriesRef.current = series;

    const data: CandlestickData[] = candles.slice(-120).map((c) => ({
      time: c.time as CandlestickData['time'],
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    series.setData(data);

    if (marker) {
      series.setMarkers([
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
      seriesRef.current = null;
    };
  }, [candles, marker, height]);

  return <div ref={containerRef} style={{ width: '100%' }} />;
}
