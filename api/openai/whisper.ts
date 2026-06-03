import { getSetting } from '../_lib/settings'
import { jsonResponse } from '../_lib/auth'

export const config = { runtime: 'edge' }

/**
 * POST /api/openai/whisper
 * Body: multipart/form-data with `file` (audio blob) and optional `language` field.
 * Returns: { text: string }
 */
export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonResponse({ error: 'method' }, { status: 405 })
  const apiKey = await getSetting('OPENAI_API_KEY')
  if (!apiKey) return jsonResponse({ error: 'Clé OpenAI non configurée. Va sur /admin.' }, { status: 500 })

  // Forward multipart as-is to OpenAI
  let form: FormData
  try { form = await req.formData() } catch { return jsonResponse({ error: 'expected multipart/form-data' }, { status: 400 }) }
  const file = form.get('file') as File | null
  if (!file) return jsonResponse({ error: 'file manquant' }, { status: 400 })
  const language = (form.get('language') as string) || 'fr'

  const out = new FormData()
  out.append('file', file, 'audio.webm')
  out.append('model', 'whisper-1')
  out.append('language', language)
  out.append('temperature', '0')

  try {
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: out,
    })
    if (!r.ok) {
      const t = await r.text()
      return jsonResponse({ error: `OpenAI ${r.status}: ${t.slice(0, 200)}` }, { status: 502 })
    }
    const data = await r.json() as { text?: string }
    return jsonResponse({ text: (data.text ?? '').trim() })
  } catch (e: any) {
    return jsonResponse({ error: e?.message ?? 'erreur' }, { status: 500 })
  }
}
