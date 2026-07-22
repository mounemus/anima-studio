/** mesh → SDF is the load-bearing piece for "apply organic params to a sculpted/imported
 *  object". A wrong SIGN silently inverts the solid, so verify against known shapes. */
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { meshToField, fitGeometry } from './meshField'
import { marchingCubes } from '../morpho/marching'
import { organicField, buildOrganic, ORG_DEFAULTS } from './organic'

const BOUND = 1.15

describe('meshToField : sign and magnitude on known shapes', () => {
  it('sphere : negative at the centre, positive outside, ~0 on the surface', () => {
    const f = meshToField(new THREE.IcosahedronGeometry(1, 4), { grid: 40, bound: BOUND, fit: 1.4 })
    // fit 1.4 → diameter 1.4 → radius 0.7
    expect(f(0, 0, 0), 'centre not inside').toBeLessThan(-0.4)
    expect(f(1.1, 0, 0), 'far point not outside').toBeGreaterThan(0.2)
    expect(Math.abs(f(0.7, 0, 0)), 'surface not near zero').toBeLessThan(0.09)
    expect(Math.abs(f(0, 0.7, 0))).toBeLessThan(0.09)
    expect(Math.abs(f(0, 0, 0.7))).toBeLessThan(0.09)
  })
  it('sphere : distance grows roughly linearly outward (it is a distance, not occupancy)', () => {
    const f = meshToField(new THREE.IcosahedronGeometry(1, 4), { grid: 40, bound: BOUND, fit: 1.4 })
    const a = f(0.8, 0, 0), b = f(0.95, 0, 0)
    expect(b).toBeGreaterThan(a)
    expect(b - a).toBeGreaterThan(0.08)   // ≈ 0.15 pour une vraie distance
  })
  it('box : corners inside, and a point just outside a face is positive', () => {
    const f = meshToField(new THREE.BoxGeometry(1, 1, 1), { grid: 40, bound: BOUND, fit: 1.2 })
    expect(f(0, 0, 0)).toBeLessThan(-0.4)
    expect(f(0.5, 0.5, 0.5), 'inside near corner').toBeLessThan(0)
    expect(f(0.9, 0, 0), 'outside a face').toBeGreaterThan(0)
  })
  it('torus : the HOLE is outside (a flood-fill sign error would fill it)', () => {
    const g = new THREE.TorusGeometry(0.6, 0.18, 16, 48)
    const f = meshToField(g, { grid: 48, bound: BOUND, fit: 1.55 })
    // TorusGeometry lies in the XY plane, hole along Z through the origin.
    expect(f(0, 0, 0), 'torus hole got filled in').toBeGreaterThan(0)
    expect(f(0.6 * (1.55 / 1.56), 0, 0), 'tube not inside').toBeLessThan(0.06)
  })
})

describe('meshToField : round-trips through marching cubes', () => {
  it('re-meshing the field reproduces a closed surface of the right size', () => {
    const f = meshToField(new THREE.IcosahedronGeometry(1, 4), { grid: 44, bound: BOUND, fit: 1.4 })
    const g = marchingCubes(f, 56, BOUND, 0)
    const pos = g.getAttribute('position').array as ArrayLike<number>
    expect(pos.length, 'empty re-mesh').toBeGreaterThan(300)
    let maxR = 0, minR = 9
    for (let i = 0; i < pos.length; i += 3) { const r = Math.hypot(pos[i], pos[i + 1], pos[i + 2]); if (r > maxR) maxR = r; if (r < minR) minR = r }
    expect(maxR, 'sphere too big').toBeLessThan(0.82)
    expect(minR, 'sphere too small / holed').toBeGreaterThan(0.58)
  })
  it('reports monotonic progress', () => {
    const seen: number[] = []
    meshToField(new THREE.IcosahedronGeometry(1, 3), { grid: 24, bound: BOUND, onProgress: (t) => seen.push(t) })
    expect(seen.length).toBeGreaterThan(2)
    expect(seen[seen.length - 1]).toBe(1)
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1])
  })
})

describe('integration : a sculpted/imported mesh goes through the organic pipeline', () => {
  const bodyOf = () => meshToField(new THREE.IcosahedronGeometry(1, 4), { grid: 40, bound: BOUND, fit: 1.5 })
  const solidCount = (fl: ReturnType<typeof meshToField>) => { let n = 0; for (let i = 0; i < 20; i++) for (let j = 0; j < 20; j++) for (let k = 0; k < 20; k++) { const x = (i / 19 - 0.5) * 2 * BOUND, y = (j / 19 - 0.5) * 2 * BOUND, z = (k / 19 - 0.5) * 2 * BOUND; if (fl(x, y, z) < 0) n++ } return n }

  it('form "mesh" uses the supplied body instead of a primitive', () => {
    const body = bodyOf()
    const asMesh = organicField({ ...ORG_DEFAULTS, form: 'mesh', pore: 'aucun', shell: 0, mirror: false }, body)
    // Un ovoïde intégré et une sphère importée diffèrent : le champ doit suivre la source.
    for (const [x, y, z] of [[0, 0, 0], [0.5, 0, 0], [0, 0.7, 0]] as [number, number, number][]) {
      expect(Math.abs(asMesh(x, y, z) - body(x, y, z)), 'body field not used verbatim').toBeLessThan(1e-6)
    }
  })
  it('perforating an imported body actually removes material', () => {
    const body = bodyOf()
    const plain = organicField({ ...ORG_DEFAULTS, form: 'mesh', pore: 'aucun', shell: 0, mirror: false }, body)
    const holed = organicField({ ...ORG_DEFAULTS, form: 'mesh', pore: 'boucles', shell: 0, mirror: false }, body)
    const cp = solidCount(plain), ch = solidCount(holed)
    expect(cp, 'imported body is empty').toBeGreaterThan(50)
    expect(ch, 'perforation did nothing to the imported body').toBeLessThan(cp)
  })
  it('the whole thing meshes to a real surface', () => {
    const g = buildOrganic({ ...ORG_DEFAULTS, form: 'mesh', pore: 'boucles', res: 44 }, undefined, bodyOf())
    expect(g.getAttribute('position').count, 'empty result').toBeGreaterThan(300)
    const a = g.getAttribute('position').array as ArrayLike<number>
    for (let i = 0; i < a.length; i++) expect(Number.isFinite(a[i])).toBe(true)
  })
  it('form "mesh" with NO body falls back to a primitive instead of crashing', () => {
    const g = buildOrganic({ ...ORG_DEFAULTS, form: 'mesh', res: 36 }, undefined, null)
    expect(g.getAttribute('position').count).toBeGreaterThan(0)
  })
})

describe('fitGeometry', () => {
  it('centres and scales the largest dimension to the target', () => {
    const g = new THREE.BoxGeometry(4, 1, 2); g.translate(10, -3, 7)
    const out = fitGeometry(g, 2)
    out.computeBoundingBox()
    const bb = out.boundingBox!, c = bb.getCenter(new THREE.Vector3()), s = bb.getSize(new THREE.Vector3())
    expect(Math.abs(c.x)).toBeLessThan(1e-5); expect(Math.abs(c.y)).toBeLessThan(1e-5); expect(Math.abs(c.z)).toBeLessThan(1e-5)
    expect(Math.max(s.x, s.y, s.z)).toBeCloseTo(2, 4)
  })
  it('does not mutate the source geometry', () => {
    const g = new THREE.BoxGeometry(4, 1, 2)
    const before = (g.getAttribute('position').array as Float32Array).slice()
    fitGeometry(g, 2)
    expect(Array.from(g.getAttribute('position').array as Float32Array)).toEqual(Array.from(before))
  })
})
