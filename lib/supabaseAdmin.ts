import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * Service-role client, used for the write path of the signal ledger.
 *
 * The ledger's whole promise is that a stranger cannot write to it. The anon
 * key ships in the browser bundle, so an anon insert/update policy would let
 * anyone forge a signal and then fill in its result. Reads stay on the anon key
 * (RLS allows select); writes go through here. The policies that used to allow
 * anon writes are dropped in 014_signal_ledger_write_lock.sql.
 */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

let client: SupabaseClient | null = null;
// unknown → belum dicek; ok → probe lulus; broken → key ditolak, jangan coba lagi.
let adminProbe: 'unknown' | 'ok' | 'broken' = 'unknown';

export function isSupabaseAdminConfigured(): boolean {
  return Boolean(SUPABASE_URL && SERVICE_ROLE_KEY) && adminProbe !== 'broken';
}

export function getSupabaseAdmin(): SupabaseClient | null {
  if (adminProbe === 'broken') return null;
  if (client) return client;
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return null;
  client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  return client;
}

/**
 * Probe sekali per proses: client service-role dengan key yang ditolak gagal
 * SENYAP di setiap tick (errornya ditelan oleh pemanggil), bisa berminggu-
 * minggu. Lebih baik gagal keras satu kali dengan CRITICAL, lalu diam, daripada
 * tiga baris "Invalid API key" tiap jam yang tidak pernah naik ke siapa pun.
 */
export async function ensureSupabaseAdmin(): Promise<SupabaseClient | null> {
  if (adminProbe === 'broken') return null;
  const c = getSupabaseAdmin();
  if (!c) return null;
  if (adminProbe === 'ok') return c;
  const { error } = await c.from('signal_ledger').select('emit_day').limit(1);
  if (error && /invalid api key|jwt/i.test(error.message)) {
    adminProbe = 'broken';
    client = null;
    console.error(
      `[admin] CRITICAL: SUPABASE_SERVICE_ROLE_KEY ditolak (${error.message}). ` +
        'Rekam jejak TIDAK TERTULIS sampai key dibetulkan — cek .env.local dan Vercel.'
    );
    return null;
  }
  // Tabel belum ada / jaringan gagal bukan salah key — jangan kunci permanen.
  adminProbe = 'ok';
  return c;
}
