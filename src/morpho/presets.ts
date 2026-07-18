/** Starter generative systems for MORPHOGENESIS STUDIO — real node graphs, not images.
 *  Deliberately varied silhouettes (wall relief, tall column, spiral, vase, halo…). */
import type { Graph, GNode } from './graph'
import { makeNode } from './graph'

/** Build a graph from a linear list of [type, paramOverrides] → chained + Output. */
function chain(steps: [string, Record<string, number | string>?][]): Graph {
  const nodes: GNode[] = []
  let x = 40
  for (const [type, ov] of steps) { const n = makeNode(type, x, 90 + (nodes.length % 2) * 40); if (ov) Object.assign(n.params, ov); nodes.push(n); x += 175 }
  const out = makeNode('output', x, 110); nodes.push(out)
  const edges = nodes.slice(0, -1).map((n, i) => ({ id: `e${i}`, from: n.id, fromIdx: 0, to: nodes[i + 1].id, toIdx: 0 }))
  return { nodes, edges }
}

export const PRESETS: { name: string; desc: string; build: () => Graph }[] = [
  { name: '🪸 Coral Relief', desc: 'Panneau mural : cupules & pores coralliens gravés dans une dalle.', build: () => chain([['metaballs', { shape: 'disc', count: 26, radius: 0.24, spread: 0.85, seed: 7 }], ['displace', { type: 'ridged', amp: 0.14, freq: 4 }], ['relief', { thick: 0.28, bound: 1 }], ['surface', { res: 96, bound: 1.15 }], ['smooth', { iter: 1 }]]) },
  { name: '⛪ Gothic Spine', desc: 'Colonne verticale symétrique à nervures et articulations pointues.', build: () => chain([['metaballs', { shape: 'column', count: 22, radius: 0.26, spread: 0.5, seed: 4 }], ['stretch', { sy: 2.1, sxz: 0.7 }], ['radial', { n: 6 }], ['taper', { k: 0.35 }], ['surface', { res: 92, bound: 1.35 }], ['smooth', { iter: 1 }]]) },
  { name: '🐚 Nautilus Growth', desc: 'Croissance spiralée à chambres — coquille hélicoïdale creuse.', build: () => chain([['helix', { count: 46, radius: 0.16, spread: 0.9, turns: 0.55 }], ['twist', { k: 1.2 }], ['shell', { t: 0.06 }], ['surface', { res: 100, bound: 1.25 }], ['smooth', { iter: 1 }]]) },
  { name: '🔵 Voronoi Halo', desc: 'Cellules Voronoï 3D à parois fines — objet radial poreux.', build: () => chain([['voronoi', { scale: 4, thick: 0.09, bound: 0.95 }], ['stretch', { sy: 1.3, sxz: 1 }], ['surface', { res: 100, bound: 1.15 }], ['smooth', { iter: 1 }]]) },
  { name: '🌀 Gyroid Column', desc: 'Colonne TPMS gyroïde à porosité continue — objet ou enveloppe.', build: () => chain([['gyroid', { freq: 7, thick: 0.5, bound: 1 }], ['stretch', { sy: 1.8, sxz: 0.75 }], ['surface', { res: 104, bound: 1.3 }]]) },
  { name: '🌸 Fractal Bloom', desc: 'Éventail radial par phyllotaxie + bruit — inflorescence.', build: () => chain([['bloom', { count: 64, radius: 0.13, spread: 0.9, rise: 0.4 }], ['displace', { type: 'fbm', amp: 0.06, freq: 4 }], ['radial', { n: 6 }], ['surface', { res: 90, bound: 1.2 }], ['smooth', { iter: 1 }]]) },
  { name: '🏺 Cellular Vessel', desc: 'Vase élancé creux à cellules ouvertes (colonne évidée × Voronoï).', build: () => {
    const cap = makeNode('capsule', 40, 60); Object.assign(cap.params, { h: 0.7, r: 0.55 })
    const str = makeNode('stretch', 220, 60); Object.assign(str.params, { sy: 1.5, sxz: 0.9 })
    const shell = makeNode('shell', 400, 60); shell.params.t = 0.05
    const vor = makeNode('voronoi', 40, 280); Object.assign(vor.params, { scale: 3.2, thick: 0.14, bound: 1 })
    const bool = makeNode('boolean', 580, 160); bool.params.op = 'subtract'; bool.params.k = 0.04
    const surf = makeNode('surface', 760, 160); Object.assign(surf.params, { res: 96, bound: 1.3 })
    const out = makeNode('output', 940, 160)
    return { nodes: [cap, str, shell, vor, bool, surf, out], edges: [
      { id: 'e0', from: cap.id, fromIdx: 0, to: str.id, toIdx: 0 },
      { id: 'e1', from: str.id, fromIdx: 0, to: shell.id, toIdx: 0 },
      { id: 'e2', from: shell.id, fromIdx: 0, to: bool.id, toIdx: 0 },
      { id: 'e3', from: vor.id, fromIdx: 0, to: bool.id, toIdx: 1 },
      { id: 'e4', from: bool.id, fromIdx: 0, to: surf.id, toIdx: 0 },
      { id: 'e5', from: surf.id, fromIdx: 0, to: out.id, toIdx: 0 },
    ] }
  } },
  { name: '🦴 Bone Lattice', desc: 'Structure trabéculaire Schwarz allongée — treillis léger imprimable.', build: () => chain([['schwarz', { freq: 9, thick: 0.7, bound: 1 }], ['stretch', { sy: 1.5, sxz: 0.85 }], ['surface', { res: 108, bound: 1.25 }]]) },
  { name: '🍶 Klein Bottle', desc: 'Surface paramétrique non-orientable — bouteille de Klein immergée.', build: () => chain([['klein', { res: 96 }], ['smooth', { iter: 1 }]]) },
  { name: '♾️ Möbius', desc: 'Ruban de Möbius paramétrique à torsion réglable.', build: () => chain([['mobius', { res: 140, width: 0.42, twists: 1 }], ['smooth', { iter: 1 }]]) },
]
