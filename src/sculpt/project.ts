/**
 * Project save / load for the sculpture studio.
 *
 * A project stores the PARAMETERS, not the mesh: the generator is deterministic, so the
 * form is reproduced exactly on load while the file stays a few hundred bytes. The one
 * exception is the source mesh of « Ma forme » — that cannot be regenerated, so it travels
 * with the project (and is what makes a file large).
 *
 * Two destinations: the browser (localStorage, for quick iteration) and a .json file
 * (portable, backup-able). Both share the same versioned envelope, and loading validates
 * everything through the same sanitiser used for AI output — a hand-edited or stale file
 * can never push the generator into an invalid state.
 */
import { ORG_DEFAULTS, type OrganicParams } from './organic'
import { sanitiseOrganic } from './organicAI'
import type { MeshData } from '../morpho/imports'

export const PROJECT_VERSION = 1
const KEY_PREFIX = 'anima:sculpt:project:'   // préfixe historique conservé (cf. renommage DigiArt)

export interface SculptProject {
  version: number
  name: string
  savedAt: string
  org: OrganicParams
  orgSmooth: number
  mainOnly: boolean
  material: string
  colorA: string
  sourceName?: string
  source?: MeshData | null
}

export interface ProjectMeta { name: string; savedAt: string; bytes: number; hasSource: boolean }

/** Build a project envelope from the current studio state. */
export function makeProject(name: string, s: Omit<SculptProject, 'version' | 'name' | 'savedAt'>): SculptProject {
  return { version: PROJECT_VERSION, name: name.trim() || 'sans-titre', savedAt: new Date().toISOString(), ...s }
}

/** Validate + coerce anything claiming to be a project. Returns null if unusable. */
export function parseProject(raw: unknown): SculptProject | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Partial<SculptProject>
  if (typeof o.org !== 'object' || !o.org) return null
  // Même assainissement que la sortie du modèle : un fichier bricolé ne casse rien.
  const org: OrganicParams = { ...ORG_DEFAULTS, ...sanitiseOrganic(o.org as Partial<OrganicParams>) }
  if (typeof o.org.form === 'string') org.form = o.org.form as OrganicParams['form']
  if (typeof o.org.pore === 'string') org.pore = o.org.pore as OrganicParams['pore']
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  return {
    version: num(o.version, PROJECT_VERSION),
    name: typeof o.name === 'string' && o.name.trim() ? o.name : 'sans-titre',
    savedAt: typeof o.savedAt === 'string' ? o.savedAt : new Date(0).toISOString(),
    org,
    orgSmooth: Math.max(0, Math.min(6, Math.round(num(o.orgSmooth, 1)))),
    mainOnly: o.mainOnly === true,
    material: typeof o.material === 'string' ? o.material : 'clay',
    colorA: typeof o.colorA === 'string' ? o.colorA : '#c8794a',
    sourceName: typeof o.sourceName === 'string' ? o.sourceName : undefined,
    source: o.source && Array.isArray((o.source as MeshData).pos) ? (o.source as MeshData) : null,
  }
}

// ── Navigateur (localStorage) ──────────────────────────────────────────────
export function listProjects(): ProjectMeta[] {
  const out: ProjectMeta[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k || !k.startsWith(KEY_PREFIX)) continue
      const v = localStorage.getItem(k) ?? ''
      try {
        const p = JSON.parse(v) as SculptProject
        out.push({ name: p.name ?? k.slice(KEY_PREFIX.length), savedAt: p.savedAt ?? '', bytes: v.length, hasSource: !!p.source })
      } catch { /* entrée illisible : ignorée */ }
    }
  } catch { /* localStorage indisponible */ }
  return out.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1))
}

/** Returns an error message, or null on success. */
export function saveProject(p: SculptProject): string | null {
  try {
    localStorage.setItem(KEY_PREFIX + p.name, JSON.stringify(p))
    return null
  } catch (e) {
    // Le cas fréquent : un maillage source volumineux dépasse le quota (~5 Mo).
    const quota = (e as { name?: string })?.name === 'QuotaExceededError'
    return quota
      ? 'Quota du navigateur dépassé — la forme source est trop lourde. Exporte en .json à la place.'
      : `Sauvegarde impossible : ${(e as Error).message}`
  }
}

export function loadProject(name: string): SculptProject | null {
  try { const v = localStorage.getItem(KEY_PREFIX + name); return v ? parseProject(JSON.parse(v)) : null } catch { return null }
}

export function deleteProject(name: string): void {
  try { localStorage.removeItem(KEY_PREFIX + name) } catch { /* noop */ }
}

// ── Fichier ────────────────────────────────────────────────────────────────
export function projectToBlob(p: SculptProject): Blob {
  return new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' })
}
export async function projectFromFile(f: File): Promise<SculptProject> {
  const p = parseProject(JSON.parse(await f.text()))
  if (!p) throw new Error('Fichier de projet illisible ou incompatible')
  return p
}
