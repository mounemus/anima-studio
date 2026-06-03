import { requireAdmin, jsonResponse } from '../_lib/auth'
import { KNOWN_KEYS, listSettings, setSetting, deleteSetting } from '../_lib/settings'

export const config = { runtime: 'edge' }

export default async function handler(req: Request): Promise<Response> {
  const guard = await requireAdmin(req)
  if (guard instanceof Response) return guard

  if (req.method === 'GET') {
    try {
      const items = await listSettings()
      return jsonResponse({
        keys: KNOWN_KEYS,
        items,
      })
    } catch (e: any) {
      return jsonResponse({ error: e?.message ?? 'erreur' }, { status: 500 })
    }
  }

  if (req.method === 'PUT') {
    let body: { key?: string; value?: string }
    try { body = await req.json() } catch { return jsonResponse({ error: 'bad json' }, { status: 400 }) }
    const key = body.key?.toString().trim()
    const value = body.value?.toString() ?? ''
    if (!key || !KNOWN_KEYS.some((k) => k.key === key)) return jsonResponse({ error: 'clé inconnue' }, { status: 400 })
    try {
      if (value === '') await deleteSetting(key)
      else await setSetting(key, value, guard.sub)
      return jsonResponse({ ok: true })
    } catch (e: any) {
      return jsonResponse({ error: e?.message ?? 'erreur' }, { status: 500 })
    }
  }

  return jsonResponse({ error: 'method' }, { status: 405 })
}
