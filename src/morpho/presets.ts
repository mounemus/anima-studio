/** Starter generative systems for MORPHOGENESIS STUDIO — real node graphs, not images. */
import type { Graph, GNode } from './graph'
import { makeNode } from './graph'

/** Build a graph from a linear list of [type, paramOverrides] → chained + Output. */
function chain(steps: [string, Record<string, number | string>?][]): Graph {
  const nodes: GNode[] = []
  let x = 60
  for (const [type, ov] of steps) { const n = makeNode(type, x, 120); if (ov) Object.assign(n.params, ov); nodes.push(n); x += 190 }
  const out = makeNode('output', x, 120); nodes.push(out)
  const edges = nodes.slice(0, -1).map((n, i) => ({ id: `e${i}`, from: n.id, fromIdx: 0, to: nodes[i + 1].id, toIdx: 0 }))
  return { nodes, edges }
}

export const PRESETS: { name: string; desc: string; build: () => Graph }[] = [
  { name: '🪸 Coral Relief', desc: 'Metaballs + crêtes de bruit + parois — relief corallien poreux.', build: () => chain([['metaballs', { count: 16, radius: 0.32, spread: 0.6, seed: 7 }], ['displace', { type: 'ridged', amp: 0.16, freq: 3.5 }], ['surface', { res: 80, bound: 1.2 }], ['smooth', { iter: 1 }]]) },
  { name: '🔵 Voronoi Halo', desc: 'Cellules Voronoï 3D à parois fines dans un volume radial.', build: () => chain([['voronoi', { scale: 4, thick: 0.09, bound: 0.95 }], ['surface', { res: 96, bound: 1.1 }], ['smooth', { iter: 1 }]]) },
  { name: '🌀 Gyroid Skin', desc: 'Surface minimale TPMS à porosité continue — objet ou enveloppe.', build: () => chain([['gyroid', { freq: 7, thick: 0.5, bound: 1 }], ['surface', { res: 100, bound: 1.15 }]]) },
  { name: '🌸 Fractal Bloom', desc: 'Croissance radiale par phyllotaxie + bruit — inflorescence.', build: () => chain([['bloom', { count: 60, radius: 0.13, spread: 0.85, rise: 0.35 }], ['displace', { type: 'fbm', amp: 0.06, freq: 4 }], ['radial', { n: 5 }], ['surface', { res: 88, bound: 1.15 }], ['smooth', { iter: 1 }]]) },
  { name: '🏺 Cellular Vessel', desc: 'Vase creux à cellules ouvertes (sphère évidée × Voronoï).', build: () => {
    const sphere = makeNode('sphere', 60, 60); sphere.params.r = 0.95
    const shell = makeNode('shell', 250, 60); shell.params.t = 0.06
    const vor = makeNode('voronoi', 60, 260); Object.assign(vor.params, { scale: 3.5, thick: 0.14, bound: 1 })
    const bool = makeNode('boolean', 440, 150); bool.params.op = 'subtract'; bool.params.k = 0.04
    const surf = makeNode('surface', 630, 150); Object.assign(surf.params, { res: 96, bound: 1.15 })
    const out = makeNode('output', 820, 150)
    return { nodes: [sphere, shell, vor, bool, surf, out], edges: [
      { id: 'e0', from: sphere.id, fromIdx: 0, to: shell.id, toIdx: 0 },
      { id: 'e1', from: shell.id, fromIdx: 0, to: bool.id, toIdx: 0 },
      { id: 'e2', from: vor.id, fromIdx: 0, to: bool.id, toIdx: 1 },
      { id: 'e3', from: bool.id, fromIdx: 0, to: surf.id, toIdx: 0 },
      { id: 'e4', from: surf.id, fromIdx: 0, to: out.id, toIdx: 0 },
    ] }
  } },
  { name: '🦴 Bone Lattice', desc: 'Treillis TPMS Schwarz dense — structure trabéculaire légère.', build: () => chain([['schwarz', { freq: 9, thick: 0.7, bound: 1 }], ['surface', { res: 110, bound: 1.15 }]]) },
]
