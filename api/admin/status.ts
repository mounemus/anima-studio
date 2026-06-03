import { supa, supaConfigured } from '../_lib/supabase'
import { jsonResponse } from '../_lib/auth'

export const config = { runtime: 'edge' }

export default async function handler(_req: Request): Promise<Response> {
  const env = (globalThis as any).process?.env ?? {}
  const ok = {
    supabase: supaConfigured(),
    encryptKey: !!env.ENCRYPT_KEY && env.ENCRYPT_KEY.length >= 32,
    jwtSecret: !!env.JWT_SECRET && env.JWT_SECRET.length >= 16,
    setupComplete: false as boolean,
  }
  if (ok.supabase) {
    try {
      const { count } = await supa().from('admin_users').select('id', { count: 'exact', head: true })
      ok.setupComplete = (count ?? 0) > 0
    } catch { /* table missing or other */ }
  }
  return jsonResponse(ok)
}
