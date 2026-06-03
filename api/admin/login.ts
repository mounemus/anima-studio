import { kv, kvConfigured, K } from '../_lib/kv'
import { comparePassword, signSession, cookieHeader, jsonResponse } from '../_lib/auth'

export const config = { runtime: 'edge' }

interface AdminRecord {
  id: string
  email: string
  password_hash: string
  created_at: string
  last_login_at: string | null
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonResponse({ error: 'method' }, { status: 405 })
  if (!kvConfigured()) return jsonResponse({ error: 'Vercel KV non configurée.' }, { status: 500 })

  let body: { email?: string; password?: string }
  try { body = await req.json() } catch { return jsonResponse({ error: 'bad json' }, { status: 400 }) }
  const email = body.email?.toString().trim().toLowerCase()
  const password = body.password?.toString() ?? ''
  if (!email || !password) return jsonResponse({ error: 'Champs manquants.' }, { status: 400 })

  const admin = await kv().get<AdminRecord>(K.admin)
  if (!admin || admin.email !== email) return jsonResponse({ error: 'Identifiants incorrects.' }, { status: 401 })

  const ok = await comparePassword(password, admin.password_hash)
  if (!ok) return jsonResponse({ error: 'Identifiants incorrects.' }, { status: 401 })

  admin.last_login_at = new Date().toISOString()
  await kv().set(K.admin, admin)

  const tok = await signSession({ sub: admin.id, email: admin.email })
  return jsonResponse({ ok: true, email: admin.email }, {
    status: 200,
    headers: { 'set-cookie': cookieHeader(tok) },
  })
}
