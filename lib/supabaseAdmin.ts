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

export function isSupabaseAdminConfigured(): boolean {
  return Boolean(SUPABASE_URL && SERVICE_ROLE_KEY);
}

export function getSupabaseAdmin(): SupabaseClient | null {
  if (!isSupabaseAdminConfigured()) return null;
  if (!client) {
    client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
  }
  return client;
}
