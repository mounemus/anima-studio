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
  sdSphere, sdTorus, metaballs, gyroid, voronoiWalls,
  fSubtract, fShell, fDisplace, opTwist, opTaper, opBend, opStretch, opMirrorX,
  type NoiseType,
} from '../morpho/fields'

export const ORG_BOUND = 1.15

export type OrgForm = 'ovoide' | 'colonne' | 'lyre' | 'tore' | 'ruban'
export type OrgPore = 'aucun' | 'pores' | 'boucles' | 'lattice' | 'cellules'

export const ORG_FORMS: { kind: OrgForm; label: string }[] = [
  { kind: 'lyre', label: '🏺 Lyre (bulbe · taille · bulbe)' },
  { kind: 'ovoide', label: '🥚 Ovoïde' },
  { kind: 'colonne', label: '🗼 Colonne' },
  { kind: 'tore', label: '⭕ Tore' },
  { kind: 'ruban', label: '🎗 Ruban (plat, à torsader)' },
]
export const ORG_PORES: { kind: OrgPore; label: string }[] = [
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
}

export const ORG_DEFAULTS: OrganicParams = {
  form: 'lyre', pore: 'boucles', poreRows: 4, poreCount: 6, poreSize: 0.15, poreRadius: 0.42,
  blend: 0.09, latticeFreq: 7, shell: 0.055, mirror: true,
  twist: 0, taper: 0, bend: 0, noiseAmp: 0, noiseFreq: 2.2, noiseType: 'fbm', res: 72,
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
    default: return opStretch(sdSphere(0.62), 0.88, 1.2, 0.88)
  }
}

/** The field that gets SUBTRACTED from the body to open it up. `null` = no perforation. */
export function poreField(p: OrganicParams): Field | null {
  if (p.pore === 'aucun') return null
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

/** Compose the full field: body → shell → perforate → mirror → warp → noise. */
export function organicField(p: OrganicParams): Field {
  let f = formField(p.form)
  if (p.shell > 0.001) f = fShell(f, p.shell)
  const holes = poreField(p)
  if (holes) f = fSubtract(f, holes, Math.max(0, p.blend))
  if (p.mirror) f = opMirrorX(f)
  if (Math.abs(p.twist) > 0.001) f = opTwist(f, p.twist)
  if (Math.abs(p.taper) > 0.001) f = opTaper(f, p.taper)
  if (Math.abs(p.bend) > 0.001) f = opBend(f, p.bend)
  if (p.noiseAmp > 0.001) f = fDisplace(f, p.noiseType, p.noiseAmp, p.noiseFreq)
  return f
}

/** Field → real, exportable geometry. `onProgress(0→1)` reports meshing progress. */
export function buildOrganic(p: OrganicParams, onProgress?: (t: number) => void): THREE.BufferGeometry {
  return marchingCubes(organicField(p), clamp(24, 160, Math.round(p.res)), ORG_BOUND, 0, onProgress)
}

/** Ready-made looks matching the reference imagery. */
export const ORG_PRESETS: { name: string; desc: string; params: Partial<OrganicParams> }[] = [
  { name: '🫀 Bio-lattice', desc: 'Coque perforée à entretoises épaisses — la référence turquoise.', params: { form: 'lyre', pore: 'boucles', poreRows: 4, poreCount: 6, poreSize: 0.15, poreRadius: 0.42, blend: 0.09, shell: 0.055, mirror: true, twist: 0, noiseAmp: 0 } },
  { name: '🌸 Rosace radiale', desc: 'Symétrie radiale dense, lecture frontale en rosace.', params: { form: 'ovoide', pore: 'boucles', poreRows: 3, poreCount: 8, poreSize: 0.17, poreRadius: 0.46, blend: 0.11, shell: 0.05, mirror: true, twist: 0.3 } },
  { name: '🎗 Ruban chromé', desc: 'Surface pleine torsadée, sans perforation — pour un rendu métal.', params: { form: 'ruban', pore: 'aucun', shell: 0, mirror: false, twist: 2.4, taper: 0.2, noiseAmp: 0 } },
  { name: '🧬 Os gyroïde', desc: 'Porosité continue type trabéculaire, imprimable.', params: { form: 'colonne', pore: 'lattice', latticeFreq: 8, blend: 0.04, shell: 0, mirror: false, twist: 0.6 } },
  { name: '🪸 Corail cellulaire', desc: 'Parois de Voronoï + bruit organique.', params: { form: 'ovoide', pore: 'cellules', latticeFreq: 7, blend: 0.05, shell: 0, mirror: false, noiseAmp: 0.035, noiseFreq: 3 } },
]
