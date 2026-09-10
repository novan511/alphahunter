import fs from 'fs';
import path from 'path';
import { Candle } from './types';

const CACHE_DIR = path.join(process.cwd(), '.cache', 'candles');
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6h for deep history

function ensureDir(): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}

function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function cachePath(key: string): string {
  return path.join(CACHE_DIR, `${safeKey(key)}.json`);
}

export function readCandleCache(key: string): Candle[] | null {
  try {
    const file = cachePath(key);
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as { expires: number; candles: Candle[] };
    if (!parsed?.candles?.length) return null;
    if (parsed.expires < Date.now()) return null;
    return parsed.candles;
  } catch {
    return null;
  }
}

export function writeCandleCache(
  key: string,
  candles: Candle[],
  ttlMs: number = DEFAULT_TTL_MS
): void {
  if (!candles.length) return;
  try {
    ensureDir();
    const payload = {
      expires: Date.now() + ttlMs,
      savedAt: Date.now(),
      count: candles.length,
      candles,
    };
    fs.writeFileSync(cachePath(key), JSON.stringify(payload), 'utf8');
  } catch (err) {
    console.warn('candle cache write failed', err);
  }
}

export function clearCandleCacheDir(): void {
  try {
    if (fs.existsSync(CACHE_DIR)) {
      for (const f of fs.readdirSync(CACHE_DIR)) {
        fs.unlinkSync(path.join(CACHE_DIR, f));
      }
    }
  } catch {
    /* ignore */
  }
}
