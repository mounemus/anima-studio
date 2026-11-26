/**
 * Description and/or reference image → organic-parametric sculpture params (studio
 * Sculpture, mode « Organique »).
 *
 * Three ways to call it, all through the same body :
 *   { prompt }                       a fresh form from a description
 *   { prompt?, image }               a form that translates a reference picture
 *   { prompt, current }              « affiner » : change the current form as asked
 *
 * Returns ONLY the generator's parameter object and a look (material, glaze colours), so the
 * client can apply it directly. The client sanitises everything it gets back and falls back
 * to a local deterministic interpreter whenever this endpoint is unavailable or unconfigured.
 */
import Anthropic from '@anthropic-ai/sdk'
import { getSetting } from './_lib/settings'
import { guard, readJsonCapped } from './_lib/guard'

export const config = { runtime: 'edge' }

const SYSTEM = `Tu es l'assistant d'un atelier de sculpture générative. Tu traduis une description, et parfois une image de référence, en paramètres pour un générateur de formes (champ de distance signée + marching cubes). Tu ne dessines rien toi-même : tu choisis des réglages.

Le générateur construit, dans cet ordre :
CORPS → RELIEF en nappe (cannelures, écailles, méandres) → évidé en COQUE → PERFORÉ → ÉLÉMENTS semés sur la surface (polypes, épines, rosettes, perles) → haut COUPÉ → miroir → torsion / effilé / courbure → bruit.
Un seul relief et une seule perforation à la fois.

Retourne UNIQUEMENT un objet JSON valide, sans texte autour :
{
  "explain": "une ou deux phrases en français : ce que tu as retenu de la demande ou de l'image, et ce que le générateur ne sait pas reproduire",
  "params": {
    "form": "ovoide" | "goutte" | "gourde" | "lyre" | "colonne" | "dome" | "tore" | "ruban" | "dalle" | "fleur",
    "petals": 3-16, "curl": 0-1.5, "stamens": 0-40,   // form "fleur" seulement : pétales en ruban, enroulement (0 à plat, 1 en boucle), étamines
    "pore": "aucun" | "alveoles" | "resille" | "grille" | "boucles" | "pores" | "lattice" | "cellules",
    "poreRows": 1-8, "poreCount": 2-12,   // rangs en hauteur, ouvertures par rang (×2 pour alveoles/resille/grille)
    "poreSize": 0.04-0.32,                // taille des ouvertures (grand = cloisons fines)
    "poreRadius": 0.1-0.8,                // boucles/pores : distance des ouvertures à l'axe
    "poreJitter": 0-1,                    // alveoles : 0 nid d'abeille régulier, 1 cellules organiques / veines
    "blend": 0-0.22,                      // fondu des jonctions : 0.01 net, 0.12 charnu
    "latticeFreq": 2-14,                  // densité pour lattice / cellules
    "shell": 0-0.16,                      // 0 = plein ; 0.03 = paroi fine
    "relief": "aucun" | "polypes" | "epines" | "rosettes" | "perles" | "ecailles" | "cannelures" | "meandres",
    "reliefDensity": 0-1,                 // peu ↔ beaucoup d'éléments, de côtes ou de colonnes
    "reliefHeight": 0-0.3,                // épines 0.15-0.25, polypes 0.1-0.16, rosettes/perles 0.04-0.06, écailles/cannelures 0.04-0.08, méandres 0.03
    "reliefSize": 0-1,                    // largeur des éléments par rapport à leur espacement (1 = ils se touchent)
    "open": 0-0.7,                        // part de la hauteur coupée en haut : 0.1 vase, 0.5 bol
    "mirror": true | false,
    "twist": -3.5..3.5, "taper": -0.8..0.8, "bend": -1.2..1.2,
    "noiseAmp": 0-0.09, "noiseFreq": 0.5-8,
    "noiseType": "value"|"fbm"|"ridged"|"turbulence"|"worley",
    "seed": 0-9999,                       // autre tirage des éléments semés
    "res": 40-160                         // 72 aperçu, 110 normal, 140 fin (lent)
  },
  "look": {
    "material": "email" | "porcelaine" | "clay" | "matte" | "chrome" | "bio",
    "colorA": "#rrggbb",   // le corps
    "colorB": "#rrggbb",   // ce qui est en relief
    "colorC": "#rrggbb",   // les creux et l'intérieur
    "lamp": true | false   // lumière chaude à l'intérieur (il faut une coque percée)
  }
}

Repères :
- fleur à pétales en rubans torsadés, étamines à boules, engrenage au cœur (« fleur mécanique ») → form "fleur", pore "aucun", relief "aucun", shell 0, mirror false, res 130 ; colorA = pétales, colorB = étamines, colorC = roue dentée.
- céramique de récif, coupelles, anémones → form "goutte" ou "dome", relief "rosettes" ou "polypes", pore "aucun", émail à trois couleurs franches.
- oursin, cactus → relief "epines", corps plein.
- balanes, tubes ouverts → relief "polypes", shell 0.04 (les tubes traversent alors la paroi).
- vase à pétales ou écailles torsadées → form "colonne" ou "lyre", relief "ecailles", twist 0.6-1.2, open 0.1, shell 0.035, matière "matte".
- lampe en nid d'abeille → pore "alveoles", poreJitter 0-0.2, shell 0.03, lamp true. Dentelle de veines, cellules irrégulières → poreJitter 0.8-1.
- lampe à croisillons, losanges → pore "resille", shell 0.03, lamp true.
- gourde ou lampe côtelée → relief "cannelures", éventuellement twist.
- corail cerveau, labyrinthe → relief "meandres".
- panneau de bois creusé de trous doux → form "dalle", pore "cellules", shell 0, blend 0.1-0.14, latticeFreq 5-7.
- os, éponge → pore "lattice", shell 0. Dentelle à anses → pore "boucles", shell 0.05, mirror true.
- chrome, poli → pore "aucun", relief "aucun", material "chrome".
- relief ou perforation de surface (alveoles, resille, grille) : mirror false.

Si une image est jointe : lis d'abord la silhouette (corps), puis ce qui est ajouté ou retiré à la surface, la densité du motif, puis les couleurs. Choisis le réglage le plus proche et dis dans "explain" ce qui reste hors de portée (branches de corail, plis de tissu, texte, figuration).
Si "RÉGLAGES ACTUELS" est fourni : c'est un affinage. Ne renvoie que les champs à changer, calculés par rapport à ces valeurs (« plus dense » = augmenter, pas repartir de zéro).
Sinon, renvoie un jeu complet et cohérent. Reste dans les bornes.`

type ImageMedia = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
const MEDIA: ImageMedia[] = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  const gate = await guard(req, { bucket: 'organic', perMin: 20 })
  if (gate instanceof Response) return gate
  // Une image de référence réduite à 1024 px en JPEG pèse 100 à 400 ko en base64.
  const parsed = await readJsonCapped<{ prompt?: string; image?: { media?: string; data?: string }; current?: unknown }>(req, 1400 * 1024)
  if (parsed instanceof Response) return parsed
  const prompt = parsed.prompt?.toString().slice(0, 600) ?? ''
  const img = parsed.image
  const hasImage = !!img && typeof img.data === 'string' && img.data.length > 100 && MEDIA.includes(img.media as ImageMedia) && /^[A-Za-z0-9+/=]+$/.test(img.data)
  if (!prompt && !hasImage) return json({ error: 'Missing prompt' }, 400)
  const apiKey = await getSetting('ANTHROPIC_API_KEY')
  if (!apiKey) return json({ error: 'Clé Anthropic non configurée.' }, 503)

  // Les réglages actuels ne sont que des nombres et des noms courts : on les borne en taille.
  const current = parsed.current && typeof parsed.current === 'object' ? JSON.stringify(parsed.current).slice(0, 1500) : ''
  const content: Anthropic.ContentBlockParam[] = []
  if (hasImage) content.push({ type: 'image', source: { type: 'base64', media_type: img!.media as ImageMedia, data: img!.data! } })
  content.push({
    type: 'text',
    text: [
      hasImage ? 'Image de référence jointe.' : '',
      prompt ? `Demande : ${prompt}` : 'Demande : traduis cette image en sculpture.',
      current ? `RÉGLAGES ACTUELS : ${current}` : '',
    ].filter(Boolean).join('\n'),
  })

  const client = new Anthropic({ apiKey })
  try {
    const r = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } } as never],
      messages: [{ role: 'user', content }],
    })
    const text = r.content.filter((c: { type: string }) => c.type === 'text').map((c: { text?: string }) => c.text ?? '').join('').trim()
    let out: { explain?: string; params?: unknown; look?: unknown } | null = null
    try { out = JSON.parse(text) } catch { const m = text.match(/\{[\s\S]*\}/); if (m) try { out = JSON.parse(m[0]) } catch { /* ignore */ } }
    if (!out?.params && !out?.look) return json({ error: 'Réponse illisible du modèle.' }, 502)
    return json({ explain: out.explain ?? '', params: out.params ?? {}, look: out.look ?? {} })
  } catch (e) {
    console.error('[api/organic]', e)
    return json({ error: 'Erreur côté Anthropic — réessaie' }, 500)
  }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}
