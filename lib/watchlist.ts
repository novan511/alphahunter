'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * The trader's own pinned assets — distinct from the system's "near-miss"
 * watchlist in lib/algorithms/tradeable.ts, which is computed from the scan.
 * This one is user intent: "I am tracking these, always show them first."
 *
 * Backed by localStorage so it survives refresh without needing an account.
 */

const STORAGE_KEY = 'althunter:watchlist:v1';

export function loadWatchlist(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string').slice(0, 100);
  } catch {
    return [];
  }
}

function saveWatchlist(items: string[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // storage full / private mode — the in-memory state still works this session
  }
}

export interface WatchlistApi {
  /** Assets the user has starred, in toggle order. */
  items: string[];
  /** True once mounted — lets the UI avoid flashing "0 stars" before hydration. */
  ready: boolean;
  isWatched: (asset: string) => boolean;
  toggle: (asset: string) => void;
}

export function useWatchlist(): WatchlistApi {
  const [items, setItems] = useState<string[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setItems(loadWatchlist());
    setReady(true);
  }, []);

  const toggle = useCallback((asset: string) => {
    setItems((prev) => {
      const next = prev.includes(asset)
        ? prev.filter((a) => a !== asset)
        : [...prev, asset];
      saveWatchlist(next);
      return next;
    });
  }, []);

  const isWatched = useCallback(
    (asset: string) => items.includes(asset),
    [items]
  );

  return { items, ready, isWatched, toggle };
}
