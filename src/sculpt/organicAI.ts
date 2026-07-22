/**
 * Text → organic-parametric params, for the sculpture studio's AI generator.
 *
 * Two layers, on purpose:
 *  - `textToOrganic` is LOCAL and deterministic (keyword driven). It always works — no key,
 *    no network, no cost — so the feature can never be dead in the water.
 *  - the studio first asks /api/organic (a real LLM, richer nuance) and falls back to this
 *    the moment the endpoint is missing, unconfigured, rate-limited or offline.
 *
 * Both paths funnel through `sanitiseOrganic`, so a model can never push the generator into
 * an invalid state (empty mesh, 10-minute resolution, negative thickness…).
 */
import { ORG_DEFAULTS, type OrganicParams, type OrgForm, type OrgPore } from './organic'
import type { NoiseType } from '../morpho/fields'

const clamp = (a: number, b: number, v: number) => Math.max(a, Math.min(b, v))
const FORMS: OrgForm[] = ['ovoide', 'colonne', 'lyre', 'tore', 'ruban']
const PORES: OrgPore[] = ['aucun', 'pores', 'boucles', 'lattice', 'cellules']
const NOISES: NoiseType[] = ['value', 'fbm', 'ridged', 'turbulence', 'worley']

/** Clamp anything (LLM output included) into a generator-safe parameter set. */
export function sanitiseOrganic(raw: Partial<OrganicParams> | null | undefined): Partial<OrganicParams> {
  const o = raw ?? {}
  const out: Partial<OrganicParams> = {}
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  if (typeof o.form === 'string' && FORMS.includes(o.form)) out.form = o.form
  if (typeof o.pore === 'string' && PORES.includes(o.pore)) out.pore = o.pore
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
  const rs = num(o.res); if (rs !== undefined) out.res = Math.round(clamp(40, 140, rs))
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

/** Deterministic local interpretation — the offline fallback. */
export function textToOrganic(prompt: string, seed = 0): { params: Partial<OrganicParams>; explain: string } {
  const t = (prompt || '').toLowerCase()
  const has = (...k: string[]) => k.some((x) => t.includes(x))
  const p: Partial<OrganicParams> = {}
  const why: string[] = []

  // — corps —
  if (has('vase', 'urne', 'amphore', 'lyre', 'buste', 'torse', 'corps')) { p.form = 'lyre'; why.push('corps en lyre') }
  else if (has('colonne', 'totem', 'tour', 'pilier', 'haut', 'élancé', 'elance')) { p.form = 'colonne'; why.push('colonne élancée') }
  else if (has('anneau', 'tore', 'donut', 'couronne', 'bague')) { p.form = 'tore'; why.push('tore') }
  else if (has('ruban', 'ribbon', 'nœud', 'noeud', 'boucle infinie', 'vague')) { p.form = 'ruban'; why.push('ruban plat') }
  else if (has('œuf', 'oeuf', 'ovale', 'ovoïde', 'ovoide', 'graine', 'galet')) { p.form = 'ovoide'; why.push('ovoïde') }

  // — perforation —
  if (has('os', 'trabécul', 'trabecul', 'gyroïde', 'gyroide', 'mousse', 'éponge', 'eponge')) { p.pore = 'lattice'; p.shell = 0; why.push('réseau gyroïde') }
  else if (has('cellule', 'voronoï', 'voronoi', 'corail', 'alvéol', 'alveol')) { p.pore = 'cellules'; p.shell = 0; why.push('cellules de Voronoï') }
  else if (has('trou', 'perfor', 'pore', 'percé', 'perce', 'criblé', 'crible')) { p.pore = 'pores'; why.push('perforations rondes') }
  else if (has('boucle', 'anse', 'entrelac', 'squelette', 'côte', 'cote', 'nervure', 'dentelle', 'ajour')) { p.pore = 'boucles'; why.push('boucles ajourées') }
  else if (has('plein', 'lisse', 'massif', 'poli', 'chrome', 'métal', 'metal', 'miroir')) { p.pore = 'aucun'; p.shell = 0; why.push('surface pleine') }

  // — densité / finesse —
  if (has('dense', 'serré', 'serre', 'fin', 'fine', 'nombreux', 'beaucoup')) { p.poreCount = 9; p.poreRows = 6; p.latticeFreq = 11; why.push('trame dense') }
  else if (has('aéré', 'aere', 'large', 'espacé', 'espace', 'peu de', 'grossier', 'simple')) { p.poreCount = 4; p.poreRows = 2; p.latticeFreq = 4.5; why.push('trame aérée') }

  // — épaisseur / fondu —
  if (has('épais', 'epais', 'charnu', 'massif', 'robuste', 'gras')) { p.blend = 0.16; p.shell = 0.09; why.push('entretoises épaisses') }
  else if (has('mince', 'fin', 'délicat', 'delicat', 'fragile', 'filaire', 'filiforme')) { p.blend = 0.04; p.shell = 0.035; why.push('parois minces') }

  // — déformateurs —
  if (has('torsad', 'tordu', 'spiral', 'vrill', 'hélic', 'helic', 'twist')) { p.twist = has('fort', 'très', 'tres', 'extrême', 'extreme') ? 3 : 1.8; why.push('torsion') }
  if (has('effilé', 'effile', 'pointu', 'conique', 'flamme', 'goutte')) { p.taper = 0.45; why.push('effilé') }
  if (has('courbé', 'courbe', 'penché', 'penche', 'arqué', 'arque', 'crochet')) { p.bend = 0.6; why.push('courbure') }
  if (has('rugueux', 'érodé', 'erode', 'organique', 'irrégul', 'irregul', 'noueux', 'brut', 'roche')) { p.noiseAmp = 0.035; p.noiseType = has('crête', 'crete', 'arête', 'arete') ? 'ridged' : 'fbm'; why.push('bruit organique') }
  if (has('symétri', 'symetri', 'miroir', 'papillon')) p.mirror = true
  if (has('asymétri', 'asymetri', 'libre', 'chaotique')) p.mirror = false

  // — définition —
  if (has('détail', 'detail', 'haute défin', 'haute defin', 'hd', 'précis', 'precis')) { p.res = 110; why.push('haute définition') }
  else if (has('rapide', 'brouillon', 'aperçu', 'apercu', 'esquisse')) { p.res = 52; why.push('aperçu rapide') }

  // Rien de reconnu → une variation aléatoire mais cohérente (« surprends-moi »).
  if (Object.keys(p).length === 0) {
    let s = (seed || 1) >>> 0
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
    p.form = FORMS[Math.floor(rnd() * FORMS.length)]
    p.pore = PORES[1 + Math.floor(rnd() * (PORES.length - 1))]
    p.poreCount = 3 + Math.floor(rnd() * 8); p.poreRows = 2 + Math.floor(rnd() * 5)
    p.poreSize = 0.08 + rnd() * 0.16; p.poreRadius = 0.28 + rnd() * 0.34
    p.blend = 0.03 + rnd() * 0.14; p.shell = rnd() < 0.6 ? 0.03 + rnd() * 0.08 : 0
    p.latticeFreq = 4 + rnd() * 8; p.twist = (rnd() * 2 - 1) * 2.2; p.taper = (rnd() * 2 - 1) * 0.5
    p.mirror = rnd() < 0.7
    why.push('variation aléatoire cohérente')
  }
  return { params: sanitiseOrganic(p), explain: why.join(' · ') }
}
