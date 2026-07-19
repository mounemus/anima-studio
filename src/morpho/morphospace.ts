/** Morphospace operators for MORPHOGENESIS STUDIO — breed & blend graph variants.
 *  Interpolation and crossover recombine the NUMERIC parameters of two structurally
 *  identical graphs (same node types in the same order), keeping the topology intact. */
import type { Graph } from './graph'
import { NODE_DEFS } from './graph'

const clamp = (a: number, b: number, v: number) => Math.max(a, Math.min(b, v))
const clone = (g: Graph): Graph => JSON.parse(JSON.stringify(g))

/** Two graphs can be bred iff they share topology (same node types, same edge count). */
export function sameStructure(a: Graph, b: Graph): boolean {
  if (a.nodes.length !== b.nodes.length || a.edges.length !== b.edges.length) return false
  for (let i = 0; i < a.nodes.length; i++) if (a.nodes[i].type !== b.nodes[i].type) return false
  return true
}

/** Interpolate numeric params between two matching graphs (t=0 → a, t=1 → b). Seeds and
 *  select params snap to the nearer parent. Non-matching graphs fall back to `a`. */
export function lerpGraph(a: Graph, b: Graph, t: number): Graph {
  const g = clone(a)
  if (!sameStructure(a, b)) return g
  for (let i = 0; i < g.nodes.length; i++) {
    const na = a.nodes[i], nb = b.nodes[i], ng = g.nodes[i]
    const def = NODE_DEFS[ng.type]; if (!def) continue
    for (const pr of def.params) {
      const va = na.params[pr.key], vb = nb.params[pr.key]
      if (pr.type === 'num' && typeof va === 'number' && typeof vb === 'number') ng.params[pr.key] = clamp(pr.min ?? -1e9, pr.max ?? 1e9, va + (vb - va) * t)
      else ng.params[pr.key] = t < 0.5 ? va : vb
    }
  }
  return g
}

/** Crossover : per-parameter recombination of two parents with a deterministic RNG
 *  (numbers = parent A, parent B, or a random blend). Non-matching graphs fall back to `a`. */
export function crossGraph(a: Graph, b: Graph, seed: number): Graph {
  const g = clone(a)
  if (!sameStructure(a, b)) return g
  let s = (seed | 0) || 1; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
  for (let i = 0; i < g.nodes.length; i++) {
    const na = a.nodes[i], nb = b.nodes[i], ng = g.nodes[i]
    const def = NODE_DEFS[ng.type]; if (!def) continue
    for (const pr of def.params) {
      const va = na.params[pr.key], vb = nb.params[pr.key]
      if (pr.type === 'num' && typeof va === 'number' && typeof vb === 'number') { const r = rnd(); ng.params[pr.key] = r < 0.4 ? va : r < 0.8 ? vb : clamp(pr.min ?? -1e9, pr.max ?? 1e9, va + (vb - va) * rnd()) }
      else ng.params[pr.key] = rnd() < 0.5 ? va : vb
    }
  }
  return g
}
