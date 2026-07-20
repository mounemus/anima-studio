/** Pottery : the radial-profile geometry, starting shapes and décor (texture / foot /
 *  spout / handles) are pure math — verify they produce valid, NaN-free meshes off the browser. */
import { describe, it, expect } from 'vitest'
import { startProfile, buildPotGeometry, START_SHAPES, DECORS, DECO0, NR, DY, VOL_K, type Deco } from './PotteryStudio'

const volumeOf = (rOut: Float32Array, rIn: Float32Array, top: number) => {
  let v = 0; for (let i = 0; i <= top; i++) v += Math.PI * Math.max(0, rOut[i] * rOut[i] - rIn[i] * rIn[i]) * DY; return v
}
const geomNaN = (g: ReturnType<typeof buildPotGeometry>) => { const a = g.getAttribute('position').array as ArrayLike<number>; let n = 0; for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) n++; return n }
const tris = (g: ReturnType<typeof buildPotGeometry>) => g.getIndex()!.count / 3
const profile = (kind: Parameters<typeof startProfile>[0]) => { const rOut = new Float32Array(NR), rIn = new Float32Array(NR); const top = startProfile(kind, 1, rOut, rIn); return { rOut, rIn, top } }

describe('pottery starting profiles', () => {
  for (const s of START_SHAPES) {
    it(`${s.kind}: valid, volume-normalised, meshes cleanly`, () => {
      const { rOut, rIn, top } = profile(s.kind)
      expect(top, `${s.kind}: top`).toBeGreaterThan(4)
      for (let i = 0; i <= top; i++) { expect(Number.isFinite(rOut[i]) && Number.isFinite(rIn[i]), `${s.kind}: NaN radius`).toBe(true); expect(rIn[i]).toBeLessThanOrEqual(rOut[i] + 1e-6) }
      const v = volumeOf(rOut, rIn, top)
      expect(v, `${s.kind}: volume ${v}`).toBeGreaterThan(VOL_K * 0.45)
      expect(v, `${s.kind}: volume ${v}`).toBeLessThan(VOL_K * 1.6)
      const g = buildPotGeometry(rOut, rIn, top)
      expect(geomNaN(g), `${s.kind}: geom NaN`).toBe(0)
      expect(tris(g), `${s.kind}: tris`).toBeGreaterThan(200)
    })
  }
})

describe('pottery décor', () => {
  for (const d of DECORS) {
    it(`texture "${d.type}": valid & NaN-free`, () => {
      const { rOut, rIn, top } = profile('vase')
      const deco: Deco = { ...DECO0, type: d.type, count: 8, depth: 0.12 }
      const g = buildPotGeometry(rOut, rIn, top, deco)
      expect(geomNaN(g), `${d.type}: NaN`).toBe(0)
      expect(tris(g)).toBeGreaterThan(200)
    })
  }
  it('a texture actually modulates the mesh', () => {
    const { rOut, rIn, top } = profile('cylindre')
    const plain = buildPotGeometry(rOut, rIn, top).getAttribute('position').array as Float32Array
    const fluted = buildPotGeometry(rOut, rIn, top, { ...DECO0, type: 'flutes', count: 8, depth: 0.1 }).getAttribute('position').array as Float32Array
    let diff = 0; for (let i = 0; i < plain.length; i++) if (Math.abs(plain[i] - fluted[i]) > 1e-4) diff++
    expect(diff, 'flutes had no effect').toBeGreaterThan(100)
  })
  it('handles add geometry and stay NaN-free', () => {
    const { rOut, rIn, top } = profile('vase')
    const t0 = tris(buildPotGeometry(rOut, rIn, top))
    const g2 = buildPotGeometry(rOut, rIn, top, { ...DECO0, handles: 2, handleSize: 0.6 })
    expect(geomNaN(g2), 'handles NaN').toBe(0)
    expect(tris(g2), 'handles added no triangles').toBeGreaterThan(t0 + 200)
  })
  it('foot + spout stay valid', () => {
    const { rOut, rIn, top } = profile('vase')
    const g = buildPotGeometry(rOut, rIn, top, { ...DECO0, foot: 0.6, spout: 0.6 })
    expect(geomNaN(g)).toBe(0)
    expect(tris(g)).toBeGreaterThan(200)
  })
})
