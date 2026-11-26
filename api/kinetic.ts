/**
 * AI of the « Sculptures cinétiques » atelier (Kinetic Studio, embedded under /kinetic).
 *
 * The atelier sends its own instructions, the conversation so far (the request, then at most a few
 * correction rounds : its checks found the sheet unbuildable) and the JSON schema of a parameter sheet.
 * We answer { text } : that sheet, as a JSON object. The atelier sanitises and re-checks everything it
 * gets back, so a wrong answer costs a retry, never a broken part.
 *
 * Same auth / rate-limit / key stack as the other ateliers : the Anthropic key comes from the admin
 * vault (ANTHROPIC_API_KEY) and never reaches the browser.
 */
import Anthropic from '@anthropic-ai/sdk'
import { getSetting } from './_lib/settings'
import { guard, readJsonCapped } from './_lib/guard'
import { cleanTurns, cleanSchema, extractJson, LIMITS } from '../src/kinetic/kineticApi'

export const config = { runtime: 'edge' }

const MODEL = 'claude-opus-5-5'
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  const gate = await guard(req, { bucket: 'kinetic', perMin: 20 })
  if (gate instanceof Response) return gate
  const parsed = await readJsonCapped<{ system?: unknown; messages?: unknown; schema?: unknown }>(req, 128 * 1024)
  if (parsed instanceof Response) return parsed
  const system = typeof parsed.system === 'string' ? parsed.system.slice(0, LIMITS.system) : ''
  const messages = cleanTurns(parsed.messages)
  const schema = cleanSchema(parsed.schema)
  if (!system || !messages || !schema) return json({ error: 'Requête incomplète.' }, 400)
  const apiKey = await getSetting('ANTHROPIC_API_KEY')
  if (!apiKey) return json({ error: 'Clé Anthropic non configurée : renseignez-la dans l’administration du studio.' }, 503)

  const client = new Anthropic({ apiKey })
  try {
    let r: { content: unknown[]; stop_reason?: string | null }
    try {
      // Structured output (the answer is guaranteed to match the schema) and server-side fallback if the
      // model declines. These fields are newer than this repo's SDK typings, hence the cast.
      r = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 8000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system,
        messages,
        output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      } as never) as never
    } catch (e) {
      if (!(e instanceof Anthropic.BadRequestError)) throw e
      // The API refused one of those options : same request without them, the JSON is then asked for in
      // the instructions and read leniently below.
      console.warn('[api/kinetic] structured request refused, retrying plain :', e.message)
      r = await client.messages.create({
        model: MODEL,
        max_tokens: 8000,
        system: `${system}\n\nRéponds UNIQUEMENT par un objet JSON valide, sans texte autour, conforme à ce schéma :\n${JSON.stringify(schema)}`,
        messages,
      }) as never
    }
    if (r.stop_reason === 'refusal') return json({ error: 'Le modèle a décliné cette demande. Reformulez-la.' }, 422)
    const raw = (r.content as { type: string; text?: string }[]).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('')
    const text = extractJson(raw)
    if (!text) return json({ error: 'Réponse illisible du modèle. Réessayez.' }, 502)
    return json({ text })
  } catch (e) {
    console.error('[api/kinetic]', e)
    if (e instanceof Anthropic.AuthenticationError) return json({ error: 'Clé Anthropic refusée : vérifiez-la dans l’administration du studio.' }, 503)
    if (e instanceof Anthropic.RateLimitError) return json({ error: 'Limite de débit Anthropic atteinte : réessayez dans un instant.' }, 429)
    return json({ error: 'Erreur côté Anthropic : réessayez.' }, 500)
  }
}
