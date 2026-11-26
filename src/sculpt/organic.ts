/**
 * ORGANIC-PARAMETRIC generator for the SCULPTURE studio.
 *
 * The forms this targets (perforated bio-shells, loop lattices, twisted ribbons) are
 * high-genus CONTINUOUS surfaces — they can't be made by replicating instances, so this
 * composes a signed-distance field and polygonises it with marching cubes:
 *
 *   body (revolve / ovoid / torus / ribbon)
 *     → shell   (hollow it : |d| - t, so the interior becomes visible through the holes)
 *     → subtract a perforation field with a SMOOTH boolean (the blend `k` is what turns
 *       sharp cuts into thick rounded organic struts — the whole "grown, not cut" look)
 *     → bilateral mirror, then twist / taper / bend / organic noise as domain warps
 *
 * Everything is a pure function of `OrganicParams`, so it is testable headless and can be
 * evaluated inside a worker (see organic.worker.ts) — HD meshing never blocks the UI.
 */
import * as THREE from 'three'
import { marchingCubes, type Field } from '../morpho/marching'
import {
  sdSphere, sdTorus, sdBox, metaballs, gyroid, voronoiWalls,
  fSubtract, fShell, fDisplace, opTwist, opTaper, opBend, opStretch, opMirrorX,
  type NoiseType,
} from '../morpho/fields'
import { flowerParts } from './flower'
import { latticeRelief, isScattered, reliefCount, sampleSurface, plantElements, type OrgRelief } from './ornament'
export { ORG_RELIEFS, reliefCount, isScattered, type OrgRelief } from './ornament'

export const ORG_BOUND = 1.15

export type OrgForm = 'ovoide' | 'colonne' | 'lyre' | 'tore' | 'ruban' | 'mesh' | 'goutte' | 'gourde' | 'dome' | 'dalle' | 'fleur'
export type OrgPore = 'aucun' | 'pores' | 'boucles' | 'lattice' | 'cellules' | 'grille' | 'alveoles' | 'resille'

export const ORG_FORMS: { kind: OrgForm; label: string }[] = [
  { kind: 'mesh', label: '📥 Ma forme (sculptée / importée)' },
  { kind: 'fleur', label: '🌺 Fleur mécanique (rubans, étamines, roue)' },
  { kind: 'lyre', label: '🏺 Lyre (bulbe · taille · bulbe)' },
  { kind: 'ovoide', label: '🥚 Ovoïde' },
  { kind: 'goutte', label: '💧 Goutte (ronde en bas, pointue en haut)' },
  { kind: 'gourde', label: '🍐 Gourde (panse et col)' },
  { kind: 'dome', label: '🍄 Dôme (posé à plat)' },
  { kind: 'dalle', label: '🪵 Dalle (panneau à sculpter)' },
  { kind: 'colonne', label: '🗼 Colonne' },
  { kind: 'tore', label: '⭕ Tore' },
  { kind: 'ruban', label: '🎗 Ruban (plat, à torsader)' },
]
export const ORG_PORES: { kind: OrgPore; label: string }[] = [
  { kind: 'alveoles', label: '🐝 Alvéoles de surface (nid d\'abeille ↔ veines)' },
  { kind: 'resille', label: '💠 Résille en losanges (hélices croisées)' },
  { kind: 'grille', label: '🔷 Grille paramétrique (design)' },
  { kind: 'boucles', label: '🔗 Boucles (fentes allongées)' },
  { kind: 'pores', label: '🕳 Pores (perforations rondes)' },
  { kind: 'lattice', label: '🧬 Lattice gyroïde' },
  { kind: 'cellules', label: '🫧 Cellules (Voronoï)' },
  { kind: 'aucun', label: '— Aucune (surface pleine)' },
]

export interface OrganicParams {
  form: OrgForm
  pore: OrgPore
  poreRows: number      // anneaux de perforations le long de la hauteur
  poreCount: number     // perforations par anneau = symétrie radiale
  poreSize: number      // rayon des perforations
  poreRadius: number    // distance des perforations à l'axe
  blend: number         // douceur du booléen → épaisseur/rondeur des entretoises
  latticeFreq: number   // fréquence du gyroïde / échelle des cellules
  shell: number         // 0 = plein ; > 0 = coque creuse d'épaisseur 2·shell
  mirror: boolean       // symétrie bilatérale
  twist: number
  taper: number
  bend: number
  noiseAmp: number
  noiseFreq: number
  noiseType: NoiseType
  res: number           // résolution marching cubes
  poreJitter: number    // alvéoles : 0 = nid d'abeille régulier, 1 = cellules organiques
  relief: OrgRelief     // ce qui est AJOUTÉ au corps (voir ornament.ts)
  reliefDensity: number // 0..1 → nombre de côtes / colonnes / éléments (reliefCount)
  reliefHeight: number  // hauteur du relief
  reliefSize: number    // 0..1 → largeur des éléments par rapport à leur espacement
  open: number          // 0 = fermé ; 0.5 = coupé à mi-hauteur (vase, coupe, abat-jour)
  seed: number          // tirage des éléments semés et du désordre des alvéoles
  petals: number        // fleur : nombre de pétales en ruban
  curl: number          // fleur : 0 = pétales ouverts à plat, 1 = rubans refermés en boucle
  stamens: number       // fleur : nombre d'étamines
}

export const ORG_DEFAULTS: OrganicParams = {
  form: 'lyre', pore: 'boucles', poreRows: 4, poreCount: 6, poreSize: 0.15, poreRadius: 0.42,
  blend: 0.09, latticeFreq: 7, shell: 0.055, mirror: true,
  twist: 0, taper: 0, bend: 0, noiseAmp: 0, noiseFreq: 2.2, noiseType: 'fbm', res: 72,
  poreJitter: 0.5, relief: 'aucun', reliefDensity: 0.4, reliefHeight: 0.08, reliefSize: 0.8, open: 0, seed: 1,
  petals: 9, curl: 0.85, stamens: 16,
}

const clamp = (a: number, b: number, v: number) => Math.max(a, Math.min(b, v))

/** Surface of revolution from a radius profile r(t), t in [0,1] over y in [-half, half]. */
function revolve(prof: (t: number) => number, half: number): Field {
  return (x, y, z) => {
    const t = clamp(0, 1, (y + half) / (2 * half))
    const dr = Math.hypot(x, z) - prof(t), dy = Math.abs(y) - half
    const ox = Math.max(dr, 0), oy = Math.max(dy, 0)
    return Math.min(Math.max(dr, dy), 0) + Math.hypot(ox, oy)
  }
}

/** The base body silhouette. */
export function formField(form: OrgForm): Field {
  switch (form) {
    // bulbe · taille · bulbe — la silhouette « vase biologique »
    case 'lyre': return revolve((t) => 0.16 + 0.22 * Math.sin(Math.PI * t) + 0.12 * Math.sin(Math.PI * 3 * t), 0.86)
    case 'colonne': return opStretch(sdSphere(0.5), 0.62, 1.7, 0.62)
    case 'tore': return sdTorus(0.56, 0.28)
    case 'ruban': return opStretch(sdSphere(0.6), 1.05, 1.32, 0.34)
    case 'goutte': return revolve((t) => 0.725 * Math.pow(Math.sin(Math.PI * t), 0.75) * Math.pow(1 - t, 0.4), 0.9)
    case 'gourde': return revolve((t) => 0.1 + 0.45 * Math.exp(-(((t - 0.3) / 0.22) ** 2)) + 0.07 * Math.exp(-(((t - 0.92) / 0.1) ** 2)), 0.9)
    case 'dome': { const s = sdSphere(0.85); return (x, y, z) => Math.max(s(x, y + 0.45, z), -(y + 0.45)) }
    case 'dalle': { const b = sdBox(0.59, 0.87, 0.06); return (x, y, z) => b(x, y, z) - 0.03 }
    case 'fleur': return flowerParts({ petals: 9, curl: 0.85, stamens: 16, res: 96, bound: ORG_BOUND }).field
    default: return opStretch(sdSphere(0.62), 0.88, 1.2, 0.88)
  }
}

/** Highest and lowest point of each body — what the « open » cut is measured between. */
const FORM_TOP: Record<OrgForm, number> = { lyre: 0.86, colonne: 0.85, ovoide: 0.744, tore: 0.28, ruban: 0.79, goutte: 0.9, gourde: 0.9, dome: 0.4, dalle: 0.9, mesh: 0.9, fleur: 0.9 }
const FORM_BASE: Record<OrgForm, number> = { lyre: -0.86, colonne: -0.85, ovoide: -0.744, tore: -0.28, ruban: -0.79, goutte: -0.9, gourde: -0.9, dome: -0.45, dalle: -0.9, mesh: -0.9, fleur: -0.9 }

/** Thickness of what is left between two surface openings, from the « taille des ouvertures »
 *  slider — bounded by the cell so that openings AND ligaments both always exist. */
function ligament(poreSize: number, cellMin: number, res: number): number {
  // Une cloison plus fine qu'une maille et demie ne se polygonise pas : elle se rompt en
  // miettes (mesuré : 238 fragments à la résolution 72). Le plancher suit la résolution.
  const floor = 0.8 * ((2 * ORG_BOUND) / Math.max(24, res))
  return Math.min(Math.max(floor, 0.012 + Math.max(0, 0.32 - poreSize) * 0.08), cellMin * 0.3)
}
/** a − b, but `b` is only evaluated near a's surface : further out than the blend plus a
 *  couple of cells, subtracting cannot move the zero set, and the perforation fields are
 *  the expensive part (measured : alvéoles 2.9 s → at resolution 96 before this). Solid
 *  bodies carved through and through (shell 0) are not skipped on the inside. */
function carve(a: Field, b: Field, k: number): Field {
  const far = k + 0.07
  return (x, y, z) => {
    const A = a(x, y, z)
    if (A > far) return A
    const B = -b(x, y, z)
    if (k <= 1e-5) return Math.max(A, B)
    const h = clamp(0, 1, 0.5 + 0.5 * (B - A) / k)
    return A + (B - A) * h + k * h * (1 - h)
  }
}
function hash2(i: number, j: number, s: number): number { let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(s, 1274126177)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296 }

/**
 * ALVÉOLES — a Voronoï diagram drawn in SURFACE coordinates (angle × height), seeded on a
 * quincunx lattice. jitter 0 gives a regular honeycomb, jitter 1 an organic cell network
 * (veins, foam). Like the grid it does not depend on the distance to the axis, so every
 * cell is punched straight through the wall : clean rims, no grazing cuts, no debris.
 */
export function surfaceCells(cols: number, rows: number, poreSize: number, jitter: number, seed: number, res = 96): Field {
  const C = Math.max(3, Math.round(cols)), R = Math.max(1, Math.round(rows))
  const TAU = Math.PI * 2, rowH = 1.75 / R, J = clamp(0, 1, jitter) * 0.85
  const wall = ligament(poreSize, Math.min((TAU * 0.4) / C, rowH), res)
  return (x, y, z) => {
    const rad = Math.max(Math.hypot(x, z), 1e-3), u = Math.atan2(z, x)
    const jc = Math.round(y / rowH)
    let f1 = 1e9, f2 = 1e9
    for (let j = jc - 2; j <= jc + 2; j++) {
      const off = (((j % 2) + 2) % 2) * 0.5
      const ic = Math.round((u / TAU) * C - off)
      for (let i = ic - 1; i <= ic + 1; i++) {
        const iw = ((i % C) + C) % C
        const su = ((i + off + (hash2(iw, j, seed) - 0.5) * J) / C) * TAU
        const sv = (j + (hash2(iw, j, seed + 7) - 0.5) * J) * rowH
        let du = u - su; du -= TAU * Math.round(du / TAU)
        const d = Math.hypot(du * rad, y - sv)
        if (d < f1) { f2 = f1; f1 = d } else if (d < f2) f2 = d
      }
    }
    return wall - (f2 - f1) * 0.5        // négatif dans la cellule, positif sur la cloison
  }
}

/**
 * RÉSILLE — two families of helices crossing each other leave diamond openings : the
 * turned-lattice look of 3D-printed lamps. Distances are divided by the local gradient so
 * the struts keep one width from the belly to the neck.
 */
export function helixNet(cols: number, rows: number, poreSize: number, res = 96): Field {
  const C = Math.max(3, Math.round(cols)), R = Math.max(1, Math.round(rows))
  const rowH = 1.75 / R, ky = Math.PI / (2 * rowH)
  const strut = ligament(poreSize, Math.min((Math.PI * 2 * 0.4) / C, rowH), res)
  const tri = (ph: number) => { const t = ph / Math.PI; return Math.abs(t - Math.round(t)) * Math.PI }
  return (x, y, z) => {
    const rad = Math.max(Math.hypot(x, z), 0.02), a = (C / 2) * Math.atan2(z, x)
    const g = Math.hypot(C / (2 * rad), ky)
    // Là où le corps est trop étroit pour loger une maille (col d'une gourde), les
    // losanges se réduiraient à des fentes qui se rejoignent : on referme la paroi.
    const tight = Math.max(0, 2.6 * strut - (Math.PI * rad) / C)
    return strut + tight - Math.min(tri(a + ky * y), tri(a - ky * y)) / g
  }
}

/**
 * GRILLE — the clean "parametric design" perforation: holes on a regular quincunx lattice
 * laid out in SURFACE coordinates (angle × height) rather than in space, so they follow the
 * body evenly instead of clustering. Their radius follows a smooth gradient over the height,
 * which is what reads as designed rather than randomly drilled.
 *
 * The field is independent of the distance to the axis, so subtracting it punches each hole
 * straight through the wall — no grazing cuts, which is also why this style produces far
 * less debris than the voronoï/gyroid ones.
 */
export function gridPores(cols: number, rows: number, radius: number, gradient: number): Field {
  const C = Math.max(2, Math.round(cols)), R = Math.max(1, Math.round(rows))
  const H = 1.75, rowH = H / R          // hauteur couverte / pas vertical
  const TAU = Math.PI * 2
  // Un trou plus large que son pas fusionne avec ses voisins et DÉCOUPE la coque en
  // fragments (mesuré : 214 composants). On borne donc le rayon à une fraction du pas :
  // les ligaments survivent par construction, quels que soient les curseurs.
  const arcStep = (TAU * 0.4) / C       // pas angulaire, à un rayon de référence
  const rMax = Math.min(radius, 0.45 * Math.min(arcStep, rowH))
  return (x, y, z) => {
    const rad = Math.hypot(x, z)
    const u = Math.atan2(z, x)
    const j = Math.round(y / rowH)
    const off = (((j % 2) + 2) % 2) * 0.5          // quinconce : une ligne sur deux décalée
    const colF = (u / TAU) * C - off
    let best = 1e9
    // Les deux colonnes voisines suffisent (la maille est convexe).
    for (let dj = -1; dj <= 1; dj++) {
      const jj = j + dj
      const o = (((jj % 2) + 2) % 2) * 0.5
      const cf = (u / TAU) * C - o
      for (let di = -1; di <= 1; di++) {
        const i = Math.round(cf) + di
        const uc = ((i + o) / C) * TAU
        let du = u - uc
        du = du - TAU * Math.round(du / TAU)        // repli angulaire
        const arc = du * Math.max(rad, 1e-3)        // en longueur d'arc → trous ronds
        const dv = y - jj * rowH
        const d = Math.hypot(arc, dv)
        if (d < best) best = d
      }
    }
    void colF
    // Dégradé : petits près des extrémités, pleins au centre — la signature du style.
    const t = clamp(0, 1, y / H + 0.5)
    const g = 1 - gradient + gradient * Math.sin(Math.PI * t)
    return best - Math.max(0.004, rMax * g)
  }
}

/** The field that gets SUBTRACTED from the body to open it up. `null` = no perforation. */
export function poreField(p: OrganicParams): Field | null {
  if (p.pore === 'aucun') return null
  if (p.pore === 'grille') return gridPores(p.poreCount * 2, p.poreRows * 2, p.poreSize, 0.6)
  if (p.pore === 'alveoles') return surfaceCells(p.poreCount * 2, p.poreRows * 2, p.poreSize, p.poreJitter, p.seed, p.res)
  if (p.pore === 'resille') return helixNet(p.poreCount * 2, p.poreRows * 2, p.poreSize, p.res)
  if (p.pore === 'lattice') return gyroid(p.latticeFreq, 0.62, ORG_BOUND * 1.4)
  if (p.pore === 'cellules') return voronoiWalls(Math.max(1.2, p.latticeFreq * 0.5), 0.05, ORG_BOUND * 1.4)
  // Discrete holes on rings around the axis. Smooth-unioned by metaballs(), so neighbours
  // merge into continuous slots instead of reading as drilled dots.
  const rows = Math.max(1, Math.round(p.poreRows)), per = Math.max(1, Math.round(p.poreCount))
  const pts: [number, number, number][] = []
  for (let r = 0; r < rows; r++) {
    const t = rows === 1 ? 0.5 : r / (rows - 1)
    const y = (t - 0.5) * 1.5
    const off = (r % 2) * (Math.PI / per)   // quinconce → maillage organique, pas une grille
    for (let k = 0; k < per; k++) {
      const a = (k / per) * Math.PI * 2 + off
      pts.push([Math.cos(a) * p.poreRadius, y, Math.sin(a) * p.poreRadius])
    }
  }
  const balls = metaballs(pts, Math.max(0.02, p.poreSize))
  // « Boucles » = mêmes trous étirés verticalement → il ne reste que de fines entretoises
  // courbes entre eux, ce qui lit comme des anses/boucles.
  return p.pore === 'boucles' ? opStretch(balls, 1, 2.1, 1) : balls
}

/**
 * Compose the full field — and, alongside it, the HEIGHT field used to colour the result.
 *
 *   body → lattice relief → shell → perforate → plant elements → open the top
 *        → mirror → twist / taper / bend → noise
 *
 * `bodyField` overrides the primitive body — that is how a SCULPTED or IMPORTED mesh (baked
 * to an SDF by meshToField) goes through the exact same treatment.
 *
 * `height(x,y,z)` is the signed distance to the BARE body's outer surface, read through the
 * same warps as the field : positive on anything added (relief, elements), about zero on
 * the body's skin, negative inside the wall and in the hollows. The glaze colours come
 * from it (see shade.ts) — which is why it ignores the ornament on purpose.
 */
export function organicParts(p: OrganicParams, bodyField?: Field | null): { field: Field; height: Field } {
  // La fleur est faite de pièces : elle fournit aussi de quoi les colorer une par une.
  const flower = p.form === 'fleur' ? flowerParts({ petals: p.petals, curl: p.curl, stamens: p.stamens, res: p.res, bound: ORG_BOUND }) : null
  const body = flower ? flower.field : p.form === 'mesh' ? (bodyField ?? formField('ovoide')) : formField(p.form)
  const shell = p.shell > 0.001 ? p.shell : 0
  const top = FORM_TOP[p.form] ?? 0.9, base = FORM_BASE[p.form] ?? -0.9
  const cutY = top - clamp(0, 0.9, p.open) * (top - base)
  const relief = latticeRelief(p)
  // Côtes et écailles convergent aux pôles et y font des aiguilles : elles s'effacent près
  // du pied, et du sommet quand il n'est pas coupé.
  const polar = p.relief === 'cannelures' || p.relief === 'ecailles'
  const fade = (y: number) => { const a = clamp(0, 1, (y - base - 0.02) / 0.16), b = p.open > 0.01 ? 1 : clamp(0, 1, (top - 0.02 - y) / 0.16); return a * a * (3 - 2 * a) * b * b * (3 - 2 * b) }
  const outer: Field = relief ? (polar ? (x, y, z) => body(x, y, z) - relief(x, y, z) * fade(y) : (x, y, z) => body(x, y, z) - relief(x, y, z)) : body
  let f = shell ? fShell(outer, shell) : outer
  const holes = poreField(p)
  if (holes) f = carve(f, holes, Math.max(0, p.blend))
  if (isScattered(p.relief) && p.reliefHeight > 1e-4) {
    // Les éléments se posent sur la peau extérieure (corps + épaisseur de coque).
    const skin: Field = (x, y, z) => outer(x, y, z) - shell
    const { anchors, spacing } = sampleSurface(skin, p.mirror ? Math.ceil(reliefCount(p) / 2) : reliefCount(p), p.seed, {
      xPositive: p.mirror,
      accept: ([, y], n) => (p.open > 0.01 ? y < cutY - 0.03 : true)
        && (p.form === 'goutte' ? y < 0.68 : true)        // rien sur la pointe de la goutte
        && (p.form === 'dome' ? n[1] > -0.3 : true)       // pas sous la base du dôme
        && (p.form === 'dalle' ? n[2] > 0.5 : true),      // seulement la face avant du panneau
    })
    const plant = plantElements(p, anchors, spacing)
    if (plant) f = plant(f)
  }
  if (p.open > 0.01) f = fSubtract(f, (_x, y) => cutY - y, 0.012)
  if (p.mirror) f = opMirrorX(f)
  if (Math.abs(p.twist) > 0.001) f = opTwist(f, p.twist)
  if (Math.abs(p.taper) > 0.001) f = opTaper(f, p.taper)
  if (Math.abs(p.bend) > 0.001) f = opBend(f, p.bend)
  if (p.noiseAmp > 0.001) f = fDisplace(f, p.noiseType, p.noiseAmp, p.noiseFreq)

  // Même chaîne de déformations que ci-dessus, dans l'ordre où le champ les traverse.
  const height: Field = (x, y, z) => {
    if (Math.abs(p.bend) > 0.001) { const c = Math.cos(p.bend * x), s = Math.sin(p.bend * x); const y2 = c * y - s * z; z = s * y + c * z; y = y2 }
    if (Math.abs(p.taper) > 0.001) { const s = clamp(0.05, 3, 1 - p.taper * (y * 0.5)); x /= s; z /= s }
    if (Math.abs(p.twist) > 0.001) { const c = Math.cos(p.twist * y), s = Math.sin(p.twist * y); const x2 = c * x - s * z; z = s * x + c * z; x = x2 }
    if (p.mirror) x = Math.abs(x)
    return flower ? flower.part(x, y, z) : body(x, y, z) - shell
  }
  return { field: f, height }
}
export function organicField(p: OrganicParams, bodyField?: Field | null): Field { return organicParts(p, bodyField).field }

/** Field → real, exportable geometry. `onProgress(0→1)` reports meshing progress. */
export function buildOrganic(p: OrganicParams, onProgress?: (t: number) => void, bodyField?: Field | null): THREE.BufferGeometry {
  return marchingCubes(organicField(p, bodyField), clamp(24, 160, Math.round(p.res)), ORG_BOUND, 0, onProgress)
}

/** Material + glaze colours + inner light that go with a preset (see organicAI OrgLook). */
export interface PresetLook { material: string; colorA: string; colorB: string; colorC: string; lamp?: boolean }
const BARE = { relief: 'aucun', open: 0, noiseAmp: 0, twist: 0, taper: 0, bend: 0 } as const
const SOLID = { pore: 'aucun', shell: 0, mirror: false, open: 0, noiseAmp: 0, twist: 0, taper: 0, bend: 0 } as const

/** Ready-made looks matching the reference imagery. Each one sets EVERY field that matters
 *  to it (through BARE / SOLID), so a preset never inherits leftovers from the previous form. */
export const ORG_PRESETS: { name: string; desc: string; params: Partial<OrganicParams>; look: PresetLook }[] = [
  { name: '🪸 Récif émaillé', desc: 'Goutte couverte de rosettes cannelées — céramique à trois émaux.', params: { ...SOLID, form: 'goutte', relief: 'rosettes', reliefDensity: 0.4, reliefHeight: 0.05, reliefSize: 1, blend: 0.03, noiseAmp: 0.004, noiseFreq: 8, noiseType: 'worley', res: 128 }, look: { material: 'email', colorA: '#2f9c96', colorB: '#f08a3c', colorC: '#17555c' } },
  { name: '🌺 Fleur mécanique', desc: 'Pétales en rubans torsadés qui se referment en boucle, étamines à boules, roue dentée au cœur.', params: { ...SOLID, form: 'fleur', relief: 'aucun', petals: 9, curl: 0.85, stamens: 16, res: 120 }, look: { material: 'matte', colorA: '#d21f3c', colorB: '#c4c8cf', colorC: '#d88cc4' } },
  { name: '🦔 Oursin', desc: 'Corps plein hérissé d\'épines à bout rond.', params: { ...SOLID, form: 'goutte', relief: 'epines', reliefDensity: 0.52, reliefHeight: 0.2, reliefSize: 0.62, blend: 0.08, res: 124 }, look: { material: 'email', colorA: '#e9643a', colorB: '#f4e7c3', colorC: '#8f2f1a' } },
  { name: '🫧 Balanes', desc: 'Dôme creux couvert de tubes ouverts qui traversent la paroi.', params: { ...SOLID, form: 'dome', shell: 0.04, relief: 'polypes', reliefDensity: 0.42, reliefHeight: 0.13, reliefSize: 1, blend: 0.05, res: 124 }, look: { material: 'porcelaine', colorA: '#efe9df', colorB: '#fbf8f2', colorC: '#b3a592' } },
  { name: '🍃 Vase à pétales', desc: 'Écailles imbriquées entraînées par la torsion, haut ouvert.', params: { ...SOLID, form: 'colonne', shell: 0.035, open: 0.1, relief: 'ecailles', reliefDensity: 0.3, reliefHeight: 0.075, reliefSize: 1, twist: 0.9, res: 128 }, look: { material: 'matte', colorA: '#2c3f6e', colorB: '#3d5594', colorC: '#161f3a' } },
  { name: '🐝 Lampe alvéoles', desc: 'Nid d\'abeille percé droit dans une coque fine, éclairé de l\'intérieur.', params: { ...BARE, form: 'ovoide', pore: 'alveoles', poreCount: 9, poreRows: 6, poreSize: 0.24, poreJitter: 0.12, blend: 0.012, shell: 0.03, mirror: false, res: 120 }, look: { material: 'porcelaine', colorA: '#efe9df', colorB: '#fbf8f2', colorC: '#e9d9bd', lamp: true } },
  { name: '💠 Lampe résille', desc: 'Deux familles d\'hélices croisées : des losanges du pied au col.', params: { ...BARE, form: 'gourde', pore: 'resille', poreCount: 9, poreRows: 7, poreSize: 0.22, blend: 0.008, shell: 0.03, mirror: false, res: 124 }, look: { material: 'porcelaine', colorA: '#efe9df', colorB: '#fbf8f2', colorC: '#e9d9bd', lamp: true } },
  { name: '🐚 Gourde cannelée', desc: 'Côtes fines en spirale sur une paroi mince.', params: { ...SOLID, form: 'gourde', shell: 0.03, open: 0.05, relief: 'cannelures', reliefDensity: 0.3, reliefHeight: 0.05, reliefSize: 0.55, twist: 1.3, res: 128 }, look: { material: 'porcelaine', colorA: '#efe9df', colorB: '#fbf8f2', colorC: '#b3a592' } },
  { name: '🧠 Corail cerveau', desc: 'Méandres en relief sur une goutte pleine.', params: { ...SOLID, form: 'goutte', relief: 'meandres', reliefDensity: 0.45, reliefHeight: 0.035, reliefSize: 0.45, res: 132 }, look: { material: 'email', colorA: '#e9643a', colorB: '#7fd0c0', colorC: '#8f2f1a' } },
  { name: '🪵 Panneau érodé', desc: 'Dalle pleine creusée de cellules aux bords fondus, comme du bois flotté.', params: { ...BARE, form: 'dalle', pore: 'cellules', latticeFreq: 6, blend: 0.12, shell: 0, mirror: false, res: 124 }, look: { material: 'matte', colorA: '#e9dcc9', colorB: '#f5ecdf', colorC: '#a8916f' } },
  { name: '🪻 Dentelle de veines', desc: 'Réseau de cellules irrégulières percé dans une coque — la corbeille lilas.', params: { ...BARE, form: 'ovoide', pore: 'alveoles', poreCount: 10, poreRows: 8, poreSize: 0.3, poreJitter: 1, blend: 0.02, shell: 0.028, mirror: false, res: 132 }, look: { material: 'matte', colorA: '#c9a8d8', colorB: '#e6d3ee', colorC: '#7d5c93' } },
  { name: '🔷 Vase ajouré (design)', desc: 'Grille régulière à dégradé sur une coque torsadée — le style « design paramétrique ».', params: { ...BARE, form: 'lyre', pore: 'grille', poreCount: 11, poreRows: 7, poreSize: 0.05, blend: 0.012, shell: 0.03, mirror: false, twist: 0.9, taper: 0.1, res: 120 }, look: { material: 'porcelaine', colorA: '#efe9df', colorB: '#fbf8f2', colorC: '#b3a592' } },
  { name: '🫀 Bio-lattice', desc: 'Coque perforée à entretoises épaisses — la référence turquoise.', params: { ...BARE, form: 'lyre', pore: 'boucles', poreRows: 4, poreCount: 6, poreSize: 0.15, poreRadius: 0.42, blend: 0.09, shell: 0.055, mirror: true, res: 96 }, look: { material: 'bio', colorA: '#9fd8d0', colorB: '#c9efe9', colorC: '#3f8f8a' } },
  { name: '🌸 Rosace radiale', desc: 'Symétrie radiale dense, lecture frontale en rosace.', params: { ...BARE, form: 'ovoide', pore: 'boucles', poreRows: 3, poreCount: 8, poreSize: 0.17, poreRadius: 0.46, blend: 0.11, shell: 0.05, mirror: true, twist: 0.3, res: 96 }, look: { material: 'email', colorA: '#a9c9b4', colorB: '#dcebdc', colorC: '#4f7f6c' } },
  { name: '🎗 Ruban chromé', desc: 'Surface pleine torsadée, sans perforation — pour un rendu métal.', params: { ...SOLID, form: 'ruban', relief: 'aucun', twist: 2.4, taper: 0.2, res: 96 }, look: { material: 'chrome', colorA: '#d9dde2', colorB: '#d9dde2', colorC: '#8a9098' } },
  { name: '🧬 Os gyroïde', desc: 'Porosité continue type trabéculaire, imprimable.', params: { ...BARE, form: 'colonne', pore: 'lattice', latticeFreq: 8, blend: 0.04, shell: 0, mirror: false, twist: 0.6, res: 96 }, look: { material: 'matte', colorA: '#efe9df', colorB: '#fbf8f2', colorC: '#b3a592' } },
  { name: '🪨 Corail cellulaire', desc: 'Parois de Voronoï + bruit organique.', params: { ...BARE, form: 'ovoide', pore: 'cellules', latticeFreq: 7, blend: 0.05, shell: 0, mirror: false, noiseAmp: 0.035, noiseFreq: 3, res: 96 }, look: { material: 'clay', colorA: '#c8794a', colorB: '#e2a476', colorC: '#7a3f2c' } },
]
