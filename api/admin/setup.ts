import { supa, supaConfigured } from '../_lib/supabase'
import { hashPassword, signSession, cookieHeader, jsonResponse } from '../_lib/auth'

export const config = { runtime: 'edge' }

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonResponse({ error: 'method' }, { status: 405 })
  if (!supaConfigured()) return jsonResponse({ error: 'Supabase non configurée côté serveur.' }, { status: 500 })

  let body: { email?: string; password?: string }
  try { body = await req.json() } catch { return jsonResponse({ error: 'bad json' }, { status: 400 }) }
  const email = body.email?.toString().trim().toLowerCase()
  const password = body.password?.toString()
  if (!email || !email.includes('@')) return jsonResponse({ error: 'Email invalide.' }, { status: 400 })
  if (!password || password.length < 8) return jsonResponse({ error: 'Mot de passe trop court (8 caractères min).' }, { status: 400 })

  // First-run only: refuse if any admin exists.
  const { count } = await supa().from('admin_users').select('id', { count: 'exact', head: true })
  if ((count ?? 0) > 0) return jsonResponse({ error: 'Setup déjà effectué.' }, { status: 409 })

  const password_hash = await hashPassword(password)
  const { data, error } = await supa()
    .from('admin_users')
    .insert({ email, password_hash })
    .select('id, email')
    .single()
  if (error) return jsonResponse({ error: error.message }, { status: 500 })

  const tok = await signSession({ sub: data.id, email: data.email })
  return jsonResponse({ ok: true, email: data.email }, {
    status: 200,
    headers: { 'set-cookie': cookieHeader(tok) },
  })
}
