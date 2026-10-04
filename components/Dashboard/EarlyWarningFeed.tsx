import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { EarlyWarning } from '../../lib/algorithms/earlyWarning';
import {
  checkTelegramConfigured,
  isTelegramEnabled,
  sendTelegramText,
  setTelegramEnabled,
} from '../../lib/telegram';

interface EarlyWarningFeedProps {
  warnings: EarlyWarning[];
  /** History depth: how many scans back the velocity/streak is computed from. */
  historyDepth: number;
  onFocusCategory: (id: string | null) => void;
  onSelectAsset: (symbol: string) => void;
  focusedCategory?: string | null;
}

const SEV_META = {
  high: { label: 'SEGERA', color: '#ef4444', bg: 'rgba(239,68,68,0.12)', border: 'rgba(239,68,68,0.45)' },
  medium: { label: 'PANTAU', color: '#f59e0b', bg: 'rgba(245,158,11,0.10)', border: 'rgba(245,158,11,0.4)' },
  info: { label: 'INFO', color: '#38bdf8', bg: 'rgba(56,189,248,0.08)', border: 'rgba(56,189,248,0.35)' },
} as const;

const NOTIF_KEY = 'althunter:early-warn-notified:v1';
const DISMISS_KEY = 'althunter:early-warn-dismissed:v1';

function loadSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveSet(key: string, s: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify(Array.from(s).slice(-200)));
  } catch {
    // ignore
  }
}

export default function EarlyWarningFeed({
  warnings,
  historyDepth,
  onFocusCategory,
  onSelectAsset,
  focusedCategory,
}: EarlyWarningFeedProps) {
  const [dismissed, setDismissed] = useState<Set<string>>(() => loadSet(DISMISS_KEY));
  const [notifyOn, setNotifyOn] = useState(false);
  const notifiedRef = useRef<Set<string>>(loadSet(NOTIF_KEY));
  const [tgConfigured, setTgConfigured] = useState<boolean | null>(null);
  const [tgEnabled, setTgEnabled] = useState<boolean>(() => isTelegramEnabled());
  const [tgTestState, setTgTestState] = useState<'idle' | 'sending' | 'ok' | 'fail'>('idle');
  const [tgTestError, setTgTestError] = useState<string | null>(null);

  const visible = useMemo(
    () => warnings.filter((w) => !dismissed.has(w.id)),
    [warnings, dismissed]
  );
  const highs = visible.filter((w) => w.severity === 'high').length;

  const dismiss = (id: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      saveSet(DISMISS_KEY, next);
      return next;
    });
  };

  const resetDismissed = () => {
    setDismissed(new Set());
    saveSet(DISMISS_KEY, new Set());
  };

  // Telegram server status — checked once so the toggle shows the truth.
  useEffect(() => {
    let cancelled = false;
    void checkTelegramConfigured().then((ok) => {
      if (!cancelled) setTgConfigured(ok);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleTg = () => {
    const next = !tgEnabled;
    setTgEnabled(next);
    setTelegramEnabled(next);
  };

  const sendTgTest = async () => {
    setTgTestState('sending');
    setTgTestError(null);
    const r = await sendTelegramText(
      'Althunter tersambung. Pesan test ini berarti notif Telegram aktif — peringatan SEGERA berikutnya akan masuk ke chat ini.'
    );
    if (r.ok) {
      setTgTestState('ok');
    } else {
      setTgTestState('fail');
      setTgTestError(r.error ?? 'gagal');
    }
  };

  // Browser notification for NEW high-severity warnings only.
  useEffect(() => {
    if (!notifyOn || typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;
    for (const w of warnings) {
      if (w.severity !== 'high') continue;
      if (notifiedRef.current.has(w.id)) continue;
      notifiedRef.current.add(w.id);
      try {
        new Notification(`🔥 ${w.title}`, {
          body: `${w.coins.slice(0, 4).map((c) => c.ticker).join(', ') || '—'}\n${w.detail.slice(0, 120)}`,
        });
      } catch {
        // headless / denied — in-app feed remains the source of truth
      }
    }
    saveSet(NOTIF_KEY, notifiedRef.current);
  }, [warnings, notifyOn]);

  const enableNotify = async () => {
    if (typeof Notification === 'undefined') return;
    try {
      const p = await Notification.requestPermission();
      setNotifyOn(p === 'granted');
    } catch {
      setNotifyOn(false);
    }
  };

  return (
    <div
      style={{
        background: highs > 0 ? 'linear-gradient(180deg, rgba(239,68,68,0.08), #111827 60%)' : '#111827',
        borderRadius: '12px',
        border: `1px solid ${highs > 0 ? 'rgba(239,68,68,0.4)' : '#374151'}`,
        overflow: 'hidden',
      }}
    >
      <div className="ah-panel-head" style={{ padding: '12px 16px', borderBottom: '1px solid #374151' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '15px' }}>{highs > 0 ? '🚨' : '📡'}</span>
          <div>
            <h3 style={{ fontSize: '14px', fontWeight: '700', color: '#f9fafb', margin: 0 }}>
              Early Warning {highs > 0 && <span style={{ color: '#ef4444' }}>· {highs} segera</span>}
            </h3>
            <p style={{ fontSize: '10px', color: '#6b7280', margin: 0 }}>
              {warnings.length === 0
                ? 'Belum ada peringatan — pasar belum menunjukkan rotasi yang cukup kuat.'
                : `${visible.length} aktif dari histori ${historyDepth} snapshot`}
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
          {dismissed.size > 0 && (
            <button
              onClick={resetDismissed}
              style={{ background: 'none', border: 'none', color: '#3b82f6', cursor: 'pointer', fontSize: '10px', fontWeight: 600 }}
            >
              Tampilkan lagi ({dismissed.size})
            </button>
          )}
          {typeof Notification !== 'undefined' && (
            <button
              onClick={notifyOn ? () => setNotifyOn(false) : enableNotify}
              title="Notifikasi browser hanya untuk peringatan SEGERA yang baru"
              style={{
                padding: '4px 10px',
                borderRadius: '6px',
                border: `1px solid ${notifyOn ? '#10b98166' : '#374151'}`,
                background: notifyOn ? 'rgba(16,185,129,0.14)' : 'transparent',
                color: notifyOn ? '#10b981' : '#9ca3af',
                fontSize: '10px',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {notifyOn ? '🔔 Notif on' : '🔕 Notif off'}
            </button>
          )}
        </div>
      </div>

      {visible.length === 0 ? (
        <div style={{ padding: '14px 16px', fontSize: '11px', color: '#6b7280', lineHeight: 1.6 }}>
          {warnings.length === 0 ? (
            <>
              Tidak ada sektor yang flip ke fase <b style={{ color: '#f59e0b' }}>early</b> saat ini.
              Sistem membandingkan snapshot antar-scan: kalau 1h/4h suatu sektor mulai naik sementara
              hariannya belum, alert muncul di sini <i>sebelum</i> tren terkonfirmasi. Jalankan scan
              berkala — makin banyak snapshot, makin akurat velocity-nya.
            </>
          ) : (
            'Semua peringatan di-dismiss. Klik “Tampilkan lagi” untuk mengembalikannya.'
          )}
        </div>
      ) : (
        <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {visible.map((w) => {
            const sev = SEV_META[w.severity];
            const focused = focusedCategory === w.sectorId;
            return (
              <div
                key={w.id}
                style={{
                  background: sev.bg,
                  border: `1px solid ${sev.border}`,
                  borderLeft: `3px solid ${w.sectorColor}`,
                  borderRadius: '10px',
                  padding: '10px 12px',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '13px' }}>{w.sectorIcon}</span>
                    <span style={{ fontSize: '12px', fontWeight: '700', color: '#f9fafb' }}>{w.title}</span>
                    <span style={{
                      padding: '1px 6px', borderRadius: '4px', fontSize: '9px', fontWeight: 800,
                      background: `${sev.color}22`, color: sev.color,
                    }}>
                      {sev.label}
                    </span>
                    {w.streak >= 2 && w.kind !== 'watch' && (
                      <span style={{ fontSize: '9px', color: '#6b7280' }}>· {w.streak}x scan</span>
                    )}
                    {w.velocity != null && w.velocity >= 4 && (
                      <span style={{ fontSize: '9px', color: '#f59e0b', fontWeight: 700 }}>
                        · +{w.velocity.toFixed(0)}/scan
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button
                      onClick={() => onFocusCategory(focused ? null : w.sectorId)}
                      title={focused ? 'Lepas filter sektor' : 'Filter ranking ke sektor ini'}
                      style={{
                        padding: '3px 9px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                        border: `1px solid ${focused ? w.sectorColor : '#374151'}`,
                        background: focused ? `${w.sectorColor}22` : 'transparent',
                        color: focused ? w.sectorColor : '#9ca3af',
                        cursor: 'pointer',
                      }}
                    >
                      {focused ? '✓ Sektor' : 'Lihat sektor'}
                    </button>
                    <button
                      onClick={() => dismiss(w.id)}
                      aria-label="Dismiss peringatan"
                      style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: '14px', padding: '0 2px' }}
                    >
                      ×
                    </button>
                  </div>
                </div>

                <p style={{ fontSize: '11px', color: '#d1d5db', lineHeight: 1.55, margin: '8px 0' }}>
                  {w.detail}
                </p>

                {w.coins.length > 0 && (
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {w.coins.map((c) => (
                      <button
                        key={c.asset}
                        onClick={() => onSelectAsset(c.asset)}
                        title={
                          c.source === 'trade'
                            ? `Confluence ${c.confluenceScore}, risiko ${c.riskTier} — klik untuk chart`
                            : `Watchlist: tren ada, pemicu belum — klik untuk chart`
                        }
                        style={{
                          padding: '4px 9px',
                          borderRadius: '6px',
                          border: `1px solid ${c.source === 'trade' ? '#10b98155' : '#374151'}`,
                          background: c.source === 'trade' ? 'rgba(16,185,129,0.10)' : '#0a0e17',
                          color: '#f9fafb',
                          fontSize: '11px',
                          fontWeight: 700,
                          cursor: 'pointer',
                          display: 'flex',
                          gap: '6px',
                          alignItems: 'center',
                        }}
                      >
                        {c.source === 'watch' && <span style={{ fontSize: '9px' }}>👀</span>}
                        {c.ticker}
                        <span style={{ fontSize: '9px', fontWeight: 600, color: c.signal.includes('buy') ? '#10b981' : c.signal.includes('sell') ? '#ef4444' : '#6b7280' }}>
                          {c.signal === 'neutral' ? 'watch' : c.signal.replace('_', ' ')}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div style={{ padding: '10px 16px', borderTop: '1px solid #374151', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '11px' }}>✈️</span>
        <span style={{ fontSize: '10px', color: '#9ca3af', fontWeight: 700 }}>
          Telegram
          {tgConfigured == null ? ' …' : tgConfigured ? (
            <span style={{ color: '#10b981' }}> · tersambung</span>
          ) : (
            <span style={{ color: '#f59e0b' }}> · belum dikonfigurasi</span>
          )}
        </span>
        <button
          onClick={toggleTg}
          title="Kalau off, scan selesai tidak mengirim apa-apa ke Telegram"
          style={{
            padding: '3px 9px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
            border: `1px solid ${tgEnabled ? '#10b98166' : '#374151'}`,
            background: tgEnabled ? 'rgba(16,185,129,0.14)' : 'transparent',
            color: tgEnabled ? '#10b981' : '#9ca3af',
            cursor: 'pointer',
          }}
        >
          {tgEnabled ? '✓ Kirim otomatis on' : 'Kirim otomatis off'}
        </button>
        <button
          onClick={sendTgTest}
          disabled={tgTestState === 'sending'}
          title="Kirim pesan test ke chat Telegram"
          style={{
            padding: '3px 9px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
            border: '1px solid #374151', background: 'transparent',
            color: tgTestState === 'ok' ? '#10b981' : tgTestState === 'fail' ? '#ef4444' : '#9ca3af',
            cursor: tgTestState === 'sending' ? 'wait' : 'pointer',
          }}
        >
          {tgTestState === 'sending' ? '…' : tgTestState === 'ok' ? '✓ Terkirim' : tgTestState === 'fail' ? '↻ Coba lagi' : 'Kirim test'}
        </button>
        {tgTestState === 'fail' && tgTestError && (
          <span style={{ fontSize: '10px', color: '#ef4444' }}>{tgTestError}</span>
        )}
        {!tgConfigured && tgConfigured != null && (
          <span style={{ fontSize: '9px', color: '#4b5563' }}>
            Isi TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID di .env.local, lalu restart dev server.
          </span>
        )}
      </div>

      <div style={{ padding: '8px 16px', borderTop: '1px solid #374151', fontSize: '9px', color: '#4b5563', lineHeight: 1.6 }}>
        Peringatan = flip fase antar-scan + akselerasi early score, bukan ramalan harga. Selalu ada
        kondisi batal: kalau harian berbalik turun, call batal.
      </div>
    </div>
  );
}
