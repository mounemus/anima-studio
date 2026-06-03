import { getSetting } from '../_lib/settings'

export const config = { runtime: 'edge' }

/**
 * POST /api/openai/tts
 * Body: { text: string, voice?: 'alloy'|'echo'|'fable'|'onyx'|'nova'|'shimmer', speed?: 0.5..2 }
 * Returns: audio/mpeg stream.
 */
export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('method', { status: 405 })
  const apiKey = await getSetting('OPENAI_API_KEY')
  if (!apiKey) return new Response(JSON.stringify({ error: 'Clé OpenAI non configurée.' }), { status: 500, headers: { 'content-type': 'application/json' } })

  let body: { text?: string; voice?: string; speed?: number }
  try { body = await req.json() } catch { return new Response('bad json', { status: 400 }) }
  const text = body.text?.toString().slice(0, 2000).trim()
  if (!text) return new Response('text manquant', { status: 400 })
  const voice = body.voice || 'nova'
  const speed = Math.max(0.5, Math.min(2, body.speed ?? 1))

  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'tts-1', input: text, voice, speed, response_format: 'mp3' }),
  })
  if (!r.ok) {
    const t = await r.text()
    return new Response(JSON.stringify({ error: `OpenAI ${r.status}: ${t.slice(0, 200)}` }), { status: 502, headers: { 'content-type': 'application/json' } })
  }
  // Stream MP3 back to the client
  return new Response(r.body, { status: 200, headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' } })
}
