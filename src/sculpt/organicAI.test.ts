/** The AI layer must never be able to push the generator into an invalid state, and the
 *  local fallback must stay useful with no key and no network. */
import { describe, it, expect } from 'vitest'
import { textToOrganic, sanitiseOrganic, sanitiseLook, organicApiError, PALETTES } from './organicAI'
import { buildOrganic, ORG_DEFAULTS, type OrganicParams } from './organic'

describe('sanitiseOrganic : hostile / sloppy model output', () => {
  it('clamps out-of-range numbers into the generator\'s safe bounds', () => {
    const s = sanitiseOrganic({ poreCount: 999, poreRows: -4, poreSize: 12, shell: -1, res: 100000, twist: 42, blend: 5, noiseAmp: 9 })
    expect(s.poreCount).toBeLessThanOrEqual(12)
    expect(s.poreRows).toBeGreaterThanOrEqual(1)
    expect(s.poreSize).toBeLessThanOrEqual(0.32)
    expect(s.shell).toBeGreaterThanOrEqual(0)
    expect(s.res).toBeLessThanOrEqual(160)   // plafond du marching cubes
    expect(Math.abs(s.twist!)).toBeLessThanOrEqual(3.5)
    expect(s.blend).toBeLessThanOrEqual(0.22)
    expect(s.noiseAmp).toBeLessThanOrEqual(0.09)
  })
  it('drops unknown enums, NaN and junk instead of passing them through', () => {
    const s = sanitiseOrganic({ form: 'banane' as never, pore: 'lol' as never, noiseType: 'x' as never, poreSize: NaN, twist: Infinity, mirror: 'yes' as never })
    expect(s.form).toBeUndefined(); expect(s.pore).toBeUndefined(); expect(s.noiseType).toBeUndefined()
    expect(s.poreSize).toBeUndefined(); expect(s.twist).toBeUndefined(); expect(s.mirror).toBeUndefined()
  })
  it('tempers pore COMBINATIONS so an extreme payload never yields an empty scene', () => {
    // Chaque valeur peut être valide et l'ensemble tout dissoudre : ouvertures plus larges
    // que leur espacement → le corps est sectionné et le maillage sort vide.
    const s = sanitiseOrganic({ poreCount: 999, poreSize: 99, shell: -3, res: 9999, blend: 88 })
    const spacing = (Math.PI * ORG_DEFAULTS.poreRadius) / 12
    expect(s.poreSize!, 'pore size not tempered against spacing').toBeLessThanOrEqual(Math.max(0.05, spacing * 0.95) + 1e-9)
    const g = buildOrganic({ ...ORG_DEFAULTS, ...s, res: 36 } as OrganicParams)
    expect(g.getAttribute('position').count, 'tempered payload still meshed to nothing').toBeGreaterThan(0)
  })
  it('null / undefined are handled', () => {
    expect(sanitiseOrganic(null)).toEqual({}); expect(sanitiseOrganic(undefined)).toEqual({})
  })
})

describe('textToOrganic : local deterministic fallback', () => {
  const cases: [string, Partial<OrganicParams>][] = [
    ['une urne en dentelle ajourée', { form: 'lyre', pore: 'boucles' }],
    ['structure d\'os trabéculaire', { pore: 'lattice' }],
    ['un corail alvéolaire', { pore: 'cellules' }],
    ['un totem très torsadé', { form: 'colonne' }],
    ['un ruban chromé massif et poli', { form: 'ruban', pore: 'aucun' }],
  ]
  for (const [prompt, want] of cases) {
    it(`"${prompt}" → ${JSON.stringify(want)}`, () => {
      const { params } = textToOrganic(prompt)
      for (const [k, v] of Object.entries(want)) expect(params[k as keyof OrganicParams], `${prompt}: ${k}`).toBe(v)
    })
  }
  it('"torsadé" sets a twist, "effilé" a taper', () => {
    expect(Math.abs(textToOrganic('forme torsadée').params.twist ?? 0)).toBeGreaterThan(0.5)
    expect(Math.abs(textToOrganic('forme effilée en pointe').params.taper ?? 0)).toBeGreaterThan(0.1)
  })
  it('an empty prompt still yields a complete, meshable random variation', () => {
    const { params, explain } = textToOrganic('', 1234)
    expect(explain).toContain('aléatoire')
    expect(params.form).toBeDefined(); expect(params.pore).toBeDefined()
    expect(buildOrganic({ ...ORG_DEFAULTS, ...params, res: 36 } as OrganicParams).getAttribute('position').count).toBeGreaterThan(0)
  })
  it('is deterministic for a given seed, and varies across seeds', () => {
    expect(textToOrganic('', 7).params).toEqual(textToOrganic('', 7).params)
    expect(textToOrganic('', 7).params).not.toEqual(textToOrganic('', 99).params)
  })
})

describe('failure diagnosis : the artist must learn the CAUSE, not just "unavailable"', () => {
  it('names the fix for each status', () => {
    expect(organicApiError(401)).toMatch(/admin/)
    expect(organicApiError(403)).toMatch(/admin/)
    expect(organicApiError(503)).toMatch(/clé|cle/i)
    expect(organicApiError(429)).toMatch(/requêtes|minute/)
    expect(organicApiError(404)).toMatch(/dev|endpoint/)
    expect(organicApiError(0)).toMatch(/réseau/)
  })
  it('falls back to the server message for unexpected statuses', () => {
    expect(organicApiError(500, 'boom')).toBe('boom')
    expect(organicApiError(500)).toMatch(/500/)
  })
})

describe('matched flag : never present randomness as understanding', () => {
  it('is true when a keyword drove the result', () => {
    expect(textToOrganic('une urne ajourée').matched).toBe(true)
    expect(textToOrganic('os trabéculaire').matched).toBe(true)
  })
  it('is false when nothing was recognised', () => {
    expect(textToOrganic('zzzz qwerty 12345').matched).toBe(false)
    expect(textToOrganic('').matched).toBe(false)
  })
  it('understands added vocabulary (en + fr synonyms)', () => {
    expect(textToOrganic('a bone sponge').params.pore).toBe('lattice')
    expect(textToOrganic('coral cellular').params.pore).toBe('cellules')
    expect(textToOrganic('lace skeleton').params.pore).toBe('boucles')
    expect(textToOrganic('polished chrome solid').params.pore).toBe('aucun')
    expect(textToOrganic('une stèle verticale').params.form).toBe('colonne')
    expect(textToOrganic('un cocon').params.form).toBe('ovoide')
  })
})

describe('generation progress', () => {
  it('buildOrganic reports monotonic progress ending at 1', () => {
    const seen: number[] = []
    buildOrganic({ ...ORG_DEFAULTS, res: 40 }, (t) => seen.push(t))
    expect(seen.length, 'no progress reported').toBeGreaterThan(3)
    expect(seen[seen.length - 1]).toBe(1)
    for (let i = 1; i < seen.length; i++) expect(seen[i], 'progress went backwards').toBeGreaterThanOrEqual(seen[i - 1])
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...seen)).toBeLessThanOrEqual(1)
  })
})

describe('ornament, surface perforations and look : the wider vocabulary of the assistant', () => {
  it('clamps the new numeric fields and drops unknown reliefs', () => {
    const s = sanitiseOrganic({ relief: 'plumes' as never, reliefDensity: 7, reliefHeight: 9, reliefSize: -3, poreJitter: 4, open: 5, seed: 1e9, petals: 99, curl: -2, stamens: 500 })
    expect(s.relief).toBeUndefined()
    expect(s.reliefDensity).toBe(1); expect(s.reliefHeight).toBe(0.3); expect(s.reliefSize).toBe(0)
    expect(s.poreJitter).toBe(1); expect(s.open).toBe(0.7); expect(s.seed).toBe(9999)
    expect(s.petals).toBe(16); expect(s.curl).toBe(0); expect(s.stamens).toBe(40)
  })
  it('never lets the model pick « ma forme » (it needs a source mesh)', () => {
    expect(sanitiseOrganic({ form: 'mesh' }).form).toBeUndefined()
    expect(sanitiseOrganic({ form: 'fleur', pore: 'alveoles', relief: 'polypes' })).toEqual({ form: 'fleur', pore: 'alveoles', relief: 'polypes' })
  })
  it('sanitiseLook keeps hex colours, a known material and a boolean — nothing else', () => {
    expect(sanitiseLook({ material: 'email', colorA: '#12ABef', colorB: 'red', colorC: 'url(javascript:1)', lamp: 'yes', extra: 1 })).toEqual({ material: 'email', colorA: '#12abef' })
    expect(sanitiseLook({ material: 'kryptonite', lamp: true })).toEqual({ lamp: true })
    expect(sanitiseLook(null)).toEqual({}); expect(sanitiseLook('x')).toEqual({})
  })
  const cases: [string, Partial<OrganicParams>][] = [
    ['une fleur mécanique à pétales en ruban', { form: 'fleur', pore: 'aucun' }],
    ["un oursin hérissé d'épines", { form: 'ovoide', relief: 'epines', pore: 'aucun' }],
    ["une goutte couverte d'anémones", { form: 'goutte', relief: 'rosettes' }],
    ['dôme de balanes en porcelaine', { form: 'dome', relief: 'polypes' }],
    ['vase à écailles torsadé', { form: 'lyre', relief: 'ecailles' }],
    ["lampe en nid d'abeille", { pore: 'alveoles' }],
    ['abat-jour en résille de losanges', { pore: 'resille' }],
    ['gourde cannelée', { form: 'gourde', relief: 'cannelures' }],
    ['corail cerveau en méandres', { relief: 'meandres' }],
    ['panneau érodé', { form: 'dalle', pore: 'cellules' }],
  ]
  for (const [prompt, want] of cases) {
    it(`"${prompt}" → ${JSON.stringify(want)}, and it meshes`, () => {
      const { params, matched } = textToOrganic(prompt)
      expect(matched).toBe(true)
      for (const [k, v] of Object.entries(want)) expect(params[k as keyof OrganicParams], `${prompt}: ${k}`).toBe(v)
      expect(buildOrganic({ ...ORG_DEFAULTS, relief: 'aucun', mirror: false, ...params, res: 40 } as OrganicParams).getAttribute('position').count).toBeGreaterThan(0)
    })
  }
  it('« lampe » turns the inner light on ; a colour word picks a glaze', () => {
    expect(textToOrganic("une lampe en nid d'abeille").look.lamp).toBe(true)
    const reef = PALETTES.find((p) => p.name === 'Récif')!
    expect(textToOrganic('émail turquoise').look).toMatchObject({ colorA: reef.a, colorB: reef.b, colorC: reef.c })
    expect(textToOrganic('une urne ajourée').look).toEqual({})
  })
  it('every random draw (40 seeds) is a complete, meshable piece with a glaze', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { params, look } = textToOrganic('', seed)
      expect(look.colorA).toMatch(/^#[0-9a-f]{6}$/)
      const g = buildOrganic({ ...ORG_DEFAULTS, ...params, res: 36 } as OrganicParams)
      expect(g.getAttribute('position').count, `seed ${seed}: empty (${JSON.stringify(params)})`).toBeGreaterThan(100)
    }
  })
})
