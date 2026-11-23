/**
 * Minimal structured logging — one JSON object per line.
 *
 * Log metadata only, never message text or tokens. Vercel's log drain can
 * ingest this as-is, and a future dashboard can group by `event`.
 */

export type LogLevel = 'info' | 'warn' | 'error';

export function logEvent(
  event: string,
  fields: Record<string, unknown> = {},
  level: LogLevel = 'info'
): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/** Chat ids are identifying — keep only the last few digits in logs. */
export function maskChatId(chatId: string | number): string {
  const s = String(chatId);
  return s.length <= 4 ? '****' : `****${s.slice(-4)}`;
}
