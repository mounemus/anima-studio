import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let _client: SupabaseClient | null = null

export function supa(): SupabaseClient {
  if (_client) return _client
  const url = (globalThis as any).process?.env?.SUPABASE_URL
  const key = (globalThis as any).process?.env?.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('Supabase not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY')
  }
  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return _client
}

export function supaConfigured(): boolean {
  const env = (globalThis as any).process?.env
  return !!(env?.SUPABASE_URL && env?.SUPABASE_SERVICE_ROLE_KEY)
}
