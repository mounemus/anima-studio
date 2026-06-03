import { getSetting } from '../_lib/settings'
import { guard, readJsonCapped } from '../_lib/guard'

export const config = { runtime: 'edge' }

/**
 * POST /api/openai/tts
 * Body: { text: string, voice?: 'alloy'|'echo'|'fable'|'onyx'|'nova'|'shimmer', speed?: 0.5..2 }
 * Returns: audio/mpeg stream.
 */
export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('method', { status: 405 })
  const gate = await guard(req, { bucket: 'tts', perMin: 20 })
  if (gate instanceof Response) return gate
  const apiKey = await getSetting('OPENAI_API_KEY')
  if (!apiKey) return new Response(JSON.stringify({ error: 'Clé OpenAI non configurée.' }), { status: 500, headers: { 'content-type': 'application/json' } })

  const parsed = await readJsonCapped<{ text?: string; voice?: string; speed?: number }>(req, 16 * 1024)
  if (parsed instanceof Response) return parsed
  const body = parsed
  const text = body.text?.toString().slice(0, 2000).trim()
  if (!text) return new Response('text manquant', { status: 400 })
  const voice = body.voice || 'nova'
  const speed = Math.max(0.5, Math.min(2, body.speed ?? 1))

  // Try models in order of preference, falling back if the project lacks access
  const MODELS = ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd']
  let lastErr = ''
  for (const model of MODELS) {
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: text, voice, speed, response_format: 'mp3' }),
    })
    if (r.ok) {
      return new Response(r.body, { status: 200, headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store', 'x-anima-model': model } })
    }
    const t = await r.text()
    lastErr = `${r.status}: ${t.slice(0, 200)}`
    // If it's a no-access error, try next model; otherwise stop.
    if (!/does not have access|model_not_found/i.test(t)) break
  }
  return new Response(JSON.stringify({ error: `OpenAI TTS indisponible — ${lastErr}` }), { status: 502, headers: { 'content-type': 'application/json' } })
}
