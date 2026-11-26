/**
 * Text (and reference image) → organic-parametric params, for the sculpture studio's AI
 * assistant.
 *
 * Two layers, on purpose:
 *  - `textToOrganic` is LOCAL and deterministic (keyword driven). It always works — no key,
 *    no network, no cost — so the feature can never be dead in the water. It reads words
 *    only : it cannot look at an image.
 *  - the studio first asks /api/organic (a real model, which does look at the reference
 *    image and at the current settings) and falls back to this the moment the endpoint is
 *    missing, unconfigured, rate-limited or offline.
 *
 * Both paths funnel through `sanitiseOrganic` / `sanitiseLook`, so a model can never push
 * the generator into an invalid state (empty mesh, 10-minute resolution, negative
 * thickness…) nor inject anything but a colour into the page.
 */
import { ORG_DEFAULTS, ORG_FORMS, ORG_PORES, ORG_RELIEFS, type OrganicParams, type OrgForm, type OrgPore, type OrgRelief } from './organic'
import type { NoiseType } from '../morpho/fields'

const clamp = (a: number, b: number, v: number) => Math.max(a, Math.min(b, v))
// « mesh » a besoin d'une forme source : ni l'IA ni un tirage ne peuvent le choisir.
const FORMS: OrgForm[] = ORG_FORMS.map((f) => f.kind).filter((k) => k !== 'mesh')
const PORES: OrgPore[] = ORG_PORES.map((f) => f.kind)
const RELIEFS: OrgRelief[] = ORG_RELIEFS.map((f) => f.kind)
const NOISES: NoiseType[] = ['value', 'fbm', 'ridged', 'turbulence', 'worley']

/** Everything about the LOOK that is not geometry : material, the three glaze colours,
 *  the inner light. Kept apart from OrganicParams so a colour change never regenerates. */
export interface OrgLook { material?: string; colorA?: string; colorB?: string; colorC?: string; lamp?: boolean }
export const LOOK_MATERIALS = ['email', 'porcelaine', 'clay', 'matte', 'chrome', 'bio']
/** Ready-made glazes : body / relief / hollow. */
export const PALETTES: { name: string; a: string; b: string; c: string }[] = [
  { name: 'Récif', a: '#2f9c96', b: '#f08a3c', c: '#17555c' },
  { name: 'Corail', a: '#e9643a', b: '#f4e7c3', c: '#8f2f1a' },
  { name: 'Porcelaine', a: '#efe9df', b: '#fbf8f2', c: '#b3a592' },
  { name: 'Céladon', a: '#a9c9b4', b: '#dcebdc', c: '#4f7f6c' },
  { name: 'Nuit', a: '#2c3f6e', b: '#3d5594', c: '#161f3a' },
  { name: 'Lilas', a: '#c9a8d8', b: '#e6d3ee', c: '#7d5c93' },
  { name: 'Terre', a: '#c8794a', b: '#e2a476', c: '#7a3f2c' },
  { name: 'Anémone', a: '#7fb24a', b: '#f2a93b', c: '#2e6f7a' },
]

/** Clamp anything (LLM output included) into a generator-safe parameter set. */
export function sanitiseOrganic(raw: Partial<OrganicParams> | null | undefined): Partial<OrganicParams> {
  const o = raw ?? {}
  const out: Partial<OrganicParams> = {}
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  if (typeof o.form === 'string' && FORMS.includes(o.form)) out.form = o.form
  if (typeof o.pore === 'string' && PORES.includes(o.pore)) out.pore = o.pore
  if (typeof o.relief === 'string' && RELIEFS.includes(o.relief)) out.relief = o.relief
  if (typeof o.noiseType === 'string' && NOISES.includes(o.noiseType)) out.noiseType = o.noiseType
  if (typeof o.mirror === 'boolean') out.mirror = o.mirror
  const n = num(o.poreRows); if (n !== undefined) out.poreRows = Math.round(clamp(1, 8, n))
  const c = num(o.poreCount); if (c !== undefined) out.poreCount = Math.round(clamp(2, 12, c))
  const s = num(o.poreSize); if (s !== undefined) out.poreSize = clamp(0.04, 0.32, s)
  const r = num(o.poreRadius); if (r !== undefined) out.poreRadius = clamp(0.1, 0.8, r)
  const b = num(o.blend); if (b !== undefined) out.blend = clamp(0, 0.22, b)
  const l = num(o.latticeFreq); if (l !== undefined) out.latticeFreq = clamp(2, 14, l)
  const sh = num(o.shell); if (sh !== undefined) out.shell = clamp(0, 0.16, sh)
  const tw = num(o.twist); if (tw !== undefined) out.twist = clamp(-3.5, 3.5, tw)
  const tp = num(o.taper); if (tp !== undefined) out.taper = clamp(-0.8, 0.8, tp)
  const bd = num(o.bend); if (bd !== undefined) out.bend = clamp(-1.2, 1.2, bd)
  const na = num(o.noiseAmp); if (na !== undefined) out.noiseAmp = clamp(0, 0.09, na)
  const nf = num(o.noiseFreq); if (nf !== undefined) out.noiseFreq = clamp(0.5, 8, nf)
  const rs = num(o.res); if (rs !== undefined) out.res = Math.round(clamp(40, 160, rs))
  const pj = num(o.poreJitter); if (pj !== undefined) out.poreJitter = clamp(0, 1, pj)
  const rd = num(o.reliefDensity); if (rd !== undefined) out.reliefDensity = clamp(0, 1, rd)
  const rh = num(o.reliefHeight); if (rh !== undefined) out.reliefHeight = clamp(0, 0.3, rh)
  const rz = num(o.reliefSize); if (rz !== undefined) out.reliefSize = clamp(0, 1, rz)
  const op = num(o.open); if (op !== undefined) out.open = clamp(0, 0.7, op)
  const sd = num(o.seed); if (sd !== undefined) out.seed = Math.round(clamp(0, 9999, sd))
  const pt = num(o.petals); if (pt !== undefined) out.petals = Math.round(clamp(3, 16, pt))
  const cu = num(o.curl); if (cu !== undefined) out.curl = clamp(0, 1.5, cu)
  const st = num(o.stamens); if (st !== undefined) out.stamens = Math.round(clamp(0, 40, st))
  // Garde-fou de COMBINAISON : chaque valeur peut être dans ses bornes et l'ensemble
  // produire quand même du vide — des ouvertures plus larges que leur espacement se
  // rejoignent et sectionnent le corps entier. Le modèle ne peut pas anticiper cette
  // géométrie, on tempère donc ici. Les curseurs manuels restent volontairement libres :
  // l'artiste a le droit de tout dissoudre, l'IA ne doit jamais rendre une scène vide.
  if (out.poreSize !== undefined) {
    const count = out.poreCount ?? ORG_DEFAULTS.poreCount
    const radius = out.poreRadius ?? ORG_DEFAULTS.poreRadius
    const spacing = (Math.PI * radius) / Math.max(1, count)
    out.poreSize = Math.min(out.poreSize, Math.max(0.05, spacing * 0.95))
  }
  return out
}

/** Same idea for the look : a known material, #rrggbb colours, a boolean — nothing else. */
export function sanitiseLook(raw: unknown): OrgLook {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: OrgLook = {}
  const hex = (v: unknown) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim().toLowerCase() : undefined)
  if (typeof o.material === 'string' && LOOK_MATERIALS.includes(o.material)) out.material = o.material
  const a = hex(o.colorA), b = hex(o.colorB), c = hex(o.colorC)
  if (a) out.colorA = a
  if (b) out.colorB = b
  if (c) out.colorC = c
  if (typeof o.lamp === 'boolean') out.lamp = o.lamp
  return out
}

/** Turn an HTTP failure from /api/organic into something the artist can act on.
 *  « IA indisponible » alone is useless — the fix differs completely per cause. */
export function organicApiError(status: number, bodyMessage?: string): string {
  if (status === 401 || status === 403) return 'connecte-toi sur /admin (les endpoints IA sont réservés à l\'admin)'
  if (status === 503) return 'clé Anthropic absente — renseigne-la sur /admin'
  if (status === 429) return 'trop de requêtes, réessaie dans une minute'
  if (status === 404) return 'endpoint absent (serveur de dev local : les routes /api ne tournent pas)'
  if (status === 413) return 'image trop lourde'
  if (status === 0) return 'réseau injoignable'
  return bodyMessage || `erreur serveur ${status}`
}

/** Deterministic local interpretation — the offline fallback.
 *  `matched` says whether any keyword was actually recognised : without it the caller
 *  cannot tell a real interpretation from the random "surprise me" variation, and would
 *  wrongly present noise as understanding. */
export function textToOrganic(prompt: string, seed = 0): { params: Partial<OrganicParams>; look: OrgLook; explain: string; matched: boolean } {
  const t = (prompt || '').toLowerCase()
  const has = (...k: string[]) => k.some((x) => t.includes(x))
  const p: Partial<OrganicParams> = {}
  const look: OrgLook = {}
  const why: string[] = []

  // — corps — (fr + en, l'artiste ne doit pas deviner mon vocabulaire)
  if (has('fleur', 'flower', 'pétales en ruban', 'étamine', 'etamine', 'engrenage', 'mécanique', 'mecanique', 'mechanical', 'orchidée', 'orchidee', 'lys')) { p.form = 'fleur'; p.pore = 'aucun'; p.shell = 0; p.mirror = false; p.curl = has('ouvert', 'plat', 'épanoui', 'epanoui') ? 0.35 : has('boucle', 'enroul', 'frisé', 'frise') ? 1.15 : 0.85; why.push('fleur à pétales en ruban') }
  else if (has('goutte', 'larme', 'teardrop', 'drop', 'bourgeon fermé')) { p.form = 'goutte'; why.push('corps en goutte') }
  else if (has('gourde', 'calebasse', 'bouteille', 'bottle', 'gourd', 'poire', 'carafe')) { p.form = 'gourde'; why.push('gourde') }
  else if (has('dôme', 'dome', 'coupole', 'champignon', 'mushroom', 'demi-sph', 'balane', 'barnacle')) { p.form = 'dome'; why.push('dôme posé') }
  else if (has('panneau', 'dalle', 'plaque', 'bas-relief', 'panel', 'mural', 'claustra')) { p.form = 'dalle'; why.push('panneau') }
  else if (has('vase', 'urne', 'amphore', 'lyre', 'buste', 'torse', 'corps', 'vessel', 'jarre', 'calice', 'silhouette')) { p.form = 'lyre'; why.push('corps en lyre') }
  else if (has('colonne', 'totem', 'tour', 'pilier', 'élancé', 'elance', 'column', 'obélisque', 'obelisque', 'stèle', 'stele', 'vertical')) { p.form = 'colonne'; why.push('colonne élancée') }
  else if (has('anneau', 'tore', 'torus', 'donut', 'couronne', 'bague', 'cercle', 'bracelet')) { p.form = 'tore'; why.push('tore') }
  else if (has('ruban', 'ribbon', 'nœud', 'noeud', 'knot', 'boucle infinie', 'vague', 'wave', 'flamme', 'plat')) { p.form = 'ruban'; why.push('ruban plat') }
  else if (has('œuf', 'oeuf', 'egg', 'ovale', 'ovoïde', 'ovoide', 'graine', 'seed', 'galet', 'cocon', 'bulbe', 'boule', 'sphère', 'sphere', 'oursin', 'urchin')) { p.form = 'ovoide'; why.push('ovoïde') }

  // — perforation —
  // « os » en mot entier : il se cache dans « losange », « rose », « poser »…
  if (/(^|[^a-zà-ÿ])os([^a-zà-ÿ]|$)/.test(t) || has('bone', 'trabécul', 'trabecul', 'gyroïde', 'gyroide', 'gyroid', 'mousse', 'foam', 'éponge', 'eponge', 'sponge', 'poreux', 'poreu')) { p.pore = 'lattice'; p.shell = 0; why.push('réseau gyroïde') }
  else if (has('nid d', 'honeycomb', 'hexagon', 'ruche', 'veine', 'vein')) { p.pore = 'alveoles'; p.shell = 0.03; p.poreJitter = has('veine', 'vein', 'organique') ? 1 : 0.1; p.poreCount = 9; p.poreRows = 6; p.poreSize = 0.24; p.blend = 0.012; why.push('alvéoles de surface') }
  else if (has('résille', 'resille', 'losange', 'diamond', 'treillis', 'croisillon', 'tressé', 'tresse')) { p.pore = 'resille'; p.shell = 0.03; p.poreCount = 9; p.poreRows = 7; p.poreSize = 0.2; p.blend = 0.01; why.push('résille en losanges') }
  else if (has('cellule', 'cellular', 'voronoï', 'voronoi', 'corail', 'coral', 'alvéol', 'alveol', 'nid', 'bulle', 'érodé', 'erode')) { p.pore = 'cellules'; p.shell = 0; why.push('cellules de Voronoï') }
  else if (has('trou', 'hole', 'perfor', 'pore', 'percé', 'perce', 'criblé', 'crible', 'troué', 'troue')) { p.pore = 'pores'; why.push('perforations rondes') }
  else if (has('boucle', 'loop', 'anse', 'entrelac', 'squelette', 'skeleton', 'côte', 'nervure', 'nervur', 'dentelle', 'lace', 'ajour', 'arche', 'lattice')) { p.pore = 'boucles'; why.push('boucles ajourées') }
  else if (has('plein', 'solid', 'lisse', 'smooth', 'massif', 'poli', 'polish', 'chrome', 'métal', 'metal', 'miroir', 'mirror', 'liquide')) { p.pore = 'aucun'; p.shell = 0; why.push('surface pleine') }

  // — relief (ce qui s'ajoute) —
  if (has('épine', 'epine', 'piquant', 'oursin', 'urchin', 'spike', 'hérisson', 'herisson', 'cactus', 'pointe')) { p.relief = 'epines'; p.reliefHeight = 0.2; p.reliefDensity = 0.5; p.reliefSize = 0.6; why.push('épines') }
  else if (has('polype', 'tube', 'balane', 'barnacle', 'cratère', 'cratere', 'ventouse', 'cheminée', 'cheminee')) { p.relief = 'polypes'; p.reliefHeight = 0.13; p.reliefDensity = 0.45; p.reliefSize = 0.95; why.push('polypes') }
  else if (has('rosette', 'anémone', 'anemone', 'marguerite', 'corolle')) { p.relief = 'rosettes'; p.reliefHeight = 0.05; p.reliefDensity = 0.4; p.reliefSize = 0.95; why.push('rosettes cannelées') }
  else if (has('perle', 'pearl', 'bourgeon', 'bouton', 'granul', 'pustule', 'verrue')) { p.relief = 'perles'; p.reliefHeight = 0.05; p.reliefDensity = 0.55; p.reliefSize = 0.8; why.push('perles') }
  else if (has('écaille', 'ecaille', 'pétale', 'petale', 'scale', 'petal', 'pomme de pin', 'artichaut', 'feuille', 'leaf')) { p.relief = 'ecailles'; p.reliefHeight = 0.07; p.reliefDensity = 0.3; p.reliefSize = 1; why.push('écailles imbriquées') }
  else if (has('cannel', 'côtel', 'cotel', 'godron', 'strié', 'strie', 'ribbed', 'flute', 'coquill')) { p.relief = 'cannelures'; p.reliefHeight = 0.05; p.reliefDensity = 0.4; p.reliefSize = 0.5; why.push('cannelures') }
  else if (has('méandre', 'meandre', 'cerveau', 'brain', 'labyrinth', 'sinueu')) { p.relief = 'meandres'; p.reliefHeight = 0.035; p.reliefDensity = 0.5; why.push('méandres') }
  if (p.relief && p.pore === undefined) { p.pore = 'aucun'; p.shell = p.relief === 'polypes' ? 0.04 : 0 }

  // — ouverture / lumière —
  if (has('bol', 'coupe ', 'bowl')) { p.open = 0.5; p.shell = p.shell || 0.04; why.push('coupe ouverte') }
  else if (has('ouvert', 'open', 'vase', 'abat-jour', 'pot')) { p.open = 0.1; p.shell = p.shell || 0.035; why.push('ouvert en haut') }
  if (has('lampe', 'lamp', 'lumin', 'abat-jour', 'lanterne', 'lantern', 'éclair')) { look.lamp = true; look.material = 'porcelaine'; p.shell = p.shell || 0.03; why.push('lumière intérieure') }

  // — densité / finesse —
  if (has('dense', 'serré', 'serre', 'fin', 'fine', 'nombreux', 'beaucoup')) { p.poreCount = 9; p.poreRows = 6; p.latticeFreq = 11; if (p.relief) p.reliefDensity = Math.min(1, (p.reliefDensity ?? 0.4) + 0.3); why.push('trame dense') }
  else if (has('aéré', 'aere', 'large', 'espacé', 'espace', 'peu de', 'grossier', 'simple')) { p.poreCount = 4; p.poreRows = 2; p.latticeFreq = 4.5; if (p.relief) p.reliefDensity = Math.max(0.05, (p.reliefDensity ?? 0.4) - 0.2); why.push('trame aérée') }

  // — épaisseur / fondu —
  if (has('épais', 'epais', 'charnu', 'massif', 'robuste', 'gras')) { p.blend = 0.16; p.shell = 0.09; why.push('entretoises épaisses') }
  else if (has('mince', 'fin', 'délicat', 'delicat', 'fragile', 'filaire', 'filiforme')) { p.blend = 0.04; p.shell = 0.035; why.push('parois minces') }

  // — déformateurs —
  if (has('torsad', 'tordu', 'spiral', 'vrill', 'hélic', 'helic', 'twist')) { p.twist = has('fort', 'très', 'tres', 'extrême', 'extreme') ? 3 : 1.8; why.push('torsion') }
  if (has('effilé', 'effile', 'pointu', 'conique', 'flamme')) { p.taper = 0.45; why.push('effilé') }
  if (has('courbé', 'courbe', 'penché', 'penche', 'arqué', 'arque', 'crochet')) { p.bend = 0.6; why.push('courbure') }
  if (has('rugueux', 'érodé', 'erode', 'organique', 'irrégul', 'irregul', 'noueux', 'brut', 'roche')) { p.noiseAmp = 0.035; p.noiseType = has('crête', 'crete', 'arête', 'arete') ? 'ridged' : 'fbm'; why.push('bruit organique') }
  if (has('symétri', 'symetri', 'miroir', 'papillon')) p.mirror = true
  if (has('asymétri', 'asymetri', 'libre', 'chaotique')) p.mirror = false
  if (p.relief && p.mirror === undefined) p.mirror = false

  // — couleurs / matière —
  const pal = (name: string, mat?: string) => { const q = PALETTES.find((x) => x.name === name)!; look.colorA = q.a; look.colorB = q.b; look.colorC = q.c; if (mat && !look.material) look.material = mat; why.push(`émail ${name.toLowerCase()}`) }
  if (p.form === 'fleur') { look.colorA = '#d21f3c'; look.colorB = '#c4c8cf'; look.colorC = '#d88cc4'; look.material = 'matte' }
  if (has('turquoise', 'récif', 'recif', 'lagon')) pal('Récif', 'email')
  else if (has('porcelaine', 'blanc', 'white', 'biscuit', 'ivoire')) pal('Porcelaine', 'porcelaine')
  else if (has('céladon', 'celadon', 'jade', 'vert d')) pal('Céladon', 'email')
  else if (has('bleu', 'blue', 'indigo', 'nuit')) pal('Nuit', 'matte')
  else if (has('lilas', 'mauve', 'violet', 'lavande')) pal('Lilas', 'matte')
  else if (has('terre cuite', 'terracotta', 'argile', 'grès', 'gres')) pal('Terre', 'clay')
  else if (has('orange', 'corail rouge', 'rouge')) pal('Corail', 'email')
  if (has('chrome', 'miroir', 'métal', 'metal')) look.material = 'chrome'
  else if (has('émail', 'email', 'glaçure', 'glacure', 'vernis', 'brillant', 'céramique', 'ceramique')) look.material = look.material ?? 'email'
  else if (has('mat ', 'mate', 'matte')) look.material = 'matte'

  // — définition —
  if (has('détail', 'detail', 'haute défin', 'haute defin', 'hd', 'précis', 'precis')) { p.res = 128; why.push('haute définition') }
  else if (has('rapide', 'brouillon', 'aperçu', 'apercu', 'esquisse')) { p.res = 56; why.push('aperçu rapide') }

  // Rien de reconnu → une variation aléatoire mais cohérente (« surprends-moi »).
  const matched = Object.keys(p).length > 0 || Object.keys(look).length > 0
  if (!matched) {
    let s = (seed || 1) >>> 0
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
    const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]
    p.form = pick(FORMS.filter((f) => f !== 'dalle' && f !== 'fleur'))
    p.twist = (rnd() * 2 - 1) * 1.8; p.taper = (rnd() * 2 - 1) * 0.3
    p.seed = Math.floor(rnd() * 9999)
    if (rnd() < 0.5) {
      // une pièce à relief : corps plein (ou coque pour les polypes), rien de percé
      p.relief = pick(RELIEFS.filter((r) => r !== 'aucun')); p.pore = 'aucun'; p.mirror = false
      const scattered = ['polypes', 'epines', 'rosettes', 'perles'].includes(p.relief)
      p.reliefDensity = 0.25 + rnd() * 0.45; p.reliefSize = 0.6 + rnd() * 0.4
      p.reliefHeight = p.relief === 'epines' ? 0.14 + rnd() * 0.12 : p.relief === 'polypes' ? 0.08 + rnd() * 0.08 : scattered ? 0.04 + rnd() * 0.03 : 0.03 + rnd() * 0.05
      p.shell = p.relief === 'polypes' ? 0.04 : 0
    } else {
      // une pièce ajourée
      // « pores » et « boucles » sont des trous posés à une distance fixe de l'axe : tirée au
      // hasard, elle rase souvent la paroi et ne laisse que des fossettes (la capture de
      // l'utilisateur du 2026-11-26). Le hasard se limite aux ajours qui percent à coup sûr.
      p.relief = 'aucun'; p.pore = pick(PORES.filter((x) => x !== 'aucun' && x !== 'pores' && x !== 'boucles'))
      p.poreCount = 3 + Math.floor(rnd() * 8); p.poreRows = 2 + Math.floor(rnd() * 5)
      p.poreSize = 0.08 + rnd() * 0.16; p.poreRadius = 0.28 + rnd() * 0.34; p.poreJitter = rnd()
      p.blend = 0.03 + rnd() * 0.14; p.latticeFreq = 4 + rnd() * 8
      const surface = ['grille', 'alveoles', 'resille'].includes(p.pore)
      p.shell = surface ? 0.03 + rnd() * 0.02 : rnd() < 0.6 ? 0.03 + rnd() * 0.08 : 0
      if (surface) p.blend = 0.01 + rnd() * 0.02
      p.mirror = !surface && rnd() < 0.7
    }
    const q = pick(PALETTES); look.colorA = q.a; look.colorB = q.b; look.colorC = q.c
    look.material = pick(['email', 'porcelaine', 'matte'])
    why.push('variation aléatoire cohérente')
  }
  return { params: sanitiseOrganic(p), look: sanitiseLook(look), explain: why.join(' · '), matched }
}

/** Vocabulary hint shown when nothing was recognised — so the box isn't a black one. */
export const ORG_AI_HINTS = 'fleur mécanique · goutte · gourde · dôme · panneau · vase · totem · polypes · épines · rosettes · perles · écailles · cannelures · méandres · nid d\'abeille · résille · dentelle · os · corail · lampe · torsadé · effilé · dense · aéré · turquoise · porcelaine · bleu · lilas'
