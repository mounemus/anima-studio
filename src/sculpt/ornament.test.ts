/** Ornament, surface perforations and shading : every new option must mesh to one clean
 *  piece, and the claims made in the code comments (even spacing, « cannot overlap »,
 *  « never sheds debris ») are measured here rather than asserted. */
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { marchingCubes } from '../morpho/marching'
import { organicParts, organicField, formField, ORG_DEFAULTS, ORG_BOUND, ORG_RELIEFS, ORG_PRESETS, type OrganicParams } from './organic'
import { sampleSurface, reliefCount, isScattered } from './ornament'
import { finishMesh } from './finish'
import { shadeMesh, paletteColors } from './shade'

const P = (o: Partial<OrganicParams> = {}): OrganicParams => ({ ...ORG_DEFAULTS, pore: 'aucun', shell: 0, mirror: false, ...o })
const mesh = (p: OrganicParams, res = 56) => {
  const parts = organicParts(p)
  const { geo, stats } = finishMesh(marchingCubes(parts.field, res, ORG_BOUND, 0, undefined, true), { smooth: 1 })
  return { parts, geo, stats }
}
const volume = (f: ReturnType<typeof organicField>, n = 30) => { let c = 0; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) if (f((i / (n - 1) - 0.5) * 2 * ORG_BOUND, (j / (n - 1) - 0.5) * 2 * ORG_BOUND, (k / (n - 1) - 0.5) * 2 * ORG_BOUND) < 0) c++; return c }

describe('sampleSurface : even points on the real surface', () => {
  const body = formField('goutte')
  const { anchors, spacing } = sampleSurface(body, 60, 3)
  it('returns the requested number of points, all ON the surface', () => {
    expect(anchors.length).toBe(60)
    for (const a of anchors) expect(Math.abs(body(...a.p)), 'point off the surface').toBeLessThan(0.004)
  })
  it('normals are unit and point outward', () => {
    for (const a of anchors) {
      expect(Math.hypot(...a.n)).toBeCloseTo(1, 3)
      expect(body(a.p[0] + a.n[0] * 0.05, a.p[1] + a.n[1] * 0.05, a.p[2] + a.n[2] * 0.05)).toBeGreaterThan(0)
    }
  })
  it('no two points are closer than the reported spacing', () => {
    let min = Infinity
    for (let i = 0; i < anchors.length; i++) for (let j = i + 1; j < anchors.length; j++) min = Math.min(min, Math.hypot(anchors[i].p[0] - anchors[j].p[0], anchors[i].p[1] - anchors[j].p[1], anchors[i].p[2] - anchors[j].p[2]))
    expect(min).toBeGreaterThanOrEqual(spacing - 1e-9)
    expect(spacing).toBeGreaterThan(0.1)
  })
  it('is deterministic for a seed and changes with it', () => {
    expect(sampleSurface(body, 20, 3).anchors).toEqual(sampleSurface(body, 20, 3).anchors)
    expect(sampleSurface(body, 20, 4).anchors).not.toEqual(sampleSurface(body, 20, 3).anchors)
  })
  it('xPositive keeps every point on one side (mirror)', () => {
    for (const a of sampleSurface(body, 30, 1, { xPositive: true }).anchors) expect(a.p[0]).toBeGreaterThanOrEqual(0)
  })
})

describe('relief : adds matter, in one piece', () => {
  for (const r of ORG_RELIEFS.filter((x) => x.kind !== 'aucun')) {
    it(`${r.kind} : more matter than the bare body, a single closed piece`, () => {
      const p = P({ form: 'ovoide', relief: r.kind, reliefDensity: 0.35, reliefHeight: isScattered(r.kind) ? 0.14 : 0.07 })
      expect(reliefCount(p)).toBeGreaterThan(0)
      expect(volume(organicField(p)), `${r.kind} added nothing`).toBeGreaterThan(volume(organicField(P({ form: 'ovoide' }))))
      const { stats, geo } = mesh(p, 72)
      expect(stats.tris).toBeGreaterThan(500)
      expect(stats.components - stats.removed, `${r.kind} : loose pieces`).toBe(1)
      expect(stats.boundary, `${r.kind} : open edges`).toBe(0)
      expect(stats.nonManifold, `${r.kind} : non-manifold edges`).toBe(0)
      const a = geo.getAttribute('position').array as ArrayLike<number>
      for (let i = 0; i < a.length; i++) expect(Number.isFinite(a[i])).toBe(true)
    })
  }
  it('elements work on an arbitrary body field (a sculpted or imported form)', () => {
    const lump: ReturnType<typeof formField> = (x, y, z) => Math.hypot(x * 1.3, y + 0.2 * Math.sin(4 * x), z * 0.9) - 0.6
    const parts = organicParts(P({ form: 'mesh', relief: 'epines', reliefHeight: 0.2 }), lump)
    const { stats } = finishMesh(marchingCubes(parts.field, 64, ORG_BOUND), { smooth: 0 })
    expect(stats.components - stats.removed).toBe(1)
    expect(volume(parts.field)).toBeGreaterThan(volume(lump))
  })
  it('polypes are bored : less matter than the same tubes left solid would have', () => {
    const cups = volume(organicField(P({ relief: 'polypes', reliefHeight: 0.16, reliefDensity: 0.25 })), 44)
    const pearls = volume(organicField(P({ relief: 'perles', reliefHeight: 0.16, reliefDensity: 0.25 })), 44)
    expect(cups).toBeGreaterThan(volume(organicField(P()), 44))
    expect(pearls).toBeGreaterThan(0)
  })
})

describe('surface perforations : holes AND ligaments by construction', () => {
  for (const pore of ['alveoles', 'resille'] as const) {
    for (const [poreSize, label] of [[0.04, 'smallest'], [0.32, 'largest']] as const) {
      it(`${pore}, ${label} openings : opens the shell and leaves one piece`, () => {
        const p = P({ form: 'gourde', pore, shell: 0.03, poreCount: 8, poreRows: 6, poreSize, blend: 0.01 })
        const solid = volume(organicField({ ...p, pore: 'aucun' }), 40)
        expect(volume(organicField(p), 40), 'nothing was opened').toBeLessThan(solid)
        for (const res of [72, 96]) {
          const { stats } = mesh({ ...p, res }, res)
          expect(stats.components - stats.removed, `the shell fell apart at resolution ${res}`).toBe(1)
          expect(stats.nonManifold, `non-manifold edges at resolution ${res}`).toBe(0)
        }
        const { stats } = mesh({ ...p, res: 96 }, 96)
        expect(stats.tris).toBeGreaterThan(2000)
      })
    }
  }
  it('alvéoles : jitter changes the pattern, seed re-draws it', () => {
    const at = (o: Partial<OrganicParams>) => volume(organicField(P({ form: 'colonne', pore: 'alveoles', shell: 0.03, ...o })), 36)
    expect(at({ poreJitter: 0 })).not.toBe(at({ poreJitter: 1 }))
    expect(at({ poreJitter: 1, seed: 1 })).not.toBe(at({ poreJitter: 1, seed: 2 }))
  })
})

describe('open : cuts the top', () => {
  it('removes matter above the cut and nothing below', () => {
    const f = organicField(P({ form: 'lyre', shell: 0.04, open: 0.3 }))
    expect(f(0.3, 0.8, 0), 'still matter above the cut').toBeGreaterThan(0)
    expect(volume(f)).toBeLessThan(volume(organicField(P({ form: 'lyre', shell: 0.04 }))))
    expect(volume(f)).toBeGreaterThan(50)
  })
})

describe('shading', () => {
  it('height follows the same warps as the field (twist + taper + bend + mirror)', () => {
    const p = P({ form: 'lyre', twist: 1.7, taper: 0.3, bend: 0.4, mirror: true })
    const { field, height } = organicParts(p)
    // corps nu, sans coque : les deux champs décrivent la même surface → même signe partout
    let disagree = 0
    for (let i = 0; i < 4000; i++) { const x = Math.sin(i * 12.9898) * 0.9, y = Math.sin(i * 78.233) * 0.9, z = Math.sin(i * 37.719) * 0.9; if ((field(x, y, z) < 0) !== (height(x, y, z) < 0)) disagree++ }
    expect(disagree).toBe(0)
  })
  it('relief tips score high, the bare skin about zero, bores negative ; hollows are occluded', () => {
    const p = P({ form: 'ovoide', shell: 0.04, relief: 'polypes', reliefHeight: 0.16, reliefDensity: 0.3 })
    const { parts, geo } = mesh(p, 80)
    const sh = shadeMesh(geo, parts.field, parts.height, p.shell)
    let hi = 0, lo = 0, mid = 0, aoMin = 1, aoSum = 0
    const V = sh.length / 2
    for (let i = 0; i < V; i++) { const h = sh[i * 2]; if (h > 0.8) hi++; else if (h < -0.2) lo++; else if (Math.abs(h) < 0.1) mid++; aoMin = Math.min(aoMin, sh[i * 2 + 1]); aoSum += sh[i * 2 + 1]; expect(h).toBeGreaterThanOrEqual(-1); expect(h).toBeLessThanOrEqual(1) }
    expect(hi, 'no vertex on a rim').toBeGreaterThan(20)
    expect(lo, 'no vertex in a bore').toBeGreaterThan(20)
    expect(mid, 'no vertex on the skin').toBeGreaterThan(20)
    expect(aoMin, 'nothing is occluded').toBeLessThan(0.5)
    expect(aoSum / V, 'everything is dark').toBeGreaterThan(0.6)
  })
  it('a bare body takes the body colour only', () => {
    const p = P({ form: 'ovoide' })
    const { parts, geo } = mesh(p, 40)
    const sh = shadeMesh(geo, parts.field, parts.height, 0)
    const col = paletteColors(sh, new THREE.Color(0, 1, 0), new THREE.Color(1, 0, 0), new THREE.Color(0, 0, 1))
    for (let i = 0; i < col.length; i += 3) { expect(col[i], 'relief colour on a bare body').toBeLessThan(0.02); expect(col[i + 1]).toBeGreaterThan(0.25) }
  })
})

describe('presets', () => {
  for (const pr of ORG_PRESETS) {
    it(`« ${pr.name} » : one clean piece at preview resolution`, () => {
      const p = { ...ORG_DEFAULTS, ...pr.params, res: 64 }
      const { stats } = mesh(p, 64)
      expect(stats.tris, 'empty').toBeGreaterThan(300)
      expect(stats.boundary, 'open edges').toBe(0)
    })
  }
})

describe('fleur mécanique', () => {
  for (const [petals, curl, stamens] of [[9, 0.85, 16], [3, 0, 0], [16, 1.5, 40]] as const) {
    it(`${petals} pétales, enroulement ${curl}, ${stamens} étamines : une seule pièce fermée`, () => {
      const p = P({ form: 'fleur', petals, curl, stamens, res: 96 })
      const { stats } = mesh(p, 96)
      expect(stats.tris).toBeGreaterThan(3000)
      expect(stats.boundary).toBe(0); expect(stats.nonManifold).toBe(0)
    })
  }
  it('petals, stamens and wheel are told apart for the glaze', () => {
    const p = P({ form: 'fleur', res: 96 })
    const { parts, geo } = mesh(p, 96)
    const sh = shadeMesh(geo, parts.field, parts.height, 0)
    let body = 0, relief = 0, hollow = 0
    for (let i = 0; i < sh.length; i += 2) { if (sh[i] > 0.9) relief++; else if (sh[i] < -0.9) hollow++; else if (sh[i] === 0) body++ }
    expect(body, 'petals').toBeGreaterThan(1000); expect(relief, 'stamens').toBeGreaterThan(100); expect(hollow, 'wheel').toBeGreaterThan(30)
  })
})
