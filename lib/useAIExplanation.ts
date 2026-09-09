import { useState, useCallback } from 'react';
import { MultiTimeframeResult } from './algorithms/multiTimeframe';
import { RegimeResult } from './algorithms/marketRegime';

export function useAIExplanation() {
  const [explanation, setExplanation] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchExplanation = useCallback(async (
    mtfResult: MultiTimeframeResult,
    regime?: RegimeResult | null
  ) => {
    setLoading(true);
    setExplanation(null);

    try {
      const payload = {
        asset: mtfResult.asset,
        regime: regime?.regime || 'unknown',
        regimeConfidence: regime?.confidence || 0,
        adxValue: regime?.adxValue || 0,
        atrPercent: regime?.atrPercent || 0,
        volPercentile: regime?.volatilityPercentile || 50,
        timeframes: mtfResult.timeframes.map((tf) => ({
          tf: tf.timeframe,
          trend: tf.trendDirection,
          rsZScore: tf.rsZScore,
          hasSignal: tf.signal !== null,
          signalType: tf.signal?.type,
          signalStrength: tf.signal?.strength,
          signalPrice: tf.signal?.price,
        })),
        confluenceScore: mtfResult.confluenceScore,
        confluenceDirection: mtfResult.confluenceDirection,
        finalSignal: mtfResult.finalSignal,
      };

      const response = await fetch('/api/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) throw new Error('Failed to fetch explanation');

      const data = await response.json();
      setExplanation(data.explanation);
    } catch (err) {
      setExplanation(null);
    } finally {
      setLoading(false);
    }
  }, []);

  return { explanation, loading, fetchExplanation };
}