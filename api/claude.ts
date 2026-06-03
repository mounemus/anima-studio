import Anthropic from '@anthropic-ai/sdk'

export const config = { runtime: 'edge' }

const SYSTEM = `Tu es le compagnon créatif d'Anima Studio, un outil d'art interactif où des organismes virtuels vivants réagissent au geste, au son et à la lumière.

Tu reçois la scène actuelle en JSON et un message de l'artiste. Tu réponds toujours en français, de façon brève (1-2 phrases), poétique, puis tu retournes des modifications.

Tu DOIS retourner un objet JSON valide avec cette forme:
{
  "reply": "phrase courte poétique en français",
  "actions": {
    "organismValues": { "speed": 1.2, "size": 0.02, ... },  // OPTIONNEL: patch sur les valeurs de l'organisme courant
    "organism": { "kind": "boids", "values": {...} },        // OPTIONNEL: changer d'organisme complet
    "palette": { "bg":"#...", "primary":"#...", "secondary":"#...", "glow":"#..." },  // OPTIONNEL
    "visual": { "feedback": 0.93, "blendMode": "add" },       // OPTIONNEL
    "newScene": { ...scene complète... }                      // OPTIONNEL: créer une nouvelle scène
  }
}

Organismes disponibles: boids (bancs), particles (poussière), tendrils (filaments), cells (colonie).

Pour chaque organisme:
- boids.values: count(100-5000), cohesion(0-2), separation(0-2), alignment(0-2), speed(0.1-3), vision(0.1-1), size(0.005-0.05)
- particles.values: count(500-8000), speed(0.1-3), size(0.3-3), spread(0.2-2), gravity(-1..1), turbulence(0-2)
- tendrils.values: count(4-80), length(8-64), speed(0.1-2), twist(0-4)
- cells.values: count(4-200), pulse(0-3), size(0.4-3), attraction(0-2), repulsion(0-2)

Visuel: feedback(0.6-0.99) = traînée, blendMode = "add" | "normal".

Couleurs en hex (#rrggbb). Reste cohérent avec le thème poétique vivant/organique.

NE retourne PAS d'autre texte que le JSON. Pas de markdown, pas de \`\`\`. Juste l'objet.`

interface ScenePayload { [key: string]: unknown }

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  let body: { message?: string; scene?: ScenePayload }
  try { body = await req.json() } catch { return json({ error: 'Bad JSON' }, 400) }
  const message = body.message?.toString().slice(0, 2000)
  if (!message) return json({ error: 'Missing message' }, 400)
  const apiKey = (globalThis as any).process?.env?.ANTHROPIC_API_KEY
  if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY non configurée côté serveur Vercel.' }, 500)

  const client = new Anthropic({ apiKey })
  try {
    const r = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: [
        { type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        {
          role: 'user',
          content: `Scène actuelle:\n\`\`\`json\n${JSON.stringify(body.scene ?? {}, null, 2)}\n\`\`\`\n\nMessage de l'artiste: ${message}`,
        },
      ],
    })
    const text = r.content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('')
      .trim()
    // try parse
    let parsed: any
    try { parsed = JSON.parse(text) } catch {
      // try to extract JSON object
      const m = text.match(/\{[\s\S]*\}/)
      if (m) try { parsed = JSON.parse(m[0]) } catch { /* ignore */ }
    }
    if (!parsed) return json({ reply: text, actions: {} })
    return json({ reply: parsed.reply ?? 'Modifié.', actions: parsed.actions ?? {} })
  } catch (e: any) {
    return json({ error: e?.message ?? 'Erreur Anthropic' }, 500)
  }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
