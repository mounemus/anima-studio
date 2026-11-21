/**
 * Leap Motion comme source de mains, en alternative à la caméra, pour tous les ateliers.
 *
 * Se branche sur le service Leap local (protocole WebSocket leapd `v6.json` : Leap Motion
 * V2 / Orion V4 avec « Autoriser les applications Web » ; Gemini et Hyperion passent par
 * le pont `public/leap-bridge/leap_bridge.py`). Chaque trame est convertie au format que
 * les ateliers lisent déjà chez MediaPipe : 21 jalons par main en coordonnées image 0..1
 * (non miroir, comme une webcam) + un geste classé (`Closed_Fist`, `Open_Palm`…).
 *
 * Pour que la profondeur se comporte comme avec la webcam (main plus proche = plus
 * grande), les points 3D du capteur sont projetés par une caméra virtuelle placée à
 * l'écran. Les millimètres réels restent disponibles dans `frame.leap` pour qui veut du
 * vrai 3D (atelier Esquisse spatiale).
 *
 * `pollHands()` est le point d'entrée unique des boucles d'atelier : Leap s'il est
 * connecté, sinon le modèle caméra.
 */
import { useSyncExternalStore } from 'react'

export interface V3 { x: number; y: number; z: number }
export interface LeapHand {
  type: 'left' | 'right'
  /** Point de pince (milieu pouce-index) et paume, en mm, repère « bureau » :
   *  x à droite, y vers le haut (≈ 200 au centre), z vers l'utilisateur. */
  pinchMm: V3
  palmMm: V3
  normal: V3
  direction: V3
  pinch: number      // 0..1
  grab: number       // 0..1 (poing)
  extended: boolean[]  // pouce → auriculaire
}
export interface HandFrame {
  landmarks: V3[][]
  /** Caméra seulement : jalons 3D de MediaPipe, en mètres, centrés sur la main. */
  worldLandmarks?: V3[][]
  gestures: { categoryName: string; score: number }[][]
  /** Présent seulement quand la trame vient du Leap (même ordre que `landmarks`). */
  leap?: LeapHand[]
}

export interface LeapSettings {
  url: string
  /** Où est le capteur : à plat sur le bureau, fixé à l'écran face à l'utilisateur, ou sur un casque, sur la tête. */
  placement: 'desk' | 'screen' | 'head'
  /** Capteur monté dans l'autre sens (tourné d'un demi-tour sur lui-même, câble de l'autre côté). */
  flip: boolean
  /** Largeur de la zone des mains (mm) qui remplit la largeur de l'écran. */
  span: number
  /** Hauteur de la webcam au-dessus du capteur (mm) : centre vertical de l'image. */
  height: number
  /** Se reconnecter tout seul à l'ouverture d'un atelier. */
  auto: boolean
  /** Caler en continu la projection du Leap sur la main vue par la webcam. */
  autoCal: boolean
  /** Caméra calée (mesurée sur la webcam). `null` : caméra par défaut déduite de `span` et `height`. */
  cal: LeapCal | null
}
/** Webcam vue depuis le repère du Leap : position (mm), focale (en largeurs d'image) et
 *  inclinaison (radians ; `pitch` > 0 = caméra penchée vers le bas, `yaw` = tournée). */
export interface LeapCal { cx: number; cy: number; cz: number; f: number; pitch: number; yaw: number }
export const LEAP_DEFAULTS: LeapSettings = { url: 'ws://127.0.0.1:6437/v6.json', placement: 'desk', flip: false, span: 700, height: 360, auto: false, autoCal: true, cal: null }
const KEY = 'digiart:leap'
const CAL_KEYS = ['cx', 'cy', 'cz', 'f', 'pitch', 'yaw'] as const

function loadSettings(): LeapSettings {
  try {
    const s = { ...LEAP_DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }
    if (!(s.cal && !Array.isArray(s.cal) && CAL_KEYS.every((k) => Number.isFinite(s.cal[k])))) s.cal = null   // calage d'une ancienne version
    return s
  } catch { return { ...LEAP_DEFAULTS } }
}
let settings = loadSettings()

export type LeapStatus = 'off' | 'connecting' | 'on' | 'error'
interface View { status: LeapStatus; message: string; settings: LeapSettings; fit: { n: number; err: number } }
let view: View = { status: 'off', message: '', settings, fit: { n: 0, err: 0 } }
const subs = new Set<() => void>()
const frameSubs = new Set<(f: HandFrame) => void>()
const S = { ws: null as WebSocket | null, raw: null as any, seq: 0, connected: false, lastAt: 0, watch: 0 as any, aspect: 0, speed: 0, palm: null as number[] | null }

function publish(patch: Partial<View>) { view = { ...view, ...patch }; subs.forEach((f) => f()) }

export function setLeapSettings(patch: Partial<LeapSettings>) {
  // changer la caméra par défaut (zone, hauteur, emplacement) repart d'un calage neuf
  if ('span' in patch || 'height' in patch || 'placement' in patch || 'flip' in patch) { patch = { ...patch, cal: null }; resetFit() }
  settings = { ...settings, ...patch }
  try { localStorage.setItem(KEY, JSON.stringify(settings)) } catch { /* stockage indisponible */ }
  publish({ settings })
}
/** Le Leap fournit-il des mains en ce moment ? Service joint ET trames reçues depuis moins d'une seconde :
 *  un service qui tourne sans capteur branché n'envoie rien, et ne doit pas couper le suivi caméra. */
export const leapConnected = () => S.connected && performance.now() - S.lastAt < 1000
export const leapSettings = () => settings
/** État pour l'interface (statut, message, réglages). */
export function useLeap(): View {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb) } }, () => view, () => view)
}
/** Appelé à chaque trame Leap (le flux principal s'en sert pour alimenter le SenseBus). */
export function onLeapFrame(cb: (f: HandFrame) => void) { frameSubs.add(cb); return () => { frameSubs.delete(cb) } }

// ───────────────────────── conversion d'une trame ─────────────────────────

const CENTER_Y = 200   // hauteur du centre de la zone au-dessus du capteur (mm)
const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const add = (a: V3, b: V3, k = 1): V3 => ({ x: a.x + b.x * k, y: a.y + b.y * k, z: a.z + b.z * k })
const lerp = (a: V3, b: V3, t: number): V3 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t })
const cross = (a: V3, b: V3): V3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x })

/** Repère du capteur → repère « bureau ». Capteur fixé à l'écran : sa normale (y) pointe
 *  vers l'utilisateur et son axe z vers le bas. */
function dir(a: any, s: LeapSettings): V3 | null {
  if (!Array.isArray(a) || a.length < 3 || !a.every(Number.isFinite)) return null
  const x = s.flip ? -a[0] : a[0], y = a[1], z = s.flip ? -a[2] : a[2]
  // Sur la tête : le dessus du capteur regarde devant soi, son grand bord « utilisateur » vers le bas. C'est
  // la convention du montage officiel sur casque : droite = −x, haut = −z, vers soi = −y.
  if (s.placement === 'head') return { x: -x, y: -z, z: -y }
  return s.placement === 'screen' ? { x, y: -z, z: y } : { x, y, z }
}
function pos(a: any, s: LeapSettings): V3 | null {
  const d = dir(a, s); if (!d) return null
  return s.placement === 'screen' ? { x: d.x, y: d.y + CENTER_Y, z: d.z - 250 } : d
}

const F_WEBCAM = 0.7   // focale typique d'une webcam d'ordinateur (champ horizontal ≈ 70°), en largeurs d'image

/** Caméra par défaut, réglable à la main : à l'écran, à l'horizontale, à la hauteur réglée, et à
 *  la distance où une zone large de `span` mm remplit l'image. */
export function priorCal(s: LeapSettings): LeapCal {
  // capteur sur la tête : la webcam est en face, à une soixantaine de centimètres, un peu plus bas que les yeux
  if (s.placement === 'head') return { cx: 0, cy: -60, cz: -600, f: F_WEBCAM, pitch: 0, yaw: 0 }
  return { cx: 0, cy: s.placement === 'screen' ? CENTER_Y : s.height, cz: -F_WEBCAM * Math.max(200, s.span), f: F_WEBCAM, pitch: 0, yaw: 0 }
}
export const calOf = (s: LeapSettings): LeapCal => s.cal ?? priorCal(s)

/** Position mm → coordonnées image 0..1 de la webcam (non miroir : la droite de l'utilisateur
 *  est à gauche de l'image, les ateliers font déjà `1 - x`). `k` = largeurs d'image par mm. */
export function project(p: V3, c: LeapCal, aspect: number) {
  const dx = p.x - c.cx, dy = p.y - c.cy, dz = p.z - c.cz
  const cw = Math.cos(c.yaw), sw = Math.sin(c.yaw), cp = Math.cos(c.pitch), sp = Math.sin(c.pitch)
  const x1 = dx * cw - dz * sw, z1 = dx * sw + dz * cw
  const y2 = dy * cp + z1 * sp, k = c.f / Math.max(60, -dy * sp + z1 * cp)
  return { x: 0.5 - k * x1, y: 0.5 - k * aspect * y2, k }
}
/** Largeurs d'image par millimètre, pour une main au-dessus du capteur (échelle de la profondeur). */
export const leapWidthPerMm = () => project(settings.placement === 'head' ? { x: 0, y: -100, z: -350 } : { x: 0, y: 250, z: 0 }, calOf(settings), 1).k

/** Un doigt Leap → 4 jalons MediaPipe (mcp, pip, dip, tip ; pouce : cmc, mcp, ip, tip).
 *  Les services anciens donnent les articulations ; le pont ne donne que le bout : on
 *  reconstruit alors les articulations depuis la paume (les jointures y sont rigides). */
function fingerJoints(f: any, knuckle: V3, s: LeapSettings): V3[] {
  const tip = pos(f.tipPosition, s) ?? pos(f.btipPosition, s) ?? knuckle
  const P: any[] | null = Array.isArray(f.positions) && f.positions.length >= 5 ? f.positions
    : f.mcpPosition ? [f.carpPosition, f.mcpPosition, f.pipPosition, f.dipPosition, f.btipPosition ?? f.tipPosition] : null
  if (P) return [P[1], P[2], P[3], P[4]].map((a) => pos(a, s) ?? tip)
  return [knuckle, lerp(knuckle, tip, 0.45), lerp(knuckle, tip, 0.75), tip]
}

// Jointures (mm) dans le repère de la paume : [vers les doigts, vers le pouce].
const KNUCKLES: [number, number][] = [[-22, 30], [38, 22], [42, 2], [38, -16], [30, -32]]

export function convertHand(h: any, pointables: any[], s: LeapSettings, aspect: number): { lm: V3[]; hand: LeapHand; pts: V3[]; full: boolean } | null {
  const fingers = pointables.filter((p) => p.handId === h.id && !p.tool && typeof p.type === 'number').sort((a, b) => a.type - b.type)
  const palm = pos(h.palmPosition, s)
  if (fingers.length < 5 || !palm) return null
  const direction = dir(h.direction, s) ?? { x: 0, y: 0, z: -1 }
  const normal = dir(h.palmNormal, s) ?? { x: 0, y: -1, z: 0 }
  const right = h.type !== 'left'
  const side = cross(direction, normal)          // vers le pouce pour une main droite
  const thumbward = right ? 1 : -1
  const wrist = pos(h.wrist, s) ?? add(palm, direction, -70)
  const pts: V3[] = [wrist]
  fingers.slice(0, 5).forEach((f, i) => {
    const k = add(add(palm, direction, KNUCKLES[i][0]), side, KNUCKLES[i][1] * thumbward)
    pts.push(...fingerJoints(f, k, s))
  })                                             // 1 + 5 × 4 = 21
  const cal = calOf(s)
  const lm = pts.map((p) => { const q = project(p, cal, aspect); return { x: q.x, y: q.y, z: (p.z - wrist.z) * q.k } })
  // le service donne-t-il les vraies articulations, ou seulement le bout des doigts ?
  const full = fingers.slice(0, 5).every((f) => !!f.mcpPosition || (Array.isArray(f.positions) && f.positions.length >= 5))
  const tT = pts[4], tI = pts[8]
  // Pince = distance réelle entre les bouts du pouce et de l'index (≤ 20 mm → 1, ≥ 50 mm → 0). Mesuré sur
  // le vrai capteur : pince fermée 13 à 23 mm, main ouverte 61 à 93 mm. `pinchStrength` du service n'est pas
  // fiable : souvent 0 en mode bureau, et il monte aussi quand un autre doigt touche le pouce.
  const byDist = clamp01(1 - (Math.hypot(tT.x - tI.x, tT.y - tI.y, tT.z - tI.z) - 20) / 30)
  return {
    lm, pts, full,
    hand: {
      type: right ? 'right' : 'left',
      pinchMm: lerp(tT, tI, 0.5), palmMm: palm, normal, direction,
      pinch: byDist,
      grab: clamp01(+h.grabStrength || 0),
      extended: fingers.slice(0, 5).map((f) => f.extended !== false),
    },
  }
}

/** Geste au vocabulaire du GestureRecognizer de MediaPipe, lu sur le capteur. */
export function gestureOf(h: LeapHand): string {
  const e = h.extended, n = e.slice(1).filter(Boolean).length
  if (h.grab > 0.85 || (n === 0 && h.grab > 0.5)) return 'Closed_Fist'
  if (n === 4 && h.pinch < 0.5) return 'Open_Palm'
  if (e[1] && n === 1) return 'Pointing_Up'
  if (e[1] && e[2] && n === 2) return 'Victory'
  if (e[0] && n === 0) return 'Thumb_Up'
  return 'None'
}

export function convertFrame(raw: any, s: LeapSettings = settings, aspect = 16 / 9): HandFrame {
  const out: HandFrame = { landmarks: [], gestures: [], leap: [] }
  const pointables = Array.isArray(raw?.pointables) ? raw.pointables : []
  for (const h of Array.isArray(raw?.hands) ? raw.hands : []) {
    const c = convertHand(h, pointables, s, aspect)
    if (!c) continue
    out.landmarks.push(c.lm); out.leap!.push(c.hand)
    out.gestures.push([{ categoryName: gestureOf(c.hand), score: typeof h.confidence === 'number' ? h.confidence : 0.9 }])
  }
  return out
}

const screenAspect = () => (typeof window !== 'undefined' && window.innerHeight > 0 ? window.innerWidth / window.innerHeight : 16 / 9)
export const leapFrame = (): HandFrame => convertFrame(S.raw, settings, S.aspect || screenAspect())

// ───────────────────────── calage sur la webcam ─────────────────────────
//
// Le Leap et la webcam voient la même main depuis deux endroits. Pour que la main du Leap
// tombe sur celle de l'image, on cherche où est la webcam dans le repère du Leap : 6 nombres
// (position, focale, inclinaison), bornés à des valeurs physiques, donc la projection ne peut
// ni se retourner ni se déformer. Les mesures sont rangées par zone de l'espace (une par cube
// de 10 cm) : la dernière remplace la précédente, et l'ajustement porte sur toutes les zones.
// Moindres carrés robustes (Levenberg-Marquardt + poids de Huber), tirés vers la caméra par
// défaut tant que la main n'a pas visité assez de zones pour tout déterminer.

interface Sample { pts: V3[]; uv: { x: number; y: number }[]; t: number }
const CAL = { samples: new Map<string, Sample>(), fit: null as LeapCal | null, err: 0, bad: 0, lastAt: 0, savedAt: 0 }
const SIGMA: LeapCal = { cx: 200, cy: 300, cz: 300, f: 0.12, pitch: 0.3, yaw: 0.15 }   // confiance dans la caméra par défaut
const LO: LeapCal = { cx: -600, cy: -400, cz: -1500, f: 0.4, pitch: -1, yaw: -0.5 }
const HI: LeapCal = { cx: 600, cy: 1200, cz: -60, f: 1.3, pitch: 1, yaw: 0.5 }
const STEP: LeapCal = { cx: 1, cy: 1, cz: 1, f: 1e-3, pitch: 1e-3, yaw: 1e-3 }
const NOISE = 0.02    // écart attendu d'un jalon bien calé, en largeurs d'image
const HUBER = 1.5     // au-delà de 3 % de l'image, une mesure compte de moins en moins

export function resetFit() { CAL.samples.clear(); CAL.fit = null; CAL.err = 0; CAL.bad = 0 }
/** Oublier le calage mesuré et repartir de la caméra par défaut. */
export function resetLeapCal() { resetFit(); setLeapSettings({ cal: null }); publish({ fit: { n: 0, err: 0 } }) }
export const fitState = () => ({ n: CAL.samples.size, err: CAL.err })

/** Résout M·x = r (n × n) par élimination de Gauss avec pivot ; `null` si le système est dégénéré. */
function solve(M: number[][], r: number[]): number[] | null {
  const n = r.length, a = M.map((row, i) => [...row, r[i]])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let i = c + 1; i < n; i++) if (Math.abs(a[i][c]) > Math.abs(a[p][c])) p = i
    if (Math.abs(a[p][c]) < 1e-12) return null
    ;[a[c], a[p]] = [a[p], a[c]]
    for (let i = 0; i < n; i++) if (i !== c) { const f = a[i][c] / a[c][c]; for (let j = c; j <= n; j++) a[i][j] -= f * a[c][j] }
  }
  return a.map((row, i) => row[n] / row[i])
}

/** Écart de chaque jalon (en largeurs d'image, vertical ramené à la même échelle). */
function gaps(c: LeapCal, samples: Sample[], aspect: number): number[] {
  const out: number[] = []
  for (const s of samples) s.pts.forEach((p, i) => { const q = project(p, c, aspect); out.push(q.x - s.uv[i].x, (q.y - s.uv[i].y) / aspect) })
  return out
}
const median = (a: number[]) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1] : 0 }
const gapMedian = (c: LeapCal, samples: Sample[], aspect: number) => { const g = gaps(c, samples, aspect), d: number[] = []; for (let i = 0; i < g.length; i += 2) d.push(Math.hypot(g[i], g[i + 1])); return median(d) }

/** Ajuste la caméra aux mesures, en partant de `start` et en restant près de `prior` là où les mesures ne disent rien. */
export function fitCal(start: LeapCal, prior: LeapCal, samples: Sample[], aspect: number): { cal: LeapCal; err: number } {
  let c = { ...start }, lambda = 1e-2
  const clampCal = (x: LeapCal) => { for (const k of CAL_KEYS) x[k] = Math.max(LO[k], Math.min(HI[k], x[k])); return x }
  const sq = (r: number[]) => r.reduce((e, v) => e + v * v, 0)
  for (let it = 0; it < 10; it++) {
    const g0 = gaps(c, samples, aspect)
    const w = g0.map((_, i) => { const n = Math.hypot(g0[i & ~1], g0[i | 1]) / NOISE; return n > HUBER ? Math.sqrt(HUBER / n) : 1 })
    const res = (x: LeapCal) => gaps(x, samples, aspect).map((v, i) => v / NOISE * w[i]).concat(CAL_KEYS.map((k) => (x[k] - prior[k]) / SIGMA[k]))
    const r = res(c), cost = sq(r)
    const J = CAL_KEYS.map((k) => { const x = { ...c, [k]: c[k] + STEP[k] }; return res(x).map((v, i) => (v - r[i]) / STEP[k]) })
    const A = CAL_KEYS.map((_, i) => CAL_KEYS.map((_, j) => J[i].reduce((e, v, n) => e + v * J[j][n], 0)))
    const g = CAL_KEYS.map((_, i) => -J[i].reduce((e, v, n) => e + v * r[n], 0))
    let better = false
    for (let tries = 0; tries < 7 && !better; tries++) {
      const d = solve(A.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) + 1e-12 : v))), g)
      const next = d && clampCal(CAL_KEYS.reduce((x, k, i) => { x[k] = c[k] + d[i]; return x }, { ...c }))
      if (next && CAL_KEYS.every((k) => Number.isFinite(next[k])) && sq(res(next)) < cost) { c = next; lambda = Math.max(1e-6, lambda / 3); better = true } else lambda *= 6
    }
    if (!better) break
  }
  return { cal: c, err: gapMedian(c, samples, aspect) }
}

/** Les deux capteurs voient-ils bien la même main, dans la même pose ? Sans rien supposer du calage :
 *  la main du Leap, vue d'à peu près le bon côté, doit se superposer à celle de l'image par un simple
 *  déplacement + agrandissement + petite rotation. Une autre main (image miroir), une autre pose ou
 *  une fausse détection ne se superposent pas. */
function sameHand(s: Sample, view: LeapCal, aspect: number): boolean {
  const P = s.pts.map((p) => { const q = project(p, view, aspect); return [q.x, q.y / aspect] }), Q = s.uv.map((m) => [m.x, m.y / aspect])
  const mean = (a: number[][]) => [a.reduce((e, v) => e + v[0], 0) / a.length, a.reduce((e, v) => e + v[1], 0) / a.length]
  const mp = mean(P), mq = mean(Q)
  let re = 0, im = 0, pp = 0, qq = 0
  for (let i = 0; i < P.length; i++) {
    const px = P[i][0] - mp[0], py = P[i][1] - mp[1], qx = Q[i][0] - mq[0], qy = Q[i][1] - mq[1]
    re += px * qx + py * qy; im += px * qy - py * qx; pp += px * px + py * py; qq += qx * qx + qy * qy
  }
  if (pp < 1e-9 || qq < 1e-9) return false
  const scale = Math.hypot(re, im) / pp, turn = Math.atan2(im, re)
  const left = Math.max(0, qq - (re * re + im * im) / pp) / qq          // part de la forme non expliquée
  return scale > 0.3 && scale < 3.5 && Math.abs(turn) < 0.7 && left < 0.12
}

/** Une mesure : les mains du Leap (`leap`, 21 points en mm chacune) et les mêmes mains vues par la
 *  webcam (`cam`, jalons MediaPipe). Renvoie la caméra ajustée sur toutes les zones mesurées, ou
 *  `null` si la mesure est écartée (mains en nombre différent, ou incompatible avec le calage acquis). */
export function calibrate(leap: { pts: V3[]; full: boolean }[], cam: { x: number; y: number }[][], cur: LeapCal, prior: LeapCal, aspect: number, now = 0, maxAge = 180000): LeapCal | null {
  if (!leap.length || leap.length !== cam.length) return null
  // apparier par ordre horizontal : la droite de l'utilisateur (x du Leap) est à gauche de l'image non miroir
  const L = [...leap].sort((p, q) => q.pts[0].x - p.pts[0].x), C = [...cam].sort((p, q) => p[0].x - q[0].x)
  const fresh: [string, Sample][] = []
  for (let i = 0; i < L.length; i++) {
    // jalons que les deux capteurs placent au même endroit : poignet, bouts des doigts, et jointures si le service les donne
    const idx = L[i].full ? [0, 4, 8, 12, 16, 20, 5, 9, 13, 17] : [0, 4, 8, 12, 16, 20]
    if (idx.some((j) => !L[i].pts[j] || !C[i][j])) return null
    const smp: Sample = { pts: idx.map((j) => L[i].pts[j]), uv: idx.map((j) => ({ x: C[i][j].x, y: C[i][j].y })), t: now }
    if (!sameHand(smp, prior, aspect)) return null
    const m = L[i].pts[9] ?? L[i].pts[0]
    fresh.push([`${Math.round(m.x / 100)},${Math.round(m.y / 100)},${Math.round(m.z / 100)}`, smp])
  }
  // calage déjà solide et mesure très loin de lui : autre main que celle du Leap, fausse détection. Si cela
  // dure (25 mesures d'affilée, ~4 s), c'est le calage qui est périmé (capteur ou écran déplacé) : on repart de zéro.
  if (CAL.samples.size >= 5 && CAL.fit && gapMedian(CAL.fit, fresh.map((f) => f[1]), aspect) > 0.12) {
    if (++CAL.bad >= 25) resetFit()
    return null
  }
  CAL.bad = 0
  for (const [key, smp] of fresh) CAL.samples.set(key, smp)
  if (CAL.samples.size > 8) for (const [key, smp] of CAL.samples) if (now - smp.t > maxAge) CAL.samples.delete(key)   // les vieilles mesures s'effacent
  while (CAL.samples.size > 60) CAL.samples.delete(CAL.samples.keys().next().value as string)
  const fit = fitCal(CAL.fit ?? cur, prior, [...CAL.samples.values()], aspect)
  CAL.fit = fit.cal; CAL.err = fit.err
  return fit.cal
}

/** Pendant que le Leap pilote : regarder la webcam ~6 fois par seconde et recaler. */
export function leapAutoCalibrate(video: HTMLVideoElement | null, model: any, clock: HandClock) {
  if (!video || video.readyState < 2) return
  if (video.videoWidth > 0 && video.videoHeight > 0) S.aspect = video.videoWidth / video.videoHeight
  const now = performance.now()
  if (!settings.autoCal || !model || video.currentTime === clock.t || now - CAL.lastAt < 150) return
  clock.t = video.currentTime; CAL.lastAt = now
  const hands: any[] = Array.isArray(S.raw?.hands) ? S.raw.hands : []
  // ne mesurer que des mains ouvertes et presque immobiles : la webcam a ~0,1 s de retard sur le Leap,
  // et un poing cache le bout des doigts aux deux capteurs
  const speed = (h: any) => (Array.isArray(h.palmVelocity) ? Math.hypot(h.palmVelocity[0], h.palmVelocity[1], h.palmVelocity[2]) : S.speed)
  if (!hands.length || hands.some((h) => speed(h) > 80 || (+h.grabStrength || 0) > 0.4)) return
  let cam: { x: number; y: number }[][]
  try { cam = (model.recognizeForVideo ? model.recognizeForVideo(video, now) : model.detectForVideo(video, now)).landmarks ?? [] } catch { return }
  const pointables = Array.isArray(S.raw?.pointables) ? S.raw.pointables : []
  const aspect = S.aspect || 16 / 9
  const leap = hands.map((h) => convertHand(h, pointables, settings, aspect)).filter(Boolean) as { pts: V3[]; full: boolean }[]
  // sur la tête, le capteur bouge avec elle : seules les mesures des 15 dernières secondes comptent
  const fit = calibrate(leap, cam, calOf(settings), priorCal(settings), aspect, now, settings.placement === 'head' ? 15000 : 180000)
  if (!fit) return
  // glisser vers la caméra ajustée plutôt que sauter : le squelette ne tressaute pas à chaque mesure
  const cur = settings.cal
  settings = { ...settings, cal: cur ? CAL_KEYS.reduce((x, k) => { x[k] = cur[k] + (fit[k] - cur[k]) * 0.5; return x }, { ...cur }) : fit }
  if (now - CAL.savedAt > 2000) {                    // enregistrer et afficher de temps en temps, pas à chaque mesure
    CAL.savedAt = now
    try { localStorage.setItem(KEY, JSON.stringify(settings)) } catch { /* stockage indisponible */ }
    publish({ settings, fit: fitState() })
  }
}

// ───────────────────────── pince ─────────────────────────

/** La main `i` de la trame pince-t-elle (pouce contre index) ? `wasOn` = son état précédent : il
 *  faut serrer franchement pour fermer, et rouvrir franchement pour lâcher.
 *
 *  Leap : distance réelle entre les bouts des doigts (fermée sous 27 mm, rouverte au-delà de 41).
 *  Caméra : trois indices à la fois, réglés sur un enregistrement réel où l'écart à l'écran seul se
 *  déclenchait deux fois trop souvent (poing près du visage, main de profil) :
 *  l'écart pouce-index à l'écran, le même écart en 3D, et un index déplié (replié = poing). */
export function isPinching(res: HandFrame, i: number, wasOn: boolean): boolean {
  const lm = res.landmarks[i], leap = res.leap?.[i], g = res.gestures?.[i]?.[0]?.categoryName
  if (!lm || g === 'Closed_Fist' || g === 'Open_Palm') return false
  if (leap) return wasOn ? leap.pinch > 0.3 : leap.pinch > 0.75
  const hs = Math.max(0.02, Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y))
  const ratio = Math.hypot(lm[4].x - lm[8].x, lm[4].y - lm[8].y) / hs
  const w = res.worldLandmarks?.[i]
  if (!w || w.length < 21) return wasOn ? ratio < 0.62 : ratio < 0.42
  const d = (a: number, b: number) => Math.hypot(w[a].x - w[b].x, w[a].y - w[b].y, w[a].z - w[b].z)
  const straight = (m: number) => d(m, m + 3) / Math.max(1e-6, d(m, m + 1) + d(m + 1, m + 2) + d(m + 2, m + 3))   // 1 = doigt tendu, ~0,6 = replié
  const gap = d(4, 8) * 1000, index = straight(5)
  if (wasOn) return ratio < 0.5 && gap < 58 && index > 0.6
  const fist = straight(9) < 0.72 && straight(13) < 0.72 && straight(17) < 0.72    // les trois autres doigts repliés
  return ratio < 0.33 && gap < 42 && index > 0.72 && !(fist && gap >= 22)
}

// ───────────────────────── source unique pour les ateliers ─────────────────────────

export interface HandClock { t: number; seq: number }
export const handClock = (): HandClock => ({ t: -1, seq: -1 })

/** Mains de la trame courante, ou `null` s'il n'y a rien de neuf depuis le dernier appel.
 *  Leap connecté → trames du capteur ; sinon → modèle MediaPipe sur la vidéo. */
export function pollHands(video: HTMLVideoElement | null, model: any, clock: HandClock): HandFrame | null {
  if (leapConnected()) {
    leapAutoCalibrate(video, model, clock)
    if (S.seq === clock.seq) return null
    clock.seq = S.seq
    return leapFrame()
  }
  if (!model || !video || video.readyState < 2 || video.currentTime === clock.t) return null
  clock.t = video.currentTime
  return model.recognizeForVideo ? model.recognizeForVideo(video, performance.now()) : model.detectForVideo(video, performance.now())
}

// ───────────────────────── connexion ─────────────────────────

// Depuis Chrome 152, un site https doit obtenir la permission « Accès au réseau local »
// pour joindre 127.0.0.1. 'granted' | 'prompt' | 'denied' | null (navigateur sans cette règle).
async function localNetworkPermission(): Promise<string | null> {
  try { return (await navigator.permissions.query({ name: 'local-network-access' as PermissionName })).state } catch { return null }
}
const LNA_HELP = 'Chrome bloque l\'accès de ce site au réseau local : icône à gauche de l\'adresse → Autorisations du site → « Accès au réseau local » → Autoriser, puis recharge la page.'

const LIVE_MSG = 'Leap Motion actif : il remplace la caméra pour le suivi des mains.'
const IDLE_MSG = "Service Leap joint, mais le capteur n'envoie rien : branche-le ou vérifie qu'il n'est pas en pause. En attendant, le suivi reste sur la caméra."

export function disconnectLeap(message = '', status: LeapStatus = 'off') {
  const ws = S.ws
  S.ws = null; S.connected = false; S.raw = null; S.lastAt = 0; clearInterval(S.watch)
  if (ws) { try { ws.onclose = null; ws.close() } catch { /* déjà fermé */ } }
  frameSubs.forEach((cb) => cb({ landmarks: [], gestures: [] }))   // plus de mains : ne pas laisser un fantôme
  publish({ status, message })
}

export async function connectLeap(): Promise<boolean> {
  if (S.connected) return true
  disconnectLeap('Recherche du capteur…', 'connecting')
  const url = settings.url || LEAP_DEFAULTS.url
  const local = /^wss?:\/\/(127\.0\.0\.1|localhost)\b/.test(url) && location.protocol === 'https:'
  const perm = local ? await localNetworkPermission() : null
  if (perm === 'denied') { disconnectLeap(LNA_HELP, 'error'); return false }
  if (perm === 'prompt') publish({ message: 'Chrome demande l\'accès au réseau local : clique « Autoriser ».' })
  return new Promise<boolean>((resolve) => {
    let settled = false
    const fail = (msg: string) => { if (settled) return; settled = true; clearTimeout(timer); disconnectLeap(msg, 'error'); resolve(false) }
    const notFound = `Leap Motion introuvable sur ${url}. Lance le logiciel Leap (V2 ou Orion V4, option « Autoriser les applications Web ») ou le pont leap_bridge.py.`
    const timer = setTimeout(() => fail(perm === 'prompt' ? 'Pas de réponse à la demande d\'accès au réseau local : clique « Autoriser » puis réessaie.' : notFound), perm === 'prompt' ? 30000 : 4000)
    let ws: WebSocket
    try { ws = new WebSocket(url) } catch (e: any) { fail(`Adresse du service refusée : ${e?.message ?? e}`); return }
    S.ws = ws
    ws.onopen = () => {
      // Mêmes messages que leap.js : pas de gestes maison, trames même sans focus.
      try { ws.send(JSON.stringify({ enableGestures: false })); ws.send(JSON.stringify({ background: true })); ws.send(JSON.stringify({ focused: true })) } catch { /* fermé entre-temps */ }
    }
    ws.onmessage = (ev) => {
      let m: any; try { m = JSON.parse(ev.data) } catch { return }
      if (Array.isArray(m.hands)) {
        const now = performance.now(), pp = m.hands[0]?.palmPosition
        if (Array.isArray(pp) && S.palm && now > S.lastAt) S.speed += (Math.hypot(pp[0] - S.palm[0], pp[1] - S.palm[1], pp[2] - S.palm[2]) / (now - S.lastAt) * 1000 - S.speed) * 0.3
        S.palm = Array.isArray(pp) ? pp : null
        S.raw = m; S.seq++; S.lastAt = now
        if (frameSubs.size) { const f = leapFrame(); frameSubs.forEach((cb) => cb(f)) }
      }
      if (!settled && (m.version !== undefined || Array.isArray(m.hands))) {
        settled = true; clearTimeout(timer); S.connected = true
        setLeapSettings({ auto: true })
        // le service répond dès l'ouverture, capteur branché ou non : l'état dit ce qui arrive vraiment
        const t0 = performance.now()
        let shown: boolean | null = null
        const say = () => {
          const live = leapConnected()
          if (live === shown || (!live && performance.now() - t0 < 1500)) return   // laisser 1,5 s aux premières trames
          shown = live
          if (!live) frameSubs.forEach((cb) => cb({ landmarks: [], gestures: [] }))   // capteur muet : pas de main fantôme
          publish({ status: 'on', message: live ? LIVE_MSG : IDLE_MSG })
        }
        publish({ status: 'on', message: 'Service Leap joint, attente des premières trames…' })
        clearInterval(S.watch); S.watch = setInterval(say, 300)
        resolve(true)
      }
    }
    ws.onerror = () => fail(perm === 'prompt' ? LNA_HELP : notFound)
    ws.onclose = () => {
      if (!settled) { fail('Connexion Leap fermée avant la première trame.'); return }
      if (S.ws === ws) disconnectLeap('Connexion au Leap perdue : le suivi repasse sur la caméra.', 'error')
    }
  })
}

/** À l'ouverture d'un atelier : se rebrancher si l'utilisateur s'en servait déjà. */
export function autoConnectLeap() { if (settings.auto && view.status === 'off') void connectLeap() }
/** Débrancher à la demande de l'utilisateur (on ne se reconnecte plus tout seul). */
export function turnLeapOff() { setLeapSettings({ auto: false }); disconnectLeap() }
