import { supa, supaConfigured } from '../_lib/supabase'
import { comparePassword, signSession, cookieHeader, jsonResponse } from '../_lib/auth'

export const config = { runtime: 'edge' }

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonResponse({ error: 'method' }, { status: 405 })
  if (!supaConfigured()) return jsonResponse({ error: 'Supabase non configurée.' }, { status: 500 })

  let body: { email?: string; password?: string }
  try { body = await req.json() } catch { return jsonResponse({ error: 'bad json' }, { status: 400 }) }
  const email = body.email?.toString().trim().toLowerCase()
  const password = body.password?.toString() ?? ''
  if (!email || !password) return jsonResponse({ error: 'Champs manquants.' }, { status: 400 })

  const { data, error } = await supa()
    .from('admin_users')
    .select('id, email, password_hash')
    .eq('email', email)
    .maybeSingle()
  if (error) return jsonResponse({ error: error.message }, { status: 500 })
  if (!data) return jsonResponse({ error: 'Identifiants incorrects.' }, { status: 401 })

  const ok = await comparePassword(password, data.password_hash)
  if (!ok) return jsonResponse({ error: 'Identifiants incorrects.' }, { status: 401 })

  await supa().from('admin_users').update({ last_login_at: new Date().toISOString() }).eq('id', data.id)

  const tok = await signSession({ sub: data.id, email: data.email })
  return jsonResponse({ ok: true, email: data.email }, {
    status: 200,
    headers: { 'set-cookie': cookieHeader(tok) },
  })
}
