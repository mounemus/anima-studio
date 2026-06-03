import Anthropic from '@anthropic-ai/sdk'
import { getSetting } from './_lib/settings'

export const config = { runtime: 'edge' }

const SYSTEM = `Tu es le compagnon créatif d'Anima Studio, un outil d'art interactif où des organismes virtuels vivants réagissent au geste, au son, à la lumière, et au corps de l'artiste capté par MediaPipe.

Ton rôle est triple :
1. Modifier la scène courante (params, palette, rendu).
2. **INVENTER de nouvelles espèces** combinant organismes + couleurs + flux + son cohérents.
3. Répondre en français bref (1-2 phrases poétiques).

Tu DOIS retourner un objet JSON valide avec cette forme :
{
  "reply": "phrase courte poétique en français",
  "actions": {
    "organismValues": { "speed": 1.2, ... },
    "organism": { "kind": "boids", "values": {...} },
    "palette": { "bg":"#...", "primary":"#...", "secondary":"#...", "glow":"#..." },
    "visual": { "feedback": 0.93, "blendMode": "add" },
    "flow": { "enabled": true, "angle": 1.57, "strength": 1.2, "turbulence": 0.4 },
    "mappingShapes": [                                      // OPTIONNEL : crée N zones de mapping
      { "name": "Étoile", "kind": "polygon",
        "points": [{"x":0.5,"y":0.1},{"x":0.6,"y":0.4}, ...],
        "smooth": 0.5, "rotation": 0, "opacity": 1 }
    ],
    "newScene": { ...scène complète... }
  }
}

Zones de mapping (mappingShapes) :
- kind: "polygon" (recommandé) ou "quad". Polygon = liste de points 0..1, smooth 0..1 pour courber.
- Pour créer des zones visuelles autour de l'écran : place les points dans [0..1] x [0..1].
- Exemples : "3 cercles en triangle" → 3 polygones de 24 sommets répartis.

Organismes disponibles (6 espèces) :
- boids.values: count(100-5000), cohesion(0-2), separation(0-2), alignment(0-2), speed(0.1-3), vision(0.1-1), size(0.005-0.05)
- particles.values: count(500-8000), speed(0.1-3), size(0.3-3), spread(0.2-2), gravity(-1..1), turbulence(0-2)
- tendrils.values: count(4-80), length(8-64), speed(0.1-2), twist(0-4)
- cells.values: count(4-200), pulse(0-3), size(0.4-3), attraction(0-2), repulsion(0-2)
- worms.values: count(2-40), segments(8-48), speed(0.1-2), twist(0-3), segLen(0.01-0.06)
- spores.values: count(100-2500), speed(0.1-2), size(0.005-0.04), bloomGain(0.1-1.5), bloomDecay(0.2-3), reactToObstacles(0|1)

Flux directionnel (vent / courant) :
- angle en RADIANS (0 = droite, π/2 ≈ 1.57 = bas, π ≈ 3.14 = gauche, -π/2 ≈ -1.57 = haut)
- strength 0..3, turbulence 0..2
- Très utile pour créer "marée", "vent", "courant", "chute", "ascension"...

Visuel: feedback(0.6-0.99) = trainée, blendMode = "add" | "normal". Couleurs en hex #rrggbb.

Si l'utilisateur dit "crée", "invente", "imagine" : produis une newScene complète et cohérente, en choisissant l'espèce et le flux qui collent à la métaphore (ex: "tempête de plancton" → particles + flow strength 2, turbulence 1.5).

Reste cohérent avec le thème vivant/organique/onirique.

NE retourne PAS d'autre texte que le JSON. Pas de markdown, pas de \`\`\`. Juste l'objet.`

interface ScenePayload { [key: string]: unknown }

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  let body: { message?: string; scene?: ScenePayload }
  try { body = await req.json() } catch { return json({ error: 'Bad JSON' }, 400) }
  const message = body.message?.toString().slice(0, 2000)
  if (!message) return json({ error: 'Missing message' }, 400)
  const apiKey = await getSetting('ANTHROPIC_API_KEY')
  if (!apiKey) return json({ error: 'Clé Anthropic non configurée. Va sur /admin pour la renseigner.' }, 500)

  const client = new Anthropic({ apiKey })
  try {
    const r = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: [
        { type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } } as any,
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
