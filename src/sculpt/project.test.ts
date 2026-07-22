/** Projects store parameters, not meshes — so a round trip must reproduce the exact form,
 *  and a stale or hand-edited file must never poison the generator. */
import { describe, it, expect, beforeEach } from 'vitest'
import { makeProject, parseProject, saveProject, loadProject, listProjects, deleteProject, projectToBlob, PROJECT_VERSION } from './project'
import { buildOrganic, ORG_DEFAULTS, type OrganicParams } from './organic'

const state = (org: Partial<OrganicParams> = {}) => ({
  org: { ...ORG_DEFAULTS, ...org }, orgSmooth: 2, mainOnly: true, material: 'chrome', colorA: '#112233',
})

beforeEach(() => { for (const p of listProjects()) deleteProject(p.name) })

describe('round trip', () => {
  it('save → load restores every field', () => {
    const p = makeProject('essai', state({ form: 'colonne', pore: 'grille', twist: 1.4, res: 88 }))
    expect(saveProject(p)).toBeNull()
    const back = loadProject('essai')!
    expect(back).not.toBeNull()
    expect(back.org.form).toBe('colonne')
    expect(back.org.pore).toBe('grille')
    expect(back.org.twist).toBeCloseTo(1.4, 6)
    expect(back.org.res).toBe(88)
    expect(back.orgSmooth).toBe(2)
    expect(back.mainOnly).toBe(true)
    expect(back.material).toBe('chrome')
    expect(back.colorA).toBe('#112233')
  })
  it('the reloaded parameters rebuild the IDENTICAL geometry', () => {
    const p = makeProject('geo', state({ form: 'ovoide', pore: 'grille', poreCount: 7, res: 40 }))
    saveProject(p)
    const back = loadProject('geo')!
    const a = buildOrganic({ ...p.org, res: 40 }).getAttribute('position').array as Float32Array
    const b = buildOrganic({ ...back.org, res: 40 }).getAttribute('position').array as Float32Array
    expect(b.length).toBe(a.length)
    for (let i = 0; i < a.length; i++) expect(b[i]).toBe(a[i])
  })
  it('listProjects reports what was saved, newest first', () => {
    saveProject({ ...makeProject('vieux', state()), savedAt: '2020-01-01T00:00:00.000Z' })
    saveProject({ ...makeProject('recent', state()), savedAt: '2030-01-01T00:00:00.000Z' })
    const l = listProjects()
    expect(l.map((x) => x.name)).toEqual(['recent', 'vieux'])
    expect(l[0].bytes).toBeGreaterThan(0)
  })
  it('delete removes it', () => {
    saveProject(makeProject('jetable', state()))
    expect(listProjects()).toHaveLength(1)
    deleteProject('jetable')
    expect(listProjects()).toHaveLength(0)
  })
})

describe('parseProject : hostile / stale input', () => {
  it('rejects junk', () => {
    expect(parseProject(null)).toBeNull()
    expect(parseProject(42)).toBeNull()
    expect(parseProject({})).toBeNull()
    expect(parseProject({ org: null })).toBeNull()
  })
  it('clamps out-of-range values from a hand-edited file', () => {
    const p = parseProject({ org: { ...ORG_DEFAULTS, poreCount: 9999, res: 99999, twist: 50 }, orgSmooth: 99 })!
    expect(p.org.poreCount).toBeLessThanOrEqual(12)
    expect(p.org.res).toBeLessThanOrEqual(140)
    expect(Math.abs(p.org.twist)).toBeLessThanOrEqual(3.5)
    expect(p.orgSmooth).toBeLessThanOrEqual(6)
  })
  it('a file missing optional fields still loads with sane defaults', () => {
    const p = parseProject({ org: { form: 'tore' } })!
    expect(p.org.form).toBe('tore')
    expect(p.version).toBe(PROJECT_VERSION)
    expect(p.material).toBe('clay')
    expect(p.mainOnly).toBe(false)
    expect(buildOrganic({ ...p.org, res: 32 }).getAttribute('position').count).toBeGreaterThan(0)
  })
  it('a sanitised project always still meshes', () => {
    const p = parseProject({ org: { poreCount: 9999, poreSize: 9999, shell: -5, res: 9999 } })!
    expect(buildOrganic({ ...p.org, res: 32 }).getAttribute('position').count).toBeGreaterThan(0)
  })
})

describe('file export', () => {
  it('produces JSON that parses back into the same project', async () => {
    const p = makeProject('fichier', state({ form: 'ruban' }))
    const text = await projectToBlob(p).text()
    const back = parseProject(JSON.parse(text))!
    expect(back.name).toBe('fichier')
    expect(back.org.form).toBe('ruban')
  })
})
