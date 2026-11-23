/**
 * Télécommande : ce que la tablette ou le téléphone envoie à l'application ouverte sur le PC, et le calcul
 * des positions. Le PC revalide tout ce qui arrive (`parse`) : rien n'est cru sur parole.
 */

export type Msg =
  /** pointeur dans la vue du PC (0..1 depuis le coin haut gauche), posé ou non ; pression du stylet, −1 sans stylet ;
   *  `c` : en levant, jeter le trait (c'était un toucher ou le début d'un geste à deux doigts) */
  | { t: 'ptr'; x: number; y: number; d: boolean; p: number; c: boolean }
  /** toucher bref : choisir l'objet sous le pointeur */
  | { t: 'tap'; x: number; y: number }
  /** manier l'espace : glisser (en largeurs de vue), zoom autour de (cx, cy), pivoter, tourner ; `end` clôt le geste */
  | { t: 'nav'; dx: number; dy: number; s: number; r: number; yaw: number; pitch: number; cx: number; cy: number; end: boolean }
  /** pose de l'appareil : cap et inclinaison en radians (`on: false` : le gyroscope est coupé) */
  | { t: 'gyro'; on: boolean; h: number; tilt: number }
  | { t: 'cmd'; name: 'undo' | 'redo' | 'fit' | 'recenter' | 'delete' }
  | { t: 'cmd'; name: 'plane' | 'tool'; data: string }
  | { t: 'cmd'; name: 'zoom'; data: number }
  | { t: 'cmd'; name: 'orbit'; data: [number, number] }

/** Ce que le PC annonce à la télécommande : proportions de sa vue, outil en cours, liste des outils. */
export interface Hello { t: 'hello'; aspect: number; tool: string; tools: { id: string; icon: string; label: string }[] }

const clamp = (lo: number, hi: number, v: number) => Math.min(hi, Math.max(lo, v))
const num = (v: unknown, lo: number, hi: number): number | null => typeof v === 'number' && Number.isFinite(v) ? clamp(lo, hi, v) : null
const or = (v: unknown, lo: number, hi: number, dflt: number) => num(v, lo, hi) ?? dflt
const word = (v: unknown): string | null => typeof v === 'string' && /^[a-z0-9-]{1,16}$/.test(v) ? v : null
const SIMPLE = ['undo', 'redo', 'fit', 'recenter', 'delete'] as const

/** Un message reçu du réseau, remis dans les bornes ; `null` s'il n'est pas reconnu. */
export function parse(raw: unknown): Msg | null {
  let m: any = raw
  if (typeof raw === 'string') { if (raw.length > 400) return null; try { m = JSON.parse(raw) } catch { return null } }
  if (!m || typeof m !== 'object') return null
  switch (m.t) {
    case 'ptr': case 'tap': {
      const x = num(m.x, 0, 1), y = num(m.y, 0, 1); if (x === null || y === null) return null
      return m.t === 'tap' ? { t: 'tap', x, y } : { t: 'ptr', x, y, d: m.d === true, p: or(m.p, -1, 1, -1), c: m.c === true }
    }
    case 'nav': return {
      t: 'nav', dx: or(m.dx, -1, 1, 0), dy: or(m.dy, -1, 1, 0), s: or(m.s, 0.5, 2, 1), r: or(m.r, -1, 1, 0),
      yaw: or(m.yaw, -1, 1, 0), pitch: or(m.pitch, -1, 1, 0), cx: or(m.cx, 0, 1, 0.5), cy: or(m.cy, 0, 1, 0.5), end: m.end === true,
    }
    case 'gyro': {
      if (m.on !== true) return { t: 'gyro', on: false, h: 0, tilt: 0 }
      const h = num(m.h, -7, 7), tilt = num(m.tilt, -1.6, 1.6)
      return h === null || tilt === null ? null : { t: 'gyro', on: true, h, tilt }
    }
    case 'cmd': {
      if ((SIMPLE as readonly string[]).includes(m.name)) return { t: 'cmd', name: m.name }
      if (m.name === 'plane' || m.name === 'tool') { const data = word(m.data); return data ? { t: 'cmd', name: m.name, data } : null }
      if (m.name === 'zoom') { const data = num(m.data, 0.5, 2); return data === null ? null : { t: 'cmd', name: 'zoom', data } }
      if (m.name === 'orbit' && Array.isArray(m.data)) { const a = num(m.data[0], -1.6, 1.6), b = num(m.data[1], -1.6, 1.6); return a === null || b === null ? null : { t: 'cmd', name: 'orbit', data: [a, b] } }
      return null
    }
  }
  return null
}

/** L'annonce du PC, lue côté télécommande. */
export function parseHello(raw: unknown): Hello | null {
  let m: any = raw
  if (typeof raw === 'string') { try { m = JSON.parse(raw) } catch { return null } }
  if (!m || m.t !== 'hello') return null
  const aspect = num(m.aspect, 0.2, 5); if (aspect === null) return null
  const tools = (Array.isArray(m.tools) ? m.tools : []).filter((t: any) => t && typeof t.id === 'string' && typeof t.icon === 'string' && typeof t.label === 'string').slice(0, 16)
    .map((t: any) => ({ id: t.id, icon: t.icon, label: t.label }))
  return { t: 'hello', aspect, tool: typeof m.tool === 'string' ? m.tool : '', tools }
}

export interface Rect { x: number; y: number; w: number; h: number }

/** Le cadre de la vue du PC inscrit dans la surface tactile, aux mêmes proportions : un cercle tracé reste un cercle. */
export function padRect(w: number, h: number, aspect: number): Rect {
  const rw = Math.min(w, h * aspect), rh = rw / aspect
  return { x: (w - rw) / 2, y: (h - rh) / 2, w: rw, h: rh }
}

/** Un point de la surface tactile, ramené dans la vue du PC (0..1). Hors du cadre : collé au bord. */
export const padToView = (px: number, py: number, r: Rect) => ({ x: clamp(0, 1, (px - r.x) / r.w), y: clamp(0, 1, (py - r.y) / r.h) })

/** Souris : le curseur avance comme le doigt, de la même distance en largeur et en hauteur sur l'écran du PC.
 *  `gain` : largeurs de vue parcourues pour une largeur de pavé. */
export function moveCursor(cur: { x: number; y: number }, dx: number, dy: number, padW: number, aspect: number, gain = 1.5) {
  const k = gain / Math.max(1, padW)
  return { x: clamp(0, 1, cur.x + dx * k), y: clamp(0, 1, cur.y + dy * k * aspect) }
}
