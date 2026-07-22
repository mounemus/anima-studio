/**
 * Text → organic-parametric sculpture params (studio Sculpture, mode « Organique »).
 * Returns ONLY the generator's parameter object, so the client can apply it directly.
 * The client sanitises everything it gets back and falls back to a local deterministic
 * interpreter whenever this endpoint is unavailable or unconfigured.
 */
import Anthropic from '@anthropic-ai/sdk'
import { getSetting } from './_lib/settings'
import { guard, readJsonCapped } from './_lib/guard'

export const config = { runtime: 'edge' }

const SYSTEM = `Tu traduis la description d'une sculpture en paramètres pour un générateur de formes organiques-paramétriques (champ de distance signée + marching cubes).

Le générateur construit : un CORPS → évidé en COQUE → PERFORÉ par un booléen adouci → miroir → torsion/effilé/courbure/bruit.

Retourne UNIQUEMENT un objet JSON valide, sans texte autour, de cette forme :
{
  "explain": "une phrase courte en français décrivant le parti pris",
  "params": {
    "form": "ovoide" | "colonne" | "lyre" | "tore" | "ruban",
    "pore": "aucun" | "pores" | "boucles" | "lattice" | "cellules",
    "poreRows": 1-8,          // anneaux de perforations en hauteur
    "poreCount": 2-12,        // perforations par anneau = symétrie radiale
    "poreSize": 0.04-0.32,    // rayon des ouvertures
    "poreRadius": 0.1-0.8,    // distance des ouvertures à l'axe
    "blend": 0-0.22,          // fondu du booléen : 0 = percé net, 0.15 = entretoises charnues
    "latticeFreq": 2-14,      // densité pour lattice/cellules
    "shell": 0-0.16,          // 0 = plein ; 0.05 = coque creuse fine
    "mirror": true | false,
    "twist": -3.5..3.5, "taper": -0.8..0.8, "bend": -1.2..1.2,
    "noiseAmp": 0-0.09, "noiseFreq": 0.5-8,
    "noiseType": "value"|"fbm"|"ridged"|"turbulence"|"worley",
    "res": 40-140             // 52 = aperçu, 72 = normal, 110+ = lent
  }
}

Repères de style :
- « os / trabéculaire / éponge » → pore "lattice", shell 0, latticeFreq 8-11.
- « corail / alvéolaire » → pore "cellules", shell 0, un peu de noiseAmp.
- « dentelle / ajouré / nervuré / squelette » → pore "boucles", shell 0.05, blend 0.09-0.14.
- « chrome / poli / massif » → pore "aucun", shell 0, twist marqué.
- Vaisseau/urne/torse → form "lyre". Totem/pilier → "colonne". Nœud/vague → "ruban".
- N'inclus que les champs pertinents ; omets les autres. Reste dans les bornes.`

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  const gate = await guard(req, { bucket: 'organic', perMin: 20 })
  if (gate instanceof Response) return gate
  const parsed = await readJsonCapped<{ prompt?: string }>(req, 16 * 1024)
  if (parsed instanceof Response) return parsed
  const prompt = parsed.prompt?.toString().slice(0, 600)
  if (!prompt) return json({ error: 'Missing prompt' }, 400)
  const apiKey = await getSetting('ANTHROPIC_API_KEY')
  if (!apiKey) return json({ error: 'Clé Anthropic non configurée.' }, 503)

  const client = new Anthropic({ apiKey })
  try {
    const r = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 700,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } } as never],
      messages: [{ role: 'user', content: `Sculpture souhaitée : ${prompt}` }],
    })
    const text = r.content.filter((c: { type: string }) => c.type === 'text').map((c: { text?: string }) => c.text ?? '').join('').trim()
    let out: { explain?: string; params?: unknown } | null = null
    try { out = JSON.parse(text) } catch { const m = text.match(/\{[\s\S]*\}/); if (m) try { out = JSON.parse(m[0]) } catch { /* ignore */ } }
    if (!out?.params) return json({ error: 'Réponse illisible du modèle.' }, 502)
    return json({ explain: out.explain ?? '', params: out.params })
  } catch (e) {
    console.error('[api/organic]', e)
    return json({ error: 'Erreur côté Anthropic — réessaie' }, 500)
  }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}
