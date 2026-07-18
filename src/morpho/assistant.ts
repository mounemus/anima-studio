/**
 * Assistant génératif de MORPHOGENESIS STUDIO — texte → graphe nodal, et commandes
 * conversationnelles qui modifient le graphe courant. Déterministe et local (aucune clé
 * exposée) : il détecte des concepts (forme, opérations, matière) et construit un VRAI
 * graphe évaluable, en expliquant les nœuds employés. Peut être remplacé/augmenté plus
 * tard par un vrai LLM via un endpoint configuré côté serveur.
 */
import type { Graph, GNode } from './graph'
import { makeNode, uid, NODE_DEFS } from './graph'

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

function detectMat(t: string): MatKind | undefined {
  const has = (...ks: string[]) => ks.some((k) => t.includes(k))
  if (has('noir brillant', 'obsidienne', 'noir laqué', 'black gloss', ' noir')) return 'gloss'
  if (has('translucide', 'transparent', 'verre', 'translucent', 'résine', 'resine', 'cire')) return 'translucent'
  if (has('chrome', 'métal', 'metal', 'argent', 'acier', 'metallic')) return 'chrome'
  if (has(' mat', 'matte', 'plâtre', 'platre')) return 'matte'
  if (has('argile', 'clay', 'céramique', 'ceramique', 'terre cuite', 'terracotta')) return 'clay'
  return undefined
}

// ── Text → graph ─────────────────────────────────────────────────────────────
export function textToGraph(prompt: string): Built {
  const t = prompt.toLowerCase()
  const has = (...ks: string[]) => ks.some((k) => t.includes(k))
  const nAfter = (re: RegExp) => { const m = t.match(re); return m ? parseInt(m[1], 10) : null }
  let material = detectMat(t)

  // — parametric surfaces output a mesh directly (no field/marching-cubes pipeline) —
  if (has('klein', 'bouteille de klein')) { const surf = has('surface', 'figure', 'huit', '∞', 'infini', 'ruban de klein'); return { graph: chainGraph([{ type: surf ? 'kleinsurf' : 'klein' }, { type: 'smooth', params: { iter: 1 } }]), explain: [surf ? 'Surface de Klein (figure-8).' : 'Bouteille de Klein immergée.'], material } }
  if (has('möbius', 'mobius', 'moebius', 'ruban de möbius', 'ruban de mobius')) { return { graph: chainGraph([{ type: 'mobius', params: { res: 140, width: 0.42, twists: (nAfter(/(\d+)\s*torsion/) ?? 1) } }, { type: 'smooth', params: { iter: 1 } }]), explain: ['Ruban de Möbius.'], material } }
  if (has('plücker', 'plucker', 'conoïde', 'conoide')) { return { graph: chainGraph([{ type: 'plucker', params: { blades: (nAfter(/(\d+)\s*lobe/) ?? 2) } }, { type: 'smooth', params: { iter: 1 } }]), explain: ['Conoïde de Plücker.'], material } }
  if (has('géodésique', 'geodesique', 'geodesic', 'dôme', 'dome')) { return { graph: chainGraph([{ type: 'geodesic', params: { dome: has('sphère', 'complet', 'boule') ? 'full' : 'dome' } }]), explain: ['Dôme géodésique.'], material } }

  const steps: Step[] = [], explain: string[] = []

  // — source form (silhouettes variées, pas seulement sphériques) —
  if (has('méduse', 'meduse', 'jellyfish', 'ombrelle', 'cloche')) { steps.push({ type: 'metaballs', params: { shape: 'disc', count: 20, radius: 0.36, spread: 0.9, seed: 5 } }, { type: 'stretch', params: { sy: 0.7, sxz: 1.25 } }, { type: 'displace', params: { type: 'ridged', amp: 0.07, freq: 3.2 } }); explain.push('Dôme d’ombrelle bombé — corps de méduse (membrane translucide, nervures radiales).'); if (!material) material = 'translucent' }
  else if (has('mandelbulb', 'bulbe de mandel', 'mandel bulb')) { steps.push({ type: 'mandelbulb', params: { power: nAfter(/puissance\s*(\d+)/) ?? 8 } }); explain.push('Mandelbulb — fractal 3D à distance estimée.') }
  else if (has('dla', 'agrégation', 'agregation', 'ramifi', 'givre', 'foudre', 'dendrit')) { steps.push({ type: 'dla', params: { particles: 300, radius: 0.06 } }); explain.push('DLA — agrégation par diffusion, structure ramifiée.') }
  else if (has('réaction', 'reaction', 'gray-scott', 'gray scott', 'turing', 'diffusion')) { steps.push({ type: 'reaction', params: { preset: has('labyrinth', 'maze') ? 'maze' : has('point', 'spot', 'tacheté', 'pois') ? 'spots' : has('mitos') ? 'mitosis' : 'coral' } }); explain.push('Réaction-diffusion (Gray-Scott) — motif de Turing organique.') }
  else if (has('voronoï', 'voronoi', 'cellul', 'poreux', 'porous', 'alvéol', 'nid d')) { steps.push({ type: 'voronoi', params: { scale: nAfter(/(\d+)\s*cellul/) ?? 4, thick: 0.08 } }); explain.push('Voronoï 3D — réseau de cellules à parois fines.') }
  else if (has('gyroïde', 'gyroid', 'tpms', 'minimale')) { steps.push({ type: 'gyroid' }); explain.push('Gyroïde (TPMS) — surface minimale continue et poreuse.') }
  else if (has(' os', 'bone', 'trabecul', 'treillis', 'lattice')) { steps.push({ type: 'schwarz' }, { type: 'stretch', params: { sy: 1.5, sxz: 0.85 } }); explain.push('Schwarz-P allongé — treillis type os.') }
  else if (has('spiral', 'spirale', 'nautilus', 'hélic', 'helic', 'escargot', 'coquille', 'shell')) { steps.push({ type: 'helix', params: { count: 46, radius: 0.16, spread: 0.9, turns: 0.55 } }, { type: 'twist', params: { k: 1.1 } }); explain.push('Croissance hélicoïdale — coquille spiralée.') }
  else if (has('relief', ' mur', 'murale', 'plaque', 'panneau', 'dalle', 'corail', 'coral', 'éponge')) { steps.push({ type: 'metaballs', params: { shape: 'disc', count: 24, radius: 0.24, spread: 0.85, seed: 7 } }, { type: 'displace', params: { type: 'ridged', amp: 0.14, freq: 4 } }, { type: 'relief', params: { thick: 0.28 } }); explain.push('Panneau mural en relief — cupules & pores.') }
  else if (has('colonne', 'pilier', 'vertical', 'tour', 'totem', 'gothique', 'gothic', 'épine', 'spine', 'stalagmite')) { steps.push({ type: 'metaballs', params: { shape: 'column', count: 22, radius: 0.26, spread: 0.5, seed: 4 } }, { type: 'stretch', params: { sy: 2, sxz: 0.72 } }); explain.push('Colonne verticale organique.') }
  else if (has('vase', 'vessel', 'creux', 'hollow', 'pot', 'coupe', 'récipient')) { steps.push({ type: 'capsule', params: { h: 0.7, r: 0.55 } }, { type: 'stretch', params: { sy: 1.5, sxz: 0.9 } }, { type: 'shell', params: { t: 0.06 } }); explain.push('Récipient élancé creux.') }
  else if (has('fleur', 'bloom', 'phyllo', 'tournesol', 'inflor')) { steps.push({ type: 'bloom' }); explain.push('Phyllotaxie — éventail radial en spirale dorée.') }
  else if (has('anneau', 'tore', 'torus', 'donut', 'couronne')) { steps.push({ type: 'torus' }); explain.push('Tore.') }
  else if (has('cube', ' box', 'boîte', 'boite')) { steps.push({ type: 'box' }); explain.push('Cube (SDF).') }
  else if (has('sphère', 'sphere', 'boule')) { steps.push({ type: 'sphere', params: { r: 0.95 } }); explain.push('Sphère de base.') }
  else { steps.push({ type: 'metaballs', params: { shape: 'column', count: 16, spread: 0.55, seed: 3 } }, { type: 'stretch', params: { sy: 1.5, sxz: 0.85 } }); explain.push('Masse organique élancée (défaut).') }

  const hasType = (ty: string) => steps.some((s) => s.type === ty)
  // — surface texture / relief —
  if (!hasType('displace')) {
    if (has('nervur', 'crêtes', 'cretes', 'ridge', 'rugueux', 'gravé', 'strié')) { steps.push({ type: 'displace', params: { type: 'ridged', amp: 0.15, freq: 3.5 } }); explain.push('Déplacement « crêtes » — nervures fractales.') }
    else if (has('organique', 'organic', 'bosses', 'noueux', 'irrégul', 'bumpy')) { steps.push({ type: 'displace', params: { type: 'fbm', amp: 0.1, freq: 3 } }); explain.push('Déplacement fBm — surface organique.') }
    else if (has('cellulaire', 'worley', 'peau de')) { steps.push({ type: 'displace', params: { type: 'worley', amp: 0.12, freq: 3 } }); explain.push('Déplacement cellulaire — peau alvéolée.') }
  }
  // — transforms —
  if (!hasType('twist') && has('torsad', 'twist', 'vrill')) { steps.push({ type: 'twist', params: { k: 1.7 } }); explain.push('Torsion.') }
  if (!hasType('taper') && has('effilé', 'effilee', 'taper', 'pointu', 'conique')) { steps.push({ type: 'taper', params: { k: 0.45 } }); explain.push('Effilé — resserrement vers le haut.') }
  const radN = nAfter(/sym[ée]tri\w*\s*(?:radiale\s*)?(\d+)/) ?? nAfter(/(\d+)\s*branch/) ?? (has('symétri', 'symetri', 'radial', 'étoile', 'gothique') ? 6 : null)
  if (radN && !hasType('radial')) { steps.push({ type: 'radial', params: { n: clamp(1, 12, radN) } }); explain.push(`Symétrie radiale ×${clamp(1, 12, radN)}.`) }
  if (has('miroir', 'mirror', 'bilatéral', 'bilateral')) { steps.push({ type: 'mirror' }); explain.push('Miroir bilatéral.') }
  if (!hasType('shell') && !hasType('voronoi') && has('creux', 'hollow', 'coque', 'évidé')) { steps.push({ type: 'shell', params: { t: 0.07 } }); explain.push('Coque — objet creux.') }

  // — mesh —
  const hi = has('détaillé', 'detaille', ' fin', 'haute', 'précis', 'precise', 'hd', 'net')
  steps.push({ type: 'surface', params: { res: hi ? 108 : 82, bound: 1.35 } }); explain.push(`Surface (marching cubes) — ${hi ? 'haute' : 'moyenne'} résolution.`)
  if (!has('anguleux', 'brut', 'faceted', 'low-poly', 'facetté')) { steps.push({ type: 'smooth', params: { iter: has('très lisse', 'tres lisse', 'poli', 'lisse') ? 3 : 1 } }); explain.push('Lissage laplacien.') }

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
  } else if (has('décime', 'decime', 'allège le maillage', 'allege le maillage', 'remesh', 'simplifie')) {
    if (!find('decimate')) { insertBefore(g, 'output', 'decimate', { cells: 40 }); explain.push('Nœud « Décimer/remesh » ajouté — maillage allégé (baisse la finesse pour simplifier plus).') } else { const d = find('decimate')!; d.params.cells = clamp(8, 160, N(d.params.cells, 48) - 8); explain.push('Décimation renforcée.') }
  } else if (has('épaissi', 'epaissi', 'solidifie', 'rend solide')) {
    if (!find('thicken')) { insertBefore(g, 'output', 'thicken', { t: 0.08 }); explain.push('Surface solidifiée (épaissie) — imprimable.') } else { const th = find('thicken')!; th.params.t = clamp(0.02, 0.4, N(th.params.t, 0.08) + 0.02); explain.push('Épaisseur augmentée.') }
  } else if (has('moins détaillé', 'moins detaille', 'plus rapide')) {
    const s = find('surface'); if (s) { s.params.res = clamp(24, 140, N(s.params.res, 80) - 24); explain.push(`Résolution réduite : ${s.params.res}.`) } else if (!find('decimate')) { insertBefore(g, 'output', 'decimate', { cells: 40 }); explain.push('Maillage décimé (plus léger).') }
  } else if (has('plus grand', 'agrandi')) { const s = find('surface'); if (s) { s.params.bound = clamp(0.8, 1.6, N(s.params.bound, 1.2) + 0.1); explain.push('Cadre agrandi.') } }
  else if (has('plus petit', 'réduis la taille')) { const s = find('surface'); if (s) { s.params.bound = clamp(0.8, 1.6, N(s.params.bound, 1.2) - 0.1); explain.push('Cadre réduit.') } }
  else if (has('prépare', 'prepare', 'impression', 'imprimable', 'sls', 'fdm', 'sla', 'étanche', 'etanche', 'fabrication')) {
    const s = find('surface'); if (s) s.params.res = clamp(80, 140, Math.max(96, N(s.params.res, 80)))
    const sm = find('smooth') ?? insertBefore(g, 'output', 'smooth', { iter: 1 }); if (sm) sm.params.iter = clamp(1, 8, N(sm.params.iter, 1))
    const PARAM = ['klein', 'kleinsurf', 'mobius', 'plucker', 'geodesic']
    if (g.nodes.some((n) => PARAM.includes(n.type)) && !find('thicken')) insertBefore(g, 'output', 'thicken', { t: 0.08 })   // solidify open parametric surfaces
    else if (!find('shell') && !find('voronoi')) insertBefore(g, 'surface', 'shell', { t: 0.08 })
    explain.push('Préparé pour l’impression : maillage plus dense, lissé, surfaces solidifiées. Vérifie « Étanche : oui » dans l’analyse.')
  } else if (has('conserve la silhouette', 'garde la silhouette', 'modifie les cellules', 'change les cellules')) {
    const v = find('voronoi'); if (v) { v.params.scale = clamp(1.5, 9, N(v.params.scale, 4) + (Math.random() > 0.5 ? 1 : -1)) } const d = find('displace'); if (d) d.params.freq = clamp(0.5, 8, N(d.params.freq, 3) + 1); const mb = find('metaballs'); if (mb) mb.params.seed = Math.floor(Math.random() * 9999) + 1; explain.push('Silhouette conservée, motif interne modifié.')
  } else if (has('translucide', 'transparent', 'verre')) { material = 'translucent'; explain.push('Matériau translucide.') }
  else if (has('chrome', 'métal', 'metal')) { material = 'chrome'; explain.push('Matériau chrome.') }
  else if (has('noir')) { material = 'gloss'; explain.push('Matériau noir brillant.') }
  else if (has('argile', 'clay', 'céramique')) { material = 'clay'; explain.push('Matériau argile.') }
  else explain.push('Commande non reconnue. Essaie : « plus organique », « augmente la porosité », « rends symétrique », « allège de 30 % », « prépare pour l’impression ».')

  return { graph: g, explain, material }
}

// ── Real LLM path (uses the admin-configured Anthropic key via /api/morpho-assistant) ──
const LINEAR_TYPES = ['sphere', 'box', 'torus', 'capsule', 'gyroid', 'schwarz', 'mandelbulb', 'voronoi', 'metaballs', 'bloom', 'dla', 'reaction', 'helix', 'displace', 'shell', 'twist', 'taper', 'stretch', 'radial', 'mirror', 'relief', 'surface', 'smooth', 'decimate', 'thicken']
function buildSystemPrompt(): string {
  const spec = LINEAR_TYPES.map((ty) => { const d = NODE_DEFS[ty]; const ps = d.params.map((p) => p.type === 'select' ? `${p.key}∈{${p.options!.map((o) => o.v).join('|')}}` : p.type === 'seed' ? `${p.key}(entier)` : `${p.key}(${p.min}…${p.max})`).join(', '); return `- ${ty} [${d.cat}]${ps ? ' : ' + ps : ''}` }).join('\n')
  return `Tu es le moteur de MORPHOGENESIS STUDIO, un atelier 3D génératif nodal. Tu convertis une description en une CHAÎNE de nœuds (pipeline linéaire) qui produit une forme organique/fractale/cellulaire via un champ scalaire → marching cubes.

RÈGLES :
- Réponds UNIQUEMENT par un objet JSON, rien d'autre.
- Format : {"pipeline":[{"type":"...","params":{...}}, ...], "material":"clay|matte|chrome|gloss|translucent", "explain":["phrase courte par nœud"]}
- La pipeline commence par UN nœud source (champ), enchaîne des transformations/déplacements, et se termine par "surface" puis (optionnel) "smooth".
- Chaque nœud passe son champ au suivant. N'utilise PAS de nœud "boolean" ni "output".
- Varie les silhouettes : colonne (metaballs shape=column + stretch sy>1.4), relief mural (metaballs shape=disc + relief), spirale/coquille (helix + twist), vase (capsule + stretch + shell), etc. Évite de tout faire sphérique.
- Respecte les bornes des paramètres. Pour "surface", res 80–110 et bound 1.2–1.4.

TYPES DE NŒUDS DISPONIBLES :
${spec}

Exemple — "colonne gothique à nervures noire" →
{"pipeline":[{"type":"metaballs","params":{"shape":"column","count":22,"radius":0.26,"spread":0.5}},{"type":"stretch","params":{"sy":2,"sxz":0.72}},{"type":"displace","params":{"type":"ridged","amp":0.13,"freq":4}},{"type":"radial","params":{"n":6}},{"type":"surface","params":{"res":92,"bound":1.35}},{"type":"smooth","params":{"iter":1}}],"material":"gloss","explain":["Metaballs en colonne","Étirement vertical","Nervures ridged","Symétrie ×6","Maillage","Lissage"]}`
}
function sanitizeParams(type: string, raw: Record<string, unknown> | undefined): Record<string, number | string> {
  const def = NODE_DEFS[type]; const out: Record<string, number | string> = {}
  for (const p of def.params) {
    const v = raw?.[p.key]
    if (p.type === 'select') out[p.key] = (typeof v === 'string' && p.options!.some((o) => o.v === v)) ? v : (p.def as string)
    else if (p.type === 'seed') out[p.key] = typeof v === 'number' ? Math.round(v) : (p.def as number)
    else { const n = typeof v === 'number' ? v : Number(v); out[p.key] = Number.isFinite(n) ? clamp(p.min ?? -1e9, p.max ?? 1e9, n) : (p.def as number) }
  }
  return out
}
function extractJson(text: string): any { try { return JSON.parse(text) } catch { const m = text.match(/\{[\s\S]*\}/); if (m) { try { return JSON.parse(m[0]) } catch { /* */ } } } return null }
const VALID_MATS: MatKind[] = ['clay', 'matte', 'chrome', 'gloss', 'translucent']

export async function llmToGraph(prompt: string): Promise<Built> {
  const res = await fetch('/api/morpho-assistant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ system: buildSystemPrompt(), prompt }) })
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error ?? `HTTP ${res.status}`) }
  const { text } = await res.json()
  const obj = extractJson(text); if (!obj) throw new Error('Réponse IA illisible')
  const rawPipe: any[] = Array.isArray(obj.pipeline) ? obj.pipeline : []
  const steps: Step[] = rawPipe.filter((s) => s && typeof s.type === 'string' && NODE_DEFS[s.type] && LINEAR_TYPES.includes(s.type) && s.type !== 'surface' && s.type !== 'smooth').map((s) => ({ type: s.type, params: sanitizeParams(s.type, s.params) }))
  if (!steps.length) throw new Error('Pipeline vide')
  const surf = rawPipe.find((s) => s?.type === 'surface'); steps.push({ type: 'surface', params: sanitizeParams('surface', surf?.params ?? { res: 84, bound: 1.35 }) })
  const sm = rawPipe.find((s) => s?.type === 'smooth'); if (sm || rawPipe.length <= 3) steps.push({ type: 'smooth', params: sanitizeParams('smooth', sm?.params ?? { iter: 1 }) })
  const material = VALID_MATS.includes(obj.material) ? (obj.material as MatKind) : undefined
  const explain = Array.isArray(obj.explain) ? obj.explain.map(String).slice(0, 8) : ['Graphe généré par l’IA.']
  return { graph: chainGraph(steps), explain, material }
}

export const QUICK_COMMANDS = ['Plus organique', 'Réduis les pointes', 'Augmente la porosité', 'Rends symétrique', 'Allège de 30%', 'Plus lisse', 'Décime le maillage', 'Épaissis', 'Prépare pour l’impression']
export const EXAMPLE_PROMPTS = [
  'Coquille spiralée translucide à nervures fractales',
  'Colonne gothique symétrique en tubes organiques noirs',
  'Panneau mural relief corallien poreux',
  'Vase élancé creux cellulaire en céramique',
  'Treillis d’os imprimable allongé',
  'Réseau Voronoï radial translucide',
]
