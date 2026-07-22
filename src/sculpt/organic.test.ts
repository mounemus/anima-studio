/** Organic-parametric generator : the field composition and marching-cubes meshing are pure
 *  math — verify off-browser that every form/perforation/preset yields a real, sane mesh. */
import { describe, it, expect } from 'vitest'
import { buildOrganic, organicField, formField, poreField, ORG_DEFAULTS, ORG_FORMS, ORG_PORES, ORG_PRESETS, ORG_BOUND, type OrganicParams } from './organic'

const P = (o: Partial<OrganicParams> = {}): OrganicParams => ({ ...ORG_DEFAULTS, ...o })
const tris = (g: ReturnType<typeof buildOrganic>) => g.getAttribute('position').count / 3
const nan = (g: ReturnType<typeof buildOrganic>) => { const a = g.getAttribute('position').array as ArrayLike<number>; let n = 0; for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) n++; return n }
const extent = (g: ReturnType<typeof buildOrganic>) => { const a = g.getAttribute('position').array as ArrayLike<number>; let m = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i]) > m) m = Math.abs(a[i]); return m }

describe('organic : base forms', () => {
  for (const f of ORG_FORMS) {
    it(`${f.kind}: field is negative inside, positive far outside`, () => {
      const fld = formField(f.kind)
      expect(fld(3, 3, 3), `${f.kind}: not positive far away`).toBeGreaterThan(0)
      // at least one sample inside the unit box must be inside the solid
      let inside = 0
      for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) for (let k = 0; k < 12; k++) {
        const x = (i / 11 - 0.5) * 1.6, y = (j / 11 - 0.5) * 1.8, z = (k / 11 - 0.5) * 1.6
        if (fld(x, y, z) < 0) inside++
      }
      expect(inside, `${f.kind}: empty solid`).toBeGreaterThan(10)
    })
  }
})

describe('organic : perforation opens the solid', () => {
  it('a pore field exists for every mode except "aucun"', () => {
    for (const p of ORG_PORES) {
      const f = poreField(P({ pore: p.kind }))
      if (p.kind === 'aucun') expect(f).toBeNull()
      else expect(f, `${p.kind}: no pore field`).not.toBeNull()
    }
  })
  it('perforating REMOVES material (fewer inside samples than the solid body)', () => {
    const solid = organicField(P({ pore: 'aucun', shell: 0, mirror: false }))
    const holed = organicField(P({ pore: 'boucles', shell: 0, mirror: false }))
    const count = (fl: ReturnType<typeof organicField>) => { let n = 0; for (let i = 0; i < 22; i++) for (let j = 0; j < 22; j++) for (let k = 0; k < 22; k++) { const x = (i / 21 - 0.5) * 2 * ORG_BOUND, y = (j / 21 - 0.5) * 2 * ORG_BOUND, z = (k / 21 - 0.5) * 2 * ORG_BOUND; if (fl(x, y, z) < 0) n++ } return n }
    const cs = count(solid), ch = count(holed)
    expect(cs, 'solid body is empty').toBeGreaterThan(50)
    expect(ch, 'perforation removed nothing').toBeLessThan(cs)
  })
  it('a hollow shell has less material than the solid it came from', () => {
    const count = (fl: ReturnType<typeof organicField>) => { let n = 0; for (let i = 0; i < 22; i++) for (let j = 0; j < 22; j++) for (let k = 0; k < 22; k++) { const x = (i / 21 - 0.5) * 2 * ORG_BOUND, y = (j / 21 - 0.5) * 2 * ORG_BOUND, z = (k / 21 - 0.5) * 2 * ORG_BOUND; if (fl(x, y, z) < 0) n++ } return n }
    expect(count(organicField(P({ pore: 'aucun', shell: 0.055 })))).toBeLessThan(count(organicField(P({ pore: 'aucun', shell: 0 }))))
  })
})

describe('organic : meshing', () => {
  for (const preset of ORG_PRESETS) {
    it(`preset "${preset.name}" meshes to a real, NaN-free surface`, () => {
      const g = buildOrganic(P({ ...preset.params, res: 40 }))
      expect(tris(g), `${preset.name}: empty mesh`).toBeGreaterThan(120)
      expect(nan(g), `${preset.name}: NaN vertices`).toBe(0)
      expect(extent(g), `${preset.name}: escaped the bound`).toBeLessThanOrEqual(ORG_BOUND + 1e-3)
    })
  }
  it('deformers change the geometry (twist actually twists)', () => {
    const a = buildOrganic(P({ twist: 0, res: 36 })), b = buildOrganic(P({ twist: 2.2, res: 36 }))
    const arr = (g: ReturnType<typeof buildOrganic>) => Array.from(g.getAttribute('position').array as ArrayLike<number>)
    const A = arr(a), B = arr(b)
    expect(A.length, 'twist emptied the mesh').toBeGreaterThan(0)
    expect(B.length, 'twist emptied the mesh').toBeGreaterThan(0)
    const same = A.length === B.length && A.every((v, i) => Math.abs(v - B[i]) < 1e-6)
    expect(same, 'twist had no effect').toBe(false)
  })
  it('higher resolution yields a finer mesh', () => {
    expect(tris(buildOrganic(P({ res: 56 })))).toBeGreaterThan(tris(buildOrganic(P({ res: 32 }))))
  })
})
