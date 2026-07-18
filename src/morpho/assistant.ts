/**
 * Assistant génératif de MORPHOGENESIS STUDIO — texte → graphe nodal, et commandes
 * conversationnelles qui modifient le graphe courant. Déterministe et local (aucune clé
 * exposée) : il détecte des concepts (forme, opérations, matière) et construit un VRAI
 * graphe évaluable, en expliquant les nœuds employés. Peut être remplacé/augmenté plus
 * tard par un vrai LLM via un endpoint configuré côté serveur.
 */
import type { Graph, GNode } from './graph'
import { makeNode, uid } from './graph'

export type MatKind = 'clay' | 'matte' | 'chrome' | 'gloss' | 'translucent'
export interface Built { graph: Graph; explain: string[]; material?: MatKind }

type Step = { type: string; params?: Record<string, number | string> }
function chainGraph(steps: Step[]): Graph {
  const nodes: GNode[] = []; let x = 40
  for (const s of steps) { const n = makeNode(s.type, x, 90 + (nodes.length % 2) * 40); if (s.params) Object.assign(n.params, s.params); nodes.push(n); x += 180 }
  const out = makeNode('output', x, 110); nodes.push(out)
  const edges = nodes.slice(0, -1).map((n, i) => ({ id: uid('e'), from: n.id, fromIdx: 0, to: nodes[i + 1].id, toIdx: 0 }))
  return { nodes, edges }
}
const clone = (g: Graph): Graph => JSON.parse(JSON.stringify(g))
const clamp = (a: number, b: number, v: number) => Math.max(a, Math.min(b, v))

/** Insert a new node into the field chain just before `targetType` (rewiring source→new→target). */
function insertBefore(g: Graph, targetType: string, newType: string, params?: Record<string, number | string>): GNode | null {
  const target = g.nodes.find((n) => n.type === targetType); if (!target) return null
  const feed = g.edges.find((e) => e.to === target.id && e.toIdx === 0)
  const nn = makeNode(newType, target.x - 170, target.y + 30); if (params) Object.assign(nn.params, params)
  g.nodes.push(nn)
  if (feed) { feed.to = nn.id; feed.toIdx = 0 }
  g.edges.push({ id: uid('e'), from: nn.id, fromIdx: 0, to: target.id, toIdx: 0 })
  return nn
}

// ── Text → graph ─────────────────────────────────────────────────────────────
export function textToGraph(prompt: string): Built {
  const t = prompt.toLowerCase()
  const has = (...ks: string[]) => ks.some((k) => t.includes(k))
  const nAfter = (re: RegExp) => { const m = t.match(re); return m ? parseInt(m[1], 10) : null }
  const steps: Step[] = [], explain: string[] = []

  // — source form —
  if (has('voronoï', 'voronoi', 'cellul', 'poreux', 'porous', 'alvéol', 'nid d')) { steps.push({ type: 'voronoi', params: { scale: nAfter(/(\d+)\s*cellul/) ?? 4, thick: 0.08 } }); explain.push('Voronoï 3D — réseau de cellules à parois fines.') }
  else if (has('gyroïde', 'gyroid', 'tpms', 'minimale')) { steps.push({ type: 'gyroid' }); explain.push('Gyroïde (TPMS) — surface minimale continue et poreuse.') }
  else if (has(' os', 'bone', 'trabecul', 'treillis', 'lattice')) { steps.push({ type: 'schwarz' }); explain.push('Schwarz-P — treillis dense type structure osseuse.') }
  else if (has('fleur', 'bloom', 'phyllo', 'tournesol', 'inflor')) { steps.push({ type: 'bloom' }); explain.push('Phyllotaxie — croissance radiale en spirale dorée.') }
  else if (has('corail', 'coral', 'éponge', 'sponge')) { steps.push({ type: 'metaballs', params: { count: 16, radius: 0.32, spread: 0.6, seed: 7 } }); explain.push('Metaballs fusionnés — masse organique corallienne.') }
  else if (has('tore', 'torus', 'anneau', 'donut')) { steps.push({ type: 'torus' }); explain.push('Tore (SDF).') }
  else if (has('cube', ' box', 'boîte', 'boite')) { steps.push({ type: 'box' }); explain.push('Cube (SDF).') }
  else if (has('sphère', 'sphere', 'boule', 'coquille', 'shell', 'nautilus', 'vase', 'vessel', 'creux', 'hollow')) { steps.push({ type: 'sphere', params: { r: 0.95 } }); explain.push('Sphère de base.') }
  else { steps.push({ type: 'metaballs' }); explain.push('Metaballs — masse organique fusionnée (défaut).') }

  // — surface texture / relief —
  if (has('nervur', 'crêtes', 'cretes', 'ridge', 'rugueux', 'gravé', 'strié')) { steps.push({ type: 'displace', params: { type: 'ridged', amp: 0.15, freq: 3.5 } }); explain.push('Déplacement « crêtes » — nervures fractales.') }
  else if (has('organique', 'organic', 'bosses', 'noueux', 'irrégul', 'bumpy')) { steps.push({ type: 'displace', params: { type: 'fbm', amp: 0.1, freq: 3 } }); explain.push('Déplacement fBm — surface organique.') }
  else if (has('cellulaire', 'worley', 'peau de')) { steps.push({ type: 'displace', params: { type: 'worley', amp: 0.12, freq: 3 } }); explain.push('Déplacement cellulaire — peau alvéolée.') }

  // — transforms —
  if (has('torsad', 'twist', 'vrill', 'spiral', 'spiralé', 'spiralée', 'hélic', 'nautilus')) { steps.push({ type: 'twist', params: { k: 1.7 } }); explain.push('Torsion — croissance hélicoïdale.') }
  if (has('effilé', 'effilee', 'taper', 'pointu', 'conique', 'gothique')) { steps.push({ type: 'taper', params: { k: 0.45 } }); explain.push('Effilé — resserrement vers le haut.') }
  const radN = nAfter(/sym[ée]tri\w*\s*(?:radiale\s*)?(\d+)/) ?? nAfter(/(\d+)\s*branch/) ?? (has('symétri', 'symetri', 'radial', 'étoile', 'fleur', 'gothique') ? 6 : null)
  if (radN) { steps.push({ type: 'radial', params: { n: clamp(1, 12, radN) } }); explain.push(`Symétrie radiale ×${clamp(1, 12, radN)}.`) }
  if (has('miroir', 'mirror', 'bilatéral', 'bilateral')) { steps.push({ type: 'mirror' }); explain.push('Miroir bilatéral gauche/droite.') }
  if ((has('creux', 'hollow', 'vase', 'vessel', 'coque', 'évidé') || has('coquille')) && !steps.some((s) => s.type === 'voronoi')) { steps.push({ type: 'shell', params: { t: 0.07 } }); explain.push('Coque — objet creux à parois fines.') }

  // — mesh —
  const hi = has('détaillé', 'detaille', ' fin', 'haute', 'précis', 'precise', 'hd', 'net')
  steps.push({ type: 'surface', params: { res: hi ? 108 : 80, bound: 1.2 } }); explain.push(`Surface (marching cubes) — ${hi ? 'haute' : 'moyenne'} résolution.`)
  if (!has('anguleux', 'brut', 'faceted', 'low-poly', 'facetté')) { steps.push({ type: 'smooth', params: { iter: has('très lisse', 'tres lisse', 'poli', 'lisse') ? 3 : 1 } }); explain.push('Lissage laplacien.') }

  // — material —
  let material: MatKind | undefined
  if (has('noir brillant', 'obsidienne', 'noir laqué', 'black gloss', ' noir')) material = 'gloss'
  else if (has('translucide', 'transparent', 'verre', 'translucent', 'résine', 'resine', 'cire')) material = 'translucent'
  else if (has('chrome', 'métal', 'metal', 'argent', 'acier', 'metallic')) material = 'chrome'
  else if (has(' mat', 'matte', 'plâtre', 'platre')) material = 'matte'
  else if (has('argile', 'clay', 'céramique', 'ceramique', 'terre cuite', 'terracotta')) material = 'clay'
  if (material) explain.push(`Matériau : ${material}.`)

  return { graph: chainGraph(steps), explain, material }
}

// ── Conversational commands on the current graph ──────────────────────────────
export function applyCommand(cmd: string, graph: Graph): Built {
  const t = cmd.toLowerCase(); const g = clone(graph); const explain: string[] = []; let material: MatKind | undefined
  const has = (...ks: string[]) => ks.some((k) => t.includes(k))
  const find = (type: string) => g.nodes.find((n) => n.type === type)
  const pct = (() => { const m = t.match(/(\d+)\s*%/); return m ? parseInt(m[1], 10) / 100 : null })()
  const N = (v: unknown, d = 0) => (typeof v === 'number' ? v : d)

  if (has('plus organique', 'more organic', 'organique')) {
    let d = find('displace'); if (!d) d = insertBefore(g, 'surface', 'displace', { type: 'fbm', amp: 0.12, freq: 3 }) ?? undefined
    if (d) { d.params.type = 'fbm'; d.params.amp = clamp(0, 0.5, N(d.params.amp, 0.1) + 0.06); explain.push('Bruit organique (fBm) renforcé.') }
  } else if (has('réduis les pointes', 'reduis les pointes', 'moins pointu', 'moins de pointes', 'less spike', 'adoucis')) {
    const d = find('displace'); if (d) { d.params.type = 'fbm'; d.params.amp = clamp(0, 0.5, N(d.params.amp, 0.14) * 0.5) } const s = find('smooth'); if (s) s.params.iter = clamp(0, 8, N(s.params.iter, 1) + 1); else insertBefore(g, 'output', 'smooth', { iter: 2 }); explain.push('Pointes atténuées + lissage augmenté.')
  } else if (has('augmente la porosité', 'plus poreux', 'more porous', 'plus de porosité', 'plus de trous')) {
    const v = find('voronoi'); if (v) { v.params.scale = clamp(1.5, 9, N(v.params.scale, 4) + 1.2); explain.push('Densité de cellules Voronoï augmentée.') } else { const sh = find('shell') ?? insertBefore(g, 'surface', 'shell', { t: 0.06 }); if (sh) { sh.params.t = clamp(0.02, 0.4, N(sh.params.t, 0.08) * 0.7); explain.push('Coque affinée → plus poreux/léger.') } }
  } else if (has('réduis la porosité', 'reduis la porosité', 'moins poreux', 'less porous')) {
    const v = find('voronoi'); if (v) { v.params.scale = clamp(1.5, 9, N(v.params.scale, 4) - 1); v.params.thick = clamp(0.02, 0.3, N(v.params.thick, 0.08) + 0.03) } explain.push('Porosité réduite (cellules plus grosses / parois plus épaisses).')
  } else if (has('symétri', 'symmetric', 'rends-le symétrique', 'radial')) {
    if (!find('radial')) { insertBefore(g, 'surface', 'radial', { n: 6 }); explain.push('Symétrie radiale ×6 ajoutée.') } else explain.push('La structure est déjà radiale.')
  } else if (has('allège', 'allege', 'plus léger', 'plus leger', 'lighter', 'réduis le poids', 'reduis le poids')) {
    const amt = pct ?? 0.3; const sh = find('shell') ?? insertBefore(g, 'surface', 'shell', { t: 0.09 }); if (sh) { sh.params.t = clamp(0.02, 0.4, N(sh.params.t, 0.09) - amt * 0.12); explain.push(`Objet évidé (coque) → ~${Math.round(amt * 100)} % de matière en moins.`) }
  } else if (has('plus lisse', 'smoother', 'lisse-le', 'polir')) {
    const s = find('smooth') ?? insertBefore(g, 'output', 'smooth', { iter: 1 }); if (s) { s.params.iter = clamp(0, 8, N(s.params.iter, 1) + 2); explain.push('Lissage renforcé.') }
  } else if (has('plus détaillé', 'plus detaille', 'plus fin', 'haute résolution', 'haute resolution', 'finer', 'plus net')) {
    const s = find('surface'); if (s) { s.params.res = clamp(24, 140, N(s.params.res, 80) + 24); explain.push(`Résolution du maillage : ${s.params.res}.`) }
  } else if (has('moins détaillé', 'moins detaille', 'plus rapide', 'allège le maillage', 'décime')) {
    const s = find('surface'); if (s) { s.params.res = clamp(24, 140, N(s.params.res, 80) - 24); explain.push(`Résolution réduite : ${s.params.res} (plus léger/rapide).`) }
  } else if (has('plus grand', 'agrandi')) { const s = find('surface'); if (s) { s.params.bound = clamp(0.8, 1.6, N(s.params.bound, 1.2) + 0.1); explain.push('Cadre agrandi.') } }
  else if (has('plus petit', 'réduis la taille')) { const s = find('surface'); if (s) { s.params.bound = clamp(0.8, 1.6, N(s.params.bound, 1.2) - 0.1); explain.push('Cadre réduit.') } }
  else if (has('prépare', 'prepare', 'impression', 'imprimable', 'sls', 'fdm', 'sla', 'étanche', 'etanche', 'fabrication')) {
    const s = find('surface'); if (s) s.params.res = clamp(80, 140, Math.max(96, N(s.params.res, 80)))
    const sm = find('smooth') ?? insertBefore(g, 'output', 'smooth', { iter: 1 }); if (sm) sm.params.iter = clamp(1, 8, N(sm.params.iter, 1))
    if (!find('shell') && !find('voronoi')) insertBefore(g, 'surface', 'shell', { t: 0.08 })
    explain.push('Préparé pour l’impression : maillage plus dense, lissé, évidé si besoin. Vérifie « Étanche : oui » dans l’analyse.')
  } else if (has('conserve la silhouette', 'garde la silhouette', 'modifie les cellules', 'change les cellules')) {
    const v = find('voronoi'); if (v) { v.params.scale = clamp(1.5, 9, N(v.params.scale, 4) + (Math.random() > 0.5 ? 1 : -1)) } const d = find('displace'); if (d) d.params.freq = clamp(0.5, 8, N(d.params.freq, 3) + 1); const mb = find('metaballs'); if (mb) mb.params.seed = Math.floor(Math.random() * 9999) + 1; explain.push('Silhouette conservée, motif interne modifié.')
  } else if (has('translucide', 'transparent', 'verre')) { material = 'translucent'; explain.push('Matériau translucide.') }
  else if (has('chrome', 'métal', 'metal')) { material = 'chrome'; explain.push('Matériau chrome.') }
  else if (has('noir')) { material = 'gloss'; explain.push('Matériau noir brillant.') }
  else if (has('argile', 'clay', 'céramique')) { material = 'clay'; explain.push('Matériau argile.') }
  else explain.push('Commande non reconnue. Essaie : « plus organique », « augmente la porosité », « rends symétrique », « allège de 30 % », « prépare pour l’impression ».')

  return { graph: g, explain, material }
}

export const QUICK_COMMANDS = ['Plus organique', 'Réduis les pointes', 'Augmente la porosité', 'Rends symétrique', 'Allège de 30%', 'Plus lisse', 'Plus détaillé', 'Prépare pour l’impression']
export const EXAMPLE_PROMPTS = [
  'Une coquille spiralée translucide avec des nervures fractales',
  'Structure gothique symétrique en tubes organiques noirs',
  'Sphère en réseau Voronoï, cellules poreuses',
  'Vase creux cellulaire en céramique',
  'Treillis d’os imprimable',
  'Corail organique noueux',
]
