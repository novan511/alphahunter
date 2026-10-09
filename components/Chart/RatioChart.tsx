import React, { useEffect, useMemo, useRef } from 'react';
import { createChart, ColorType } from 'lightweight-charts';

interface RatioChartProps {
  times: number[];
  ratio: number[];
  up: boolean;
}

function getHeight(): number {
  if (typeof window === 'undefined') return 280;
  return window.innerWidth < 640 ? 220 : 280;
}

function sma(values: number[], period: number): Array<{ time: number; value: number } | null> {
  // Returns null for warm-up bars so the MA line starts only where defined.
  const out: Array<{ time: number; value: number } | null> = [];
  let acc = 0;
  for (let i = 0; i < values.length; i++) {
    acc += values[i];
    if (i >= period) acc -= values[i - period];
    out.push(i >= period - 1 ? { time: 0, value: acc / period } : null);
  }
  return out;
}

/**
 * Ratio chart: base/quote rebased to 100.
 * Rising = base strengthening against quote. Falling = weakening.
 * The 100 line is the anchor: above it, base has gained since the first bar.
 */
export default function RatioChart({ times, ratio, up }: RatioChartProps) {
  const ref = useRef<HTMLDivElement>(null);

  const ma = useMemo(() => sma(ratio, 20), [ratio]);
  const line = up ? '#10b981' : '#ef4444';

  useEffect(() => {
    if (!ref.current || times.length === 0) return;

    const chart = createChart(ref.current, {
      width: ref.current.clientWidth,
      height: getHeight(),
      layout: {
        background: { type: ColorType.Solid, color: '#0b1220' },
        textColor: '#6b7280',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(55, 65, 81, 0.3)' },
        horzLines: { color: 'rgba(55, 65, 81, 0.3)' },
      },
      crosshair: {
        vertLine: { color: 'rgba(59, 130, 246, 0.4)', width: 1, style: 2 },
        horzLine: { color: 'rgba(59, 130, 246, 0.4)', width: 1, style: 2 },
      },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#374151' },
      rightPriceScale: { borderColor: '#374151' },
    });

    const area = chart.addAreaSeries({
      lineColor: line,
      topColor: up ? 'rgba(16, 185, 129, 0.35)' : 'rgba(239, 68, 68, 0.35)',
      bottomColor: up ? 'rgba(16, 185, 129, 0.02)' : 'rgba(239, 68, 68, 0.02)',
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });
    area.setData(times.map((t, i) => ({ time: t as never, value: ratio[i] })));

    const maLine = chart.addLineSeries({
      color: '#3b82f6',
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    maLine.setData(
      ma
        .map((m, i) => (m ? { time: times[i] as never, value: m.value } : null))
        .filter((x): x is { time: never; value: number } => x !== null),
    );

    // Anchor at 100: everything above is base-gain territory.
    area.createPriceLine({
      price: 100,
      color: '#374151',
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: 'start',
    });

    chart.timeScale().fitContent();

    const onResize = () => {
      if (ref.current) {
        chart.applyOptions({ width: ref.current.clientWidth, height: getHeight() });
      }
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chart.remove();
    };
  }, [times, ratio, ma, line, up]);

  return <div ref={ref} style={{ width: '100%' }} />;
}
