/** The finishing pass is what makes the output printable. Verify it against the two
 *  defects actually measured on raw marching-cubes output: floating debris, and open
 *  boundaries that Laplacian smoothing then shreds. */
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { finishMesh, keepMainComponents, openEdgeCount } from './finish'
import { buildOrganic, ORG_DEFAULTS, type OrgPore } from './organic'
import { weld } from '../morpho/mesh'

const components = (g: THREE.BufferGeometry) => keepMainComponents(g, 0).components

describe('keepMainComponents : drop floating debris', () => {
  it('a big sphere plus tiny specks keeps only the sphere', () => {
    const big = new THREE.IcosahedronGeometry(1, 3).toNonIndexed()
    const specks = [0, 1, 2].map((i) => { const s = new THREE.IcosahedronGeometry(0.03, 0).toNonIndexed(); s.translate(2 + i, 0, 0); return s })   // 20 tri chacun vs 320
    const merged = weld(mergeGeometries([big, ...specks], false)!)
    expect(components(merged), 'setup should have 4 components').toBe(4)
    const { geo, removed } = keepMainComponents(merged, 0.2)   // seuil > 20/320 = 6 %
    expect(removed).toBe(3)
    expect(components(geo)).toBe(1)
    geo.computeBoundingBox()
    expect(geo.boundingBox!.max.x, 'specks still present').toBeLessThan(1.5)
  })
  it('keeps every component when they are all comparable', () => {
    const a = new THREE.IcosahedronGeometry(1, 2).toNonIndexed()
    const b = new THREE.IcosahedronGeometry(1, 2).toNonIndexed(); b.translate(5, 0, 0)
    const merged = weld(mergeGeometries([a, b], false)!)
    const { removed, components: n } = keepMainComponents(merged, 0.05)
    expect(n).toBe(2); expect(removed).toBe(0)
  })
  it('a single clean mesh is untouched', () => {
    const g = weld(new THREE.IcosahedronGeometry(1, 3).toNonIndexed())
    const { removed, components: n } = keepMainComponents(g, 0.05)
    expect(n).toBe(1); expect(removed).toBe(0)
  })
})

describe('finishMesh : the real organic output becomes watertight', () => {
  // Ce sont exactement les réglages qui produisaient des « rubans déchirés ».
  for (const pore of ['boucles', 'pores', 'lattice', 'cellules'] as OrgPore[]) {
    for (const noiseAmp of [0, 0.035]) {
      it(`${pore} (bruit ${noiseAmp}) : débris retirés, aucun bord ouvert`, () => {
        const raw = buildOrganic({ ...ORG_DEFAULTS, form: 'ovoide', pore, noiseAmp, res: 56 })
        const { geo, stats } = finishMesh(raw, { smooth: 2, minFrac: 0.05 })
        expect(stats.boundary, `${pore}: bords ouverts`).toBe(0)
        expect(stats.tris, `${pore}: maillage vide`).toBeGreaterThan(100)
        // Les débris partent ; les pièces réellement grosses restent (un lattice gyroïde
        // EST légitimement fait de plusieurs brins — les fusionner serait faux).
        expect(components(geo), `${pore}: débris non retirés`).toBeLessThanOrEqual(stats.components)
        if (stats.components > 1) expect(stats.removed, `${pore}: rien filtré`).toBeGreaterThan(0)
      })
      it(`${pore} (bruit ${noiseAmp}) : « pièce principale seule » donne 1 composant`, () => {
        const raw = buildOrganic({ ...ORG_DEFAULTS, form: 'ovoide', pore, noiseAmp, res: 56 })
        const { geo } = finishMesh(raw, { smooth: 2, minFrac: 1 })
        expect(components(geo), `${pore}: plusieurs pièces subsistent`).toBe(1)
      })
    }
  }
  it('smoothing AFTER closing does not re-open the mesh', () => {
    const raw = buildOrganic({ ...ORG_DEFAULTS, form: 'ovoide', pore: 'cellules', res: 56 })
    for (const smooth of [0, 1, 4, 6]) {
      const { stats } = finishMesh(raw, { smooth })
      expect(stats.boundary, `lissage ${smooth} a ouvert des bords`).toBe(0)
    }
  })
  it('geometry stays finite and bounded after finishing', () => {
    const raw = buildOrganic({ ...ORG_DEFAULTS, form: 'lyre', pore: 'boucles', res: 56 })
    const { geo } = finishMesh(raw, { smooth: 3 })
    const a = geo.getAttribute('position').array as ArrayLike<number>
    for (let i = 0; i < a.length; i++) { expect(Number.isFinite(a[i])).toBe(true); expect(Math.abs(a[i])).toBeLessThan(3) }
  })
  it('REPORTS the residual non-manifold edges instead of pretending they are gone', () => {
    // Limite connue et documentée : weld() fusionne deux nappes qui se touchent. Le maillage
    // reste géométriquement fermé (Rhino lit « 1 closed mesh »), mais on ne prétend pas
    // l'inverse — la stat est exposée pour que l'artiste décide.
    const raw = buildOrganic({ ...ORG_DEFAULTS, form: 'ovoide', pore: 'cellules', res: 56 })
    const { stats } = finishMesh(raw, { smooth: 1 })
    expect(typeof stats.nonManifold).toBe('number')
    expect(stats.nonManifold).toBeGreaterThanOrEqual(0)
    expect(stats.watertight).toBe(stats.boundary === 0 && stats.nonManifold === 0)
  })
})

describe('openEdgeCount', () => {
  it('0 on a closed sphere, > 0 on a plane', () => {
    expect(openEdgeCount(weld(new THREE.IcosahedronGeometry(1, 2).toNonIndexed()))).toBe(0)
    expect(openEdgeCount(weld(new THREE.PlaneGeometry(1, 1, 2, 2).toNonIndexed()))).toBeGreaterThan(0)
  })
})
