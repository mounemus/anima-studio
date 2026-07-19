/** Diagnostic: run every preset graph through the REAL evaluation pipeline and
 *  assert the output geometry is non-empty and NaN-free. This reproduces the
 *  "génération vide / mesh fractionné" bug deterministically, off the browser. */
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { evalGraph, makeNode, uid, type Graph } from './graph'
import { weld, repair, analyze } from './mesh'
import * as D from './deform'
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
      // watertight 0; self-intersecting TPMS (gyroid/voronoi) leave ≤4 non-manifold
      // edges that slicers auto-fix. So: never increase, and land at ≤4.
      if (before > 0) expect(after.openEdges, `${p.name}: openEdges ${before} → ${after.openEdges} (no improvement)`).toBeLessThan(before)
      expect(after.openEdges, `${p.name}: ${after.openEdges} open edges remain (from ${before})`).toBeLessThanOrEqual(4)
    }, 20000)
  }
})

function nanCount(g: THREE.BufferGeometry) { const a = g.getAttribute('position').array as ArrayLike<number>; let n = 0; for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) n++; return n }

describe('mesh metamorphoses (deform.ts) — valid on any mesh', () => {
  const cases: [string, (g: THREE.BufferGeometry) => THREE.BufferGeometry][] = [
    ['twist', (g) => D.twistMesh(g, 1.6)], ['taper', (g) => D.taperMesh(g, 0.5)], ['bend', (g) => D.bendMesh(g, 1)],
    ['shear', (g) => D.shearMesh(g, 0.3)], ['inflate', (g) => D.inflateMesh(g, 0.06)], ['spherify', (g) => D.spherifyMesh(g, 0.4)],
    ['arabesque', (g) => D.arabesqueMesh(g, 0.12, 6, 1)], ['organic', (g) => D.organicMesh(g, 0.12, 3, 1)], ['ripple', (g) => D.rippleMesh(g, 0.08, 2)],
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
