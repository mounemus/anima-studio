/** Diagnostic: run every preset graph through the REAL evaluation pipeline and
 *  assert the output geometry is non-empty and NaN-free. This reproduces the
 *  "génération vide / mesh fractionné" bug deterministically, off the browser. */
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { evalGraph, makeNode, uid, NODE_DEFS, type Graph } from './graph'
import { weld, repair, analyze } from './mesh'
import * as D from './deform'
import { textToGraph } from './assistant'
import { lerpGraph, crossGraph, sameStructure } from './morphospace'
import { meshBoolean } from './csg'
import { PRESETS } from './presets'

function inspect(geo: ReturnType<typeof evalGraph>) {
  if (!geo) return { ok: false, tris: 0, nanCount: 0, reason: 'null geometry' }
  const pos = geo.getAttribute('position')
  if (!pos) return { ok: false, tris: 0, nanCount: 0, reason: 'no position attr' }
  const arr = pos.array as ArrayLike<number>
  let nanCount = 0
  for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) nanCount++
  const idx = geo.getIndex()
  const tris = idx ? idx.count / 3 : pos.count / 3
  return { ok: nanCount === 0 && tris > 0, tris, nanCount, reason: '' }
}

describe('morpho preset pipeline (proxy quality)', () => {
  for (const p of PRESETS) {
    it(`${p.name} → non-empty, NaN-free geometry`, () => {
      const geo = evalGraph(p.build(), 'proxy')
      const r = inspect(geo)
      // Surface diagnostics in the failure message.
      expect(r.nanCount, `${p.name}: ${r.nanCount} NaN coords / ${r.tris} tris (${r.reason})`).toBe(0)
      expect(r.tris, `${p.name}: only ${r.tris} tris`).toBeGreaterThan(50)
    })
  }
})

describe('weld → smooth, indexed, non-empty (the display path in the worker)', () => {
  for (const p of PRESETS) {
    it(`${p.name} welds to a valid smooth mesh`, () => {
      const geo = evalGraph(p.build(), 'proxy')!
      const before = geo.getAttribute('position').count
      const w = geo.getIndex() ? geo : weld(geo)
      const wr = inspect(w)
      expect(wr.nanCount, `${p.name}: weld produced ${wr.nanCount} NaN`).toBe(0)
      expect(wr.tris, `${p.name}: weld collapsed to ${wr.tris} tris`).toBeGreaterThan(50)
      // Welding a non-indexed march output should actually merge vertices (real smoothing).
      if (!geo.getIndex()) expect(w.getAttribute('position').count, `${p.name}: no vertices merged (still faceted)`).toBeLessThan(before)
    })
  }
})

describe('repair → watertight, NaN-free (the export "Réparer & lisser" path)', () => {
  for (const p of PRESETS) {
    it(`${p.name}: repair closes open edges & stays valid`, () => {
      const geo = evalGraph(p.build(), 'hd')!
      const before = analyze(geo).openEdges
      const fixed = repair(geo, { smooth: 1 })
      const after = analyze(fixed)
      // NaN-free after repair + smoothing
      const arr = fixed.getAttribute('position').array as ArrayLike<number>
      let nan = 0; for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) nan++
      expect(nan, `${p.name}: repair produced ${nan} NaN`).toBe(0)
      expect(after.tris, `${p.name}: repair emptied the mesh`).toBeGreaterThan(50)
      // Repair must massively reduce open edges. Solid/relief meshes reach a fully
      // watertight 0; self-intersecting TPMS reach ≤4 ; genuinely perforated CSG results
      // (gyroid-carved) can't fully close but must drop by ≥80 %. So: never increase, and
      // land at ≤4 OR ≥80 % reduction.
      if (before > 0) expect(after.openEdges, `${p.name}: openEdges ${before} → ${after.openEdges} (no improvement)`).toBeLessThan(before)
      expect(after.openEdges <= 4 || after.openEdges <= before * 0.2, `${p.name}: ${after.openEdges} open edges remain (from ${before})`).toBe(true)
    }, 20000)
  }
})

function nanCount(g: THREE.BufferGeometry) { const a = g.getAttribute('position').array as ArrayLike<number>; let n = 0; for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) n++; return n }

describe('mesh metamorphoses (deform.ts) — valid on any mesh', () => {
  const cases: [string, (g: THREE.BufferGeometry) => THREE.BufferGeometry][] = [
    ['twist', (g) => D.twistMesh(g, 1.6)], ['taper', (g) => D.taperMesh(g, 0.5)], ['bend', (g) => D.bendMesh(g, 1)],
    ['shear', (g) => D.shearMesh(g, 0.3)], ['inflate', (g) => D.inflateMesh(g, 0.06)], ['spherify', (g) => D.spherifyMesh(g, 0.4)],
    ['arabesque', (g) => D.arabesqueMesh(g, 0.12, 6, 1)], ['organic', (g) => D.organicMesh(g, 0.12, 3, 1)], ['ripple', (g) => D.rippleMesh(g, 0.08, 2)],
    ['moucharabieh', (g) => D.moucharabiehMesh(g, 0.11, 8, 5)], ['pleat', (g) => D.pleatMesh(g, 0.1, 14)], ['crystal', (g) => D.crystallizeMesh(g, 0.55, 9)],
  ]
  for (const [name, fn] of cases) {
    it(`${name}: NaN-free, keeps vertex count`, () => {
      const src = new THREE.SphereGeometry(0.7, 24, 16)
      const before = src.getAttribute('position').count
      const out = fn(src)
      expect(nanCount(out), `${name}: produced NaN`).toBe(0)
      expect(out.getAttribute('position').count, `${name}: vertex count changed`).toBe(before)
    })
  }
})

describe('imported mesh CAN be metamorphosed through the graph', () => {
  it('meshimport → mtwist → marabesque → morganic → output yields valid geometry', () => {
    const sph = new THREE.SphereGeometry(0.7, 24, 16)
    const pos = Array.from(sph.getAttribute('position').array as Float32Array)
    const idx = Array.from(sph.getIndex()!.array as ArrayLike<number>)
    const mi = makeNode('meshimport', 0, 0); mi.data = { pos, idx }
    const t = makeNode('mtwist', 0, 0), a = makeNode('marabesque', 0, 0), o = makeNode('morganic', 0, 0), out = makeNode('output', 0, 0)
    const graph: Graph = { nodes: [mi, t, a, o, out], edges: [
      { id: uid('e'), from: mi.id, fromIdx: 0, to: t.id, toIdx: 0 },
      { id: uid('e'), from: t.id, fromIdx: 0, to: a.id, toIdx: 0 },
      { id: uid('e'), from: a.id, fromIdx: 0, to: o.id, toIdx: 0 },
      { id: uid('e'), from: o.id, fromIdx: 0, to: out.id, toIdx: 0 },
    ] }
    const geo = evalGraph(graph, 'hd')
    expect(geo, 'import→métamorphose graph produced no geometry').not.toBeNull()
    expect(nanCount(geo!)).toBe(0)
    const tris = (geo!.getIndex()?.count ?? geo!.getAttribute('position').count) / 3
    expect(tris, 'metamorphosed import is empty').toBeGreaterThan(50)
  })
})

describe('AI assistant : métamorphose prompts build valid geometry', () => {
  const prompts = [
    'Colonne gothique moucharabieh cristalline',
    'Vase élancé plissé en céramique',
    'Dôme organique façon arabesque',
    'Coquille spiralée à peau organique',
  ]
  for (const prompt of prompts) {
    it(`"${prompt}" → non-empty, NaN-free`, () => {
      const built = textToGraph(prompt)
      // the mesh métamorphose node(s) must sit AFTER the surface node in the chain
      const types = built.graph.nodes.map((n) => n.type)
      const si = types.indexOf('surface')
      const metaIdx = types.findIndex((t) => t.startsWith('m') && ['mmoucharabieh', 'mcrystal', 'mpleat', 'marabesque', 'morganic'].includes(t))
      if (metaIdx >= 0 && si >= 0) expect(metaIdx, `${prompt}: métamorphose placed before surface`).toBeGreaterThan(si)
      const geo = evalGraph(built.graph, 'proxy')
      expect(geo, `${prompt}: no geometry`).not.toBeNull()
      expect(nanCount(geo!), `${prompt}: NaN`).toBe(0)
      const tris = (geo!.getIndex()?.count ?? geo!.getAttribute('position').count) / 3
      expect(tris, `${prompt}: empty`).toBeGreaterThan(50)
    })
  }
})

describe('morphospace : interpolation & croisement', () => {
  const perturb = (g: Graph): Graph => {
    const b: Graph = JSON.parse(JSON.stringify(g))
    for (const n of b.nodes) { const def = NODE_DEFS[n.type]; for (const pr of def.params) if (pr.type === 'num' && typeof n.params[pr.key] === 'number') n.params[pr.key] = Math.max(pr.min!, Math.min(pr.max!, (n.params[pr.key] as number) * 1.25 + (pr.max! - pr.min!) * 0.1)) }
    return b
  }
  it('lerp: endpoints match parents, all steps valid & NaN-free', () => {
    const a = PRESETS[1].build(), b = perturb(a)
    expect(sameStructure(a, b)).toBe(true)
    const t0 = lerpGraph(a, b, 0), t1 = lerpGraph(a, b, 1)
    // find a numeric param and check endpoints
    const key = NODE_DEFS[a.nodes[0].type].params.find((p) => p.type === 'num')!.key
    expect(t0.nodes[0].params[key]).toBeCloseTo(a.nodes[0].params[key] as number, 6)
    expect(t1.nodes[0].params[key]).toBeCloseTo(b.nodes[0].params[key] as number, 6)
    for (let k = 0; k <= 4; k++) { const g = lerpGraph(a, b, k / 4); const geo = evalGraph(g, 'proxy'); expect(geo).not.toBeNull(); expect(nanCount(geo!)).toBe(0) }
  }, 20000)
  it('cross: deterministic for a given seed, geometry valid', () => {
    const a = PRESETS[1].build(), b = perturb(a)
    const c1 = crossGraph(a, b, 42), c2 = crossGraph(a, b, 42)
    expect(JSON.stringify(c1)).toBe(JSON.stringify(c2))
    const geo = evalGraph(c1, 'proxy'); expect(geo).not.toBeNull(); expect(nanCount(geo!)).toBe(0)
  }, 20000)
  it('mismatched structure → falls back to parent A unchanged', () => {
    const a = PRESETS[0].build(), b = PRESETS[1].build()   // different node counts
    expect(sameStructure(a, b)).toBe(false)
    expect(JSON.stringify(lerpGraph(a, b, 0.5))).toBe(JSON.stringify(a))
    expect(JSON.stringify(crossGraph(a, b, 7))).toBe(JSON.stringify(a))
  })
})

describe('robust mesh boolean (three-bvh-csg)', () => {
  const A = () => new THREE.SphereGeometry(0.7, 24, 16)
  const B = () => { const g = new THREE.SphereGeometry(0.55, 24, 16); g.translate(0.45, 0, 0); return g }
  for (const op of ['union', 'subtract', 'intersect'] as const) {
    it(`${op}: non-empty, NaN-free`, () => {
      const r = meshBoolean(A(), B(), op)
      expect(nanCount(r), `${op}: NaN`).toBe(0)
      const tris = (r.getIndex()?.count ?? r.getAttribute('position').count) / 3
      expect(tris, `${op}: empty`).toBeGreaterThan(20)
    })
  }
  it('through the graph: (sphere ∖ box) via meshbool node', () => {
    const a = makeNode('sphere', 0, 0), sa = makeNode('surface', 0, 0)
    const b = makeNode('box', 0, 0), sb = makeNode('surface', 0, 0)
    const mb = makeNode('meshbool', 0, 0); mb.params.op = 'subtract'
    const out = makeNode('output', 0, 0)
    const graph: Graph = { nodes: [a, sa, b, sb, mb, out], edges: [
      { id: uid('e'), from: a.id, fromIdx: 0, to: sa.id, toIdx: 0 },
      { id: uid('e'), from: sa.id, fromIdx: 0, to: mb.id, toIdx: 0 },
      { id: uid('e'), from: b.id, fromIdx: 0, to: sb.id, toIdx: 0 },
      { id: uid('e'), from: sb.id, fromIdx: 0, to: mb.id, toIdx: 1 },
      { id: uid('e'), from: mb.id, fromIdx: 0, to: out.id, toIdx: 0 },
    ] }
    const geo = evalGraph(graph, 'proxy')
    expect(geo, 'meshbool graph produced nothing').not.toBeNull()
    expect(nanCount(geo!)).toBe(0)
  }, 20000)
})
