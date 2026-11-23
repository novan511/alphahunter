import { describe, expect, it } from 'vitest';
import {
  consumePending,
  isPendingValid,
  peekPending,
  storePending,
  type PendingRequest,
} from '../pages/api/telegram-webhook';
import type { PendingConfirmation } from '../lib/agent/types';

const NOW = 1_000_000;
const TTL = 5 * 60 * 1000;

function pending(token: string, expiresAt = NOW + TTL): PendingConfirmation {
  return {
    token,
    toolName: 'send_telegram_notification',
    args: { text: 'halo' },
    description: 'kirim notifikasi',
    expiresAt,
  };
}

function entry(token: string, expiresAt = NOW + TTL): PendingRequest {
  return { pending: pending(token, expiresAt), question: 'analisis BTC', chatId: '12345' };
}

describe('pending-confirmation store (helper murni)', () => {
  it('isPendingValid memakai expiresAt (TTL 5 menit)', () => {
    expect(isPendingValid(entry('a', NOW + TTL), NOW)).toBe(true);
    expect(isPendingValid(entry('a', NOW - 1), NOW)).toBe(false);
    expect(isPendingValid(entry('a', NOW), NOW)).toBe(false);
  });

  it('storePending + peekPending mengembalikan entri tanpa menghapus', () => {
    storePending('peek-1', entry('peek-1'));
    expect(peekPending('peek-1', NOW)?.question).toBe('analisis BTC');
    // peek tidak mengonsumsi — masih bisa dibaca lagi.
    expect(peekPending('peek-1', NOW)?.chatId).toBe('12345');
  });

  it('consumePending bersifat single-use', () => {
    storePending('consume-1', entry('consume-1'));
    expect(consumePending('consume-1', NOW)?.pending.token).toBe('consume-1');
    expect(peekPending('consume-1', NOW)).toBeUndefined();
    expect(consumePending('consume-1', NOW)).toBeUndefined();
  });

  it('entri kedaluwarsa dihapus dan tidak bisa dikonfirmasi', () => {
    storePending('expired-1', entry('expired-1', NOW - 1));
    expect(peekPending('expired-1', NOW)).toBeUndefined();
    expect(consumePending('expired-1', NOW)).toBeUndefined();
  });

  it('token tidak dikenal mengembalikan undefined', () => {
    expect(peekPending('tidak-ada', NOW)).toBeUndefined();
    expect(consumePending('tidak-ada', NOW)).toBeUndefined();
  });
});
