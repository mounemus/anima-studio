/** Pottery : the radial-profile geometry, starting shapes and décor (texture / foot /
 *  spout / handles) are pure math — verify they produce valid, NaN-free meshes off the browser. */
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { startProfile, buildPotGeometry, makeGlaze, makeRakuFired, bakeRakuTexture, rakuSample, START_SHAPES, DECORS, GLAZES, DECO0, NR, DY, VOL_K, type Deco } from './PotteryStudio'

const volumeOf = (rOut: Float32Array, rIn: Float32Array, top: number) => {
  let v = 0; for (let i = 0; i <= top; i++) v += Math.PI * Math.max(0, rOut[i] * rOut[i] - rIn[i] * rIn[i]) * DY; return v
}
const geomNaN = (g: ReturnType<typeof buildPotGeometry>) => { const a = g.getAttribute('position').array as ArrayLike<number>; let n = 0; for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) n++; return n }
const tris = (g: ReturnType<typeof buildPotGeometry>) => g.getIndex()!.count / 3
const profile = (kind: Parameters<typeof startProfile>[0]) => { const rOut = new Float32Array(NR), rIn = new Float32Array(NR); const top = startProfile(kind, 1, rOut, rIn); return { rOut, rIn, top } }

const openEdges = (g: THREE.BufferGeometry) => { const idx = g.getIndex()!; const a = idx.array as ArrayLike<number>; const m = new Map<string, number>(); for (let i = 0; i < a.length; i += 3) { const t = [a[i], a[i + 1], a[i + 2]]; for (let j = 0; j < 3; j++) { const p = t[j], q = t[(j + 1) % 3], k = p < q ? `${p}_${q}` : `${q}_${p}`; m.set(k, (m.get(k) ?? 0) + 1) } } let o = 0; for (const c of m.values()) if (c !== 2) o++; return o }

describe('finalize : welded pot is watertight (closed) & detachable', () => {
  for (const s of START_SHAPES) {
    it(`${s.kind}: welds to a closed manifold (0 open edges)`, () => {
      const { rOut, rIn, top } = (() => { const rOut = new Float32Array(NR), rIn = new Float32Array(NR); const top = startProfile(s.kind, 1, rOut, rIn); return { rOut, rIn, top } })()
      const g = buildPotGeometry(rOut, rIn, top); g.deleteAttribute('uv')
      const w = mergeVertices(g, 1e-4)
      expect(openEdges(w), `${s.kind}: not watertight`).toBe(0)
    })
  }
})

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

describe('pottery firing & glaze', () => {
  for (const g of GLAZES) {
    it(`glaze "${g.kind}" builds a material`, () => {
      const m = makeGlaze(g.kind, '#b5651d', { crackle: 0.6, carbon: 0.5, lustre: 0.7 }, 42)
      expect(m).toBeInstanceOf(THREE.Material)
      expect(m.side).toBeDefined()
    })
  }
  it('raku raw preview material + fired AI-texture material', () => {
    const raw = makeGlaze('raku', '#c8794a', { crackle: 0.7, carbon: 0.6, lustre: 0.8 }, 7) as THREE.MeshPhysicalMaterial
    expect(raw.userData.raku).toBe(true)
    const fired = makeRakuFired({ crackle: 0.7, carbon: 0.6, lustre: 0.8 }, null) as THREE.MeshPhysicalMaterial
    expect(fired).toBeInstanceOf(THREE.MeshPhysicalMaterial)
    expect(fired.userData.rakuFired).toBe(true)
    expect(fired.iridescence).toBeGreaterThan(0)
    expect(() => bakeRakuTexture('#c8794a', { crackle: 0.7, carbon: 0.6, lustre: 0.8 }, 7)).not.toThrow()
  })
  it('geometry carries UVs; relief carves crack grooves where the texture is dark (aligned)', () => {
    const { rOut, rIn, top } = profile('vase')
    const smooth = buildPotGeometry(rOut, rIn, top, { ...DECO0, handles: 2 })
    expect(smooth.getAttribute('uv').count).toBe(smooth.getAttribute('position').count)
    const meanRad = (g: THREE.BufferGeometry) => { const p = g.getAttribute('position').array as ArrayLike<number>; let s = 0, n = 0; for (let i = 0; i < p.length; i += 3) { const r = Math.hypot(p[i], p[i + 2]); if (r > 0.05) { s += r; n++ } } return s / n }
    // all-dark sampler → grooves carved on the whole outer wall → mean radius drops
    const dark = buildPotGeometry(rOut, rIn, top, DECO0, { depth: 0.03, lum: () => 0 }, 200)
    const none = buildPotGeometry(rOut, rIn, top, DECO0, { depth: 0.03 }, 200)   // no sampler → no grooves
    expect(dark.getAttribute('uv').count).toBe(dark.getAttribute('position').count)
    expect(meanRad(dark), 'grooves not carved').toBeLessThan(meanRad(none) - 0.005)
    expect(dark.getAttribute('position').count, 'relief not finer than smooth').toBeGreaterThan(smooth.getAttribute('position').count)
  })
  it('rakuSample forms a crack network (varied, not flat) + has micro/speck fields', () => {
    const a = rakuSample(0.5, 0.3, 0.8, 7)
    expect(a).toHaveProperty('micro'); expect(a).toHaveProperty('speck')
    // Sample a grid on the cylinder ; a real crack network has mostly-low values with a
    // fraction of high (on-crack) values → both a high max and a low mean.
    let hi = 0, sum = 0, n = 0, mx = 0
    for (let i = 0; i < 40; i++) for (let k = 0; k < 20; k++) { const ang = (i / 40) * Math.PI * 2, t = k / 20; const c = rakuSample(Math.cos(ang), t * 1.7, Math.sin(ang), 7).crack; sum += c; n++; if (c > mx) mx = c; if (c > 0.4) hi++ }
    expect(mx, 'no strong cracks anywhere').toBeGreaterThan(0.6)
    expect(hi / n, 'cracks cover almost nothing').toBeGreaterThan(0.02)
    expect(sum / n, 'surface is mostly cracked (not a clean glaze)').toBeLessThan(0.5)
  })
})
