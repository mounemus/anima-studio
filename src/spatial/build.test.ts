import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { sweep, revolve, surface, primitive, simplify, relax, symMatrices, bakeForExport, type Obj, type P3 } from './build'

const arc: P3[] = Array.from({ length: 12 }, (_, i) => [Math.cos(i / 6), Math.sin(i / 6), i * 0.05])
const finite = (g: THREE.BufferGeometry) => Array.from(g.getAttribute('position').array as Float32Array).every(Number.isFinite)

/** Étanche = chaque arête est partagée par exactement deux triangles. */
function watertight(g: THREE.BufferGeometry) {
  const ix = g.index!.array, edges = new Map<string, number>()
  for (let i = 0; i < ix.length; i += 3) for (let k = 0; k < 3; k++) {
    const a = ix[i + k], b = ix[i + (k + 1) % 3], key = a < b ? `${a}_${b}` : `${b}_${a}`
    edges.set(key, (edges.get(key) ?? 0) + 1)
  }
  return [...edges.values()].every((n) => n === 2)
}

describe('esquisse spatiale : géométrie', () => {
  it('trait rond : maillage fini et étanche, effilé aux bouts', () => {
    const g = sweep(arc, 0.05, 'round', 0)
    expect(finite(g)).toBe(true)
    expect(watertight(g)).toBe(true)
    // rayon à l'extrémité : plein sans effilage, presque nul avec
    const end = (geo: THREE.BufferGeometry) => { const p = geo.getAttribute('position'); return new THREE.Vector3().fromBufferAttribute(p, 0).distanceTo(new THREE.Vector3(...arc[0])) }
    expect(end(g)).toBeCloseTo(0.05, 2)
    expect(end(sweep(arc, 0.05, 'round', 1))).toBeLessThan(0.005)
  })

  it('ruban : le plat suit la normale donnée', () => {
    const line: P3[] = [[0, 0, 0], [1, 0, 0], [2, 0, 0]]
    const g = sweep(line, 0.2, 'ribbon', 0, line.map(() => [0, 1, 0] as P3))
    g.computeBoundingBox()
    const s = g.boundingBox!.getSize(new THREE.Vector3())
    expect(s.z).toBeCloseTo(0.4, 2)    // large dans le plan de la paume
    expect(s.y).toBeCloseTo(0.04, 2)   // mince le long de la normale
  })

  it('un seul point donne une boule', () => {
    const g = sweep([[1, 2, 3]], 0.1); g.computeBoundingSphere()
    expect(g.boundingSphere!.center.distanceTo(new THREE.Vector3(1, 2, 3))).toBeLessThan(1e-3)
  })

  it('révolution : chaque sommet est à la distance du profil autour de l\'axe', () => {
    const g = revolve([[2, 0, 0], [2, 1, 0]], [0, 0, 0], [0, 1, 0], 24)!
    const p = g.getAttribute('position')
    for (let i = 0; i < p.count; i++) expect(Math.hypot(p.getX(i), p.getZ(i))).toBeCloseTo(2, 4)
    expect(revolve([[1, 0, 0]], [0, 0, 0], [0, 1, 0])).toBeNull()
  })

  it('révolution autour d\'un axe déplacé et incliné', () => {
    const g = revolve([[5, 0, 1], [6, 0, 1]], [5, 0, 0], [1, 0, 0], 16)!
    const p = g.getAttribute('position')
    for (let i = 0; i < p.count; i++) expect(Math.hypot(p.getY(i), p.getZ(i))).toBeCloseTo(1, 4)
  })

  it('surface : va d\'un bord à l\'autre', () => {
    const g = surface([[0, 0, 0], [1, 0, 0]], [[0, 1, 0], [1, 1, 0]])!
    g.computeBoundingBox()
    expect(g.boundingBox!.min.toArray()).toEqual([0, 0, 0])
    expect(g.boundingBox!.max.toArray()).toEqual([1, 1, 0])
  })

  it('boîte : tient entre les deux coins ; sphère : rayon = distance', () => {
    const b = primitive('box', [0, 0, 0], [2, 1, -3]); b.computeBoundingBox()
    expect(b.boundingBox!.min.toArray()).toEqual([0, 0, -3]); expect(b.boundingBox!.max.toArray()).toEqual([2, 1, 0])
    const s = primitive('sphere', [1, 1, 1], [1, 3, 1]); s.computeBoundingSphere()
    expect(s.boundingSphere!.radius).toBeCloseTo(2, 3)
    for (const k of ['cylinder', 'cone', 'pyramid', 'torus', 'capsule', 'plane'] as const) expect(finite(primitive(k, [0, 0, 0], [1, 0, 0]))).toBe(true)
  })

  it('simplification : garde les extrémités et les coins, retire l\'aligné', () => {
    const pts: P3[] = [[0, 0, 0], [1, 0.001, 0], [2, 0, 0], [2, 1, 0], [2, 2, 0]]
    expect(simplify(pts, 0.01)).toEqual([0, 2, 4])
  })

  it('symétries : nombre de copies et miroir', () => {
    expect(symMatrices('none', 6)).toHaveLength(1)
    expect(symMatrices('radial', 6)).toHaveLength(6)
    const m = symMatrices('mirror', 0)
    expect(m).toHaveLength(2); expect(m[1].determinant()).toBeLessThan(0)
  })

  it('export : une copie par symétrie, faces vers l\'extérieur même en miroir', () => {
    const o: Obj = { id: 'a', kind: 'prim', prim: 'sphere', layer: 'L1', color: '#fff', mat: 'matte', pts: [[2, 0, 0], [2.5, 0, 0]], size: 0.1, section: 'round', taper: 0, sym: 'mirror', symN: 2, pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: 1 }
    const root = bakeForExport([o])
    expect(root.children).toHaveLength(2)
    const mirrored = (root.children[1] as THREE.Mesh).geometry
    mirrored.computeBoundingSphere()
    const c = mirrored.boundingSphere!.center
    expect(c.x).toBeCloseTo(-2, 2)
    // normales sortantes : (sommet − centre) · normale > 0
    const p = mirrored.getAttribute('position'), n = mirrored.getAttribute('normal')
    let out = 0
    for (let i = 0; i < p.count; i++) if ((p.getX(i) - c.x) * n.getX(i) + (p.getY(i) - c.y) * n.getY(i) + (p.getZ(i) - c.z) * n.getZ(i) > 0) out++
    expect(out / p.count).toBeGreaterThan(0.95)
  })
})

describe('esquisse spatiale : adoucir un tracé', () => {
  it('réduit le tremblement, garde les extrémités, laisse une droite intacte', () => {
    const zig: P3[] = Array.from({ length: 21 }, (_, i) => [i * 0.1, i % 2 ? 0.05 : -0.05, 0])
    const out = relax(zig, 3)
    expect(out).toHaveLength(21)
    expect(out[0]).toEqual(zig[0]); expect(out[20]).toEqual(zig[20])
    const amp = (a: P3[]) => Math.max(...a.slice(2, -2).map((q) => Math.abs(q[1])))
    expect(amp(out)).toBeLessThan(amp(zig) * 0.2)
    const line: P3[] = [[0, 0, 0], [1, 1, 1], [2, 2, 2], [3, 3, 3]]
    relax(line, 3).forEach((q, i) => q.forEach((v, k) => expect(v).toBeCloseTo(line[i][k], 9)))
    expect(relax(zig, 0)).toBe(zig)
  })
})
