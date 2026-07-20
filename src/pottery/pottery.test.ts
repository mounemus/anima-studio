/** Pottery : the radial-profile geometry & starting shapes are pure math — verify they
 *  produce valid, volume-normalised, NaN-free meshes (incl. flutes) off the browser. */
import { describe, it, expect } from 'vitest'
import { startProfile, buildPotGeometry, START_SHAPES, NR, DY, VOL_K } from './PotteryStudio'

const volumeOf = (rOut: Float32Array, rIn: Float32Array, top: number) => {
  let v = 0; for (let i = 0; i <= top; i++) v += Math.PI * Math.max(0, rOut[i] * rOut[i] - rIn[i] * rIn[i]) * DY; return v
}
const geomNaN = (g: ReturnType<typeof buildPotGeometry>) => { const a = g.getAttribute('position').array as ArrayLike<number>; let n = 0; for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) n++; return n }

describe('pottery starting profiles', () => {
  for (const s of START_SHAPES) {
    it(`${s.kind}: valid, volume-normalised, meshes cleanly (with flutes)`, () => {
      const rOut = new Float32Array(NR), rIn = new Float32Array(NR)
      const top = startProfile(s.kind, 1, rOut, rIn)
      expect(top, `${s.kind}: top`).toBeGreaterThan(4)
      for (let i = 0; i <= top; i++) { expect(Number.isFinite(rOut[i]) && Number.isFinite(rIn[i]), `${s.kind}: NaN radius`).toBe(true); expect(rIn[i]).toBeLessThanOrEqual(rOut[i] + 1e-6) }
      // volume normalised to VOL_K·mass (mass 1) within the clamp tolerance
      const v = volumeOf(rOut, rIn, top)
      // Normalised toward VOL_K·mass; flat/narrow shapes clamp (radius ≤ MAXR) so allow a band.
      expect(v, `${s.kind}: volume ${v}`).toBeGreaterThan(VOL_K * 0.45)
      expect(v, `${s.kind}: volume ${v}`).toBeLessThan(VOL_K * 1.6)
      const g = buildPotGeometry(rOut, rIn, top, 8, 0.06)
      expect(geomNaN(g), `${s.kind}: geom NaN`).toBe(0)
      expect(g.getIndex()!.count / 3, `${s.kind}: tris`).toBeGreaterThan(200)
    })
  }
  it('flutes actually modulate the mesh', () => {
    const rOut = new Float32Array(NR), rIn = new Float32Array(NR)
    const top = startProfile('cylindre', 1, rOut, rIn)
    const plain = buildPotGeometry(rOut, rIn, top, 0, 0).getAttribute('position').array as Float32Array
    const fluted = buildPotGeometry(rOut, rIn, top, 8, 0.1).getAttribute('position').array as Float32Array
    let diff = 0; for (let i = 0; i < plain.length; i++) if (Math.abs(plain[i] - fluted[i]) > 1e-4) diff++
    expect(diff, 'flutes had no effect').toBeGreaterThan(100)
  })
})
