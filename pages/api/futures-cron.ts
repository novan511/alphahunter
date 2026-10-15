import type { NextApiRequest, NextApiResponse } from 'next';
import { loadFutures, missingSymbols } from '../../lib/futures';
import {
  buildAlertMessage,
  diffAlerts,
  fitMessage,
  type AlertState,
} from '../../lib/futuresAlert';
import { sendTelegramMessage, telegramEnv } from '../../lib/serverTelegram';
import { getSupabase, isSupabaseConfigured } from '../../lib/supabase';
import { FUTURES_TIMEFRAMES } from '../../lib/futuresBook';

export const config = { maxDuration: 60 };

/**
 * Futures auto-scan: price the book on a schedule and push only what changed.
 *
 * A cron that re-sends the current book every 30 minutes is noise, and the
 * trader stops reading it. So each run diffs against the last push (persisted
 * in futures_alert_state) and sends only instruments whose verdict CHANGED —
 * including long/short -> wait, which is the exit the trader must not miss.
 *
 * Two hard refusals, because a wrong "no signal" is the worst thing this can
 * say: an incomplete book never pushes, and a failed send never advances the
 * dedupe state (otherwise the next run would see "already sent" and the alert
 * would be lost, not delayed).
 *
 * Auth: requires SCAN_CRON_SECRET, same as /api/scan-cron.
 */

interface Body {
  tf?: string;
  /** Set false to compute and store state without sending — for wiring tests. */
  notify?: boolean;
  /** Set true to ignore the diff and send the full book once. */
  force?: boolean;
}

const STATE_ID_PREFIX = 'futures:';
const VALID_TF = new Set(FUTURES_TIMEFRAMES.map((t) => t.tf));

function authorized(req: NextApiRequest): boolean {
  const secret = process.env.SCAN_CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ') && header.slice(7) === secret) return true;
  return req.headers['x-vercel-cron'] != null;
}

async function readState(id: string): Promise<AlertState | null> {
  if (!isSupabaseConfigured()) return null;
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('futures_alert_state')
    .select('state')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`read state: ${error.message}`);
  return (data?.state as AlertState | undefined) ?? null;
}

async function writeState(id: string, state: AlertState, sent: number): Promise<void> {
  if (!isSupabaseConfigured()) return;
  const supabase = getSupabase();
  if (!supabase) return;
  const { error } = await supabase.from('futures_alert_state').upsert({
    id,
    state,
    last_sent_count: sent,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`write state: ${error.message}`);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET,POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!authorized(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const body: Body = { ...(req.query as Body), ...(req.body as Body) };
  const tf = body.tf && VALID_TF.has(body.tf) ? body.tf : '1h';
  const stateId = `${STATE_ID_PREFIX}${tf}`;

  let loaded;
  try {
    loaded = await loadFutures(tf);
  } catch (err) {
    return res.status(502).json({
      error: err instanceof Error ? err.message : 'load failed',
    });
  }

  const missing = missingSymbols(loaded);
  const signals = loaded.signals;

  // A state-read failure must stop the run here. The old code sent the 502
  // inside .catch() and then kept going, which tried to send a second
  // response and crashed the route — and worse, would have diffed against
  // null (baseline) and treated everything as already-seen.
  let previous: AlertState | null;
  try {
    previous = await readState(stateId);
  } catch (err) {
    return res.status(502).json({
      error: err instanceof Error ? err.message : 'state read failed',
    });
  }

  const wantsNotify = body.notify !== false;

  // Without Supabase there is no dedupe cursor, so every tick would look like
  // a first run and re-send the baseline message every 30 minutes — the exact
  // noise that trains the trader to mute the bot. Refuse to push; dry runs
  // (notify=false) still work for wiring checks. The migration is
  // supabase/migrations/010_futures_alert_state.sql.
  if (!isSupabaseConfigured() && wantsNotify) {
    return res.status(200).json({
      ok: false,
      tf,
      reason: 'supabase tidak dikonfigurasi — dedupe state tidak ada, push ditolak agar tidak spam baseline tiap tick',
      scanned: signals.length,
      missing,
      notify: wantsNotify,
    });
  }

  // force=true replays the full book of live sides once (for the wiring test),
  // by diffing against an empty history instead of the stored one.
  const diff = diffAlerts({ tf, signals, missing }, body.force ? {} : previous);

  // Refuse to advance state on a failed send: otherwise the next run would see
  // "already sent" and the alert would be lost, not delayed.
  if (diff.blocked) {
    return res.status(200).json({
      ok: false,
      reason: 'incomplete book — tidak ada push yang dikirim',
      missing,
      tf,
    });
  }

  const activeCount = signals.filter((s) => s.verdict !== 'wait').length;
  let message = '';
  if (diff.baseline) {
    message = buildAlertMessage(tf, diff.alerts, loaded.macro, {
      baseline: true,
      missing,
    });
  } else if (diff.alerts.length > 0) {
    message = fitMessage(buildAlertMessage(tf, diff.alerts, loaded.macro));
  }

  let sent = false;
  let sendError: string | undefined;
  if (message && wantsNotify) {
    if (!telegramEnv().configured) {
      sendError = 'Telegram belum dikonfigurasi (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)';
    } else {
      const result = await sendTelegramMessage(message);
      sent = result.ok;
      sendError = result.error;
    }
  }

  /**
   * Persist only when nothing is lost: either there was nothing to say, or the
   * message went out. A failed send must leave the old state in place so the
   * next tick still sees the alert as new — losing it is the one miss that
   * cannot be repaired after the fact.
   */
  const canPersist = !message || (wantsNotify && sent) || !wantsNotify;
  if (wantsNotify && message && sendError) {
    return res.status(200).json({
      ok: false,
      tf,
      reason: 'push gagal — state tidak disimpan, akan dicoba lagi di tick berikutnya',
      sendError,
      alerts: diff.alerts.length,
    });
  }

  try {
    if (isSupabaseConfigured()) {
      await writeState(stateId, diff.next, diff.alerts.length);
    }
  } catch (err) {
    return res.status(502).json({
      error: err instanceof Error ? err.message : 'state write failed',
      note: 'pesan sudah dikirim; dedupe state gagal disimpan',
    });
  }

  return res.status(200).json({
    ok: !sendError,
    tf,
    scanned: signals.length,
    missing,
    active: activeCount,
    alerts: diff.alerts.length,
    baseline: diff.baseline,
    sent,
    sendError,
    notify: wantsNotify,
    stateSaved: canPersist && isSupabaseConfigured(),
    // Surfaced for the wiring check and for dry runs.
    preview: message || undefined,
  });
}
