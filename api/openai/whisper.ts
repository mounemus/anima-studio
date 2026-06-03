import { getSetting } from '../_lib/settings'
import { jsonResponse } from '../_lib/auth'
import { guard } from '../_lib/guard'

export const config = { runtime: 'edge' }

const MAX_AUDIO_BYTES = 25 * 1024 * 1024  // OpenAI's own limit

/**
 * POST /api/openai/whisper
 * Body: multipart/form-data with `file` (audio blob) and optional `language` field.
 * Returns: { text: string }
 */
export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonResponse({ error: 'method' }, { status: 405 })
  const gate = await guard(req, { bucket: 'whisper', perMin: 12 })
  if (gate instanceof Response) return gate

  const apiKey = await getSetting('OPENAI_API_KEY')
  if (!apiKey) return jsonResponse({ error: 'Clé OpenAI non configurée. Va sur /admin.' }, { status: 500 })

  // Forward multipart as-is to OpenAI (with safety caps)
  let form: FormData
  try { form = await req.formData() } catch { return jsonResponse({ error: 'expected multipart/form-data' }, { status: 400 }) }
  const file = form.get('file') as File | null
  if (!file) return jsonResponse({ error: 'file manquant' }, { status: 400 })
  if (file.size > MAX_AUDIO_BYTES) return jsonResponse({ error: 'audio trop long (max 25 MB)' }, { status: 413 })
  if (file.type && !file.type.startsWith('audio/')) return jsonResponse({ error: 'type MIME audio attendu' }, { status: 415 })
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
      console.error('[api/openai/whisper]', r.status, t.slice(0, 500))
      return jsonResponse({ error: `OpenAI indisponible (${r.status})` }, { status: 502 })
    }
    const data = await r.json() as { text?: string }
    return jsonResponse({ text: (data.text ?? '').trim() })
  } catch (e: any) {
    console.error('[api/openai/whisper]', e)
    return jsonResponse({ error: 'erreur côté OpenAI' }, { status: 500 })
  }
}
