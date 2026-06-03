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

const MAX_ATTEMPTS = 5
const LOCKOUT_WINDOW_SEC = 15 * 60   // 15 minutes

function clientIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  )
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonResponse({ error: 'method' }, { status: 405 })
  if (!kvConfigured()) return jsonResponse({ error: 'Vercel KV non configurée.' }, { status: 500 })

  // Throttle by IP: 5 attempts / 15 minutes. Defends against credential stuffing
  // and brute force on the only auth surface.
  const ip = clientIp(req)
  const failKey = `anima:login:fail:${ip}`
  const fails = Number(await kv().get(failKey) ?? 0)
  if (fails >= MAX_ATTEMPTS) {
    return jsonResponse(
      { error: `Trop de tentatives. Réessaie dans ${LOCKOUT_WINDOW_SEC / 60} minutes.` },
      { status: 429, headers: { 'retry-after': String(LOCKOUT_WINDOW_SEC) } },
    )
  }

  let body: { email?: string; password?: string }
  try { body = await req.json() } catch { return jsonResponse({ error: 'bad json' }, { status: 400 }) }
  const email = body.email?.toString().trim().toLowerCase()
  const password = body.password?.toString() ?? ''
  if (!email || !password) return jsonResponse({ error: 'Champs manquants.' }, { status: 400 })

  const admin = await kv().get<AdminRecord>(K.admin)
  // Same message for "no admin" / "wrong email" / "wrong password" — don't leak existence
  if (!admin || admin.email !== email) {
    await registerFail(failKey)
    return jsonResponse({ error: 'Identifiants incorrects.' }, { status: 401 })
  }

  const ok = await comparePassword(password, admin.password_hash)
  if (!ok) {
    await registerFail(failKey)
    return jsonResponse({ error: 'Identifiants incorrects.' }, { status: 401 })
  }

  // Success: clear failure counter
  try { await kv().del(failKey) } catch { /* ignore */ }

  admin.last_login_at = new Date().toISOString()
  await kv().set(K.admin, admin)

  const tok = await signSession({ sub: admin.id, email: admin.email })
  return jsonResponse({ ok: true, email: admin.email }, {
    status: 200,
    headers: { 'set-cookie': cookieHeader(tok) },
  })
}

async function registerFail(key: string) {
  try {
    const n = await kv().incr(key)
    if (n === 1) await kv().expire(key, LOCKOUT_WINDOW_SEC)
  } catch { /* KV glitch — fail open, don't lock user out */ }
}
