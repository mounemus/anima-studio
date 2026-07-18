/**
 * Generic text-completion endpoint for MORPHOGENESIS STUDIO's node-graph assistant.
 * Reuses the exact auth / rate-limit / key stack as /api/claude (Anthropic via the
 * admin-configured ANTHROPIC_API_KEY). The caller (client) supplies the node-schema
 * system prompt + user description ; we return the raw model text (a JSON graph pipeline).
 * The API key is read server-side only and never reaches the browser.
 */
import Anthropic from '@anthropic-ai/sdk'
import { getSetting } from './_lib/settings'
import { guard, readJsonCapped } from './_lib/guard'

export const config = { runtime: 'edge' }
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  const gate = await guard(req, { bucket: 'morpho', perMin: 20 })
  if (gate instanceof Response) return gate
  const parsed = await readJsonCapped<{ system?: string; prompt?: string }>(req, 128 * 1024)
  if (parsed instanceof Response) return parsed
  const system = (parsed.system ?? '').toString().slice(0, 16000)
  const prompt = (parsed.prompt ?? '').toString().slice(0, 2000)
  if (!system || !prompt) return json({ error: 'Missing system or prompt' }, 400)
  const apiKey = await getSetting('ANTHROPIC_API_KEY')
  if (!apiKey) return json({ error: 'Clé Anthropic non configurée. Va sur /admin pour la renseigner.' }, 500)

  const client = new Anthropic({ apiKey })
  try {
    const r = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1400,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } } as any],
      messages: [{ role: 'user', content: prompt }],
    })
    const text = (r.content as any[]).filter((c) => c.type === 'text').map((c) => c.text).join('').trim()
    return json({ text })
  } catch (e: any) {
    console.error('[api/morpho-assistant]', e)
    return json({ error: 'Erreur côté Anthropic — réessaie' }, 500)
  }
}
