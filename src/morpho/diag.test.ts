/** Diagnostic: run every preset graph through the REAL evaluation pipeline and
 *  assert the output geometry is non-empty and NaN-free. This reproduces the
 *  "génération vide / mesh fractionné" bug deterministically, off the browser. */
import { describe, it, expect } from 'vitest'
import { evalGraph } from './graph'
import { weld, repair, analyze } from './mesh'
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
