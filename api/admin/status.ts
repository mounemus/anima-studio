import { kv, kvConfigured } from '../_lib/kv'
import { K } from '../_lib/kv'
import { jsonResponse } from '../_lib/auth'

export const config = { runtime: 'edge' }

export default async function handler(_req: Request): Promise<Response> {
  const env = (globalThis as any).process?.env ?? {}
  const ok = {
    kv: kvConfigured(),
    encryptKey: !!env.ENCRYPT_KEY && env.ENCRYPT_KEY.length >= 32,
    jwtSecret: !!env.JWT_SECRET && env.JWT_SECRET.length >= 16,
    setupComplete: false as boolean,
  }
  if (ok.kv) {
    try {
      const admin = await kv().exists(K.admin)
      ok.setupComplete = admin === 1
    } catch { /* ignore */ }
  }
  return jsonResponse(ok)
}
