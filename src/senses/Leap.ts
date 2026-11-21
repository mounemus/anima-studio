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
  gestures: { categoryName: string; score: number }[][]
  /** Présent seulement quand la trame vient du Leap (même ordre que `landmarks`). */
  leap?: LeapHand[]
}

export interface LeapSettings {
  url: string
  /** Où est posé le capteur : à plat sur le bureau, ou fixé à l'écran face à l'utilisateur. */
  placement: 'desk' | 'screen'
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
/** Webcam vue depuis le repère du Leap : projection complète (position, orientation, focale),
 *  11 nombres [a0..a3, b0..b3, c0..c2] avec, pour un point (x, y, z) en dm :
 *  u = ½ + (a·[x y z 1]) / w,  v = ½ + (b·[x y z 1]) / w,  w = c·[x y z] + 1. */
export type LeapCal = number[]
export const LEAP_DEFAULTS: LeapSettings = { url: 'ws://127.0.0.1:6437/v6.json', placement: 'desk', span: 700, height: 360, auto: false, autoCal: true, cal: null }
const KEY = 'digiart:leap'

function loadSettings(): LeapSettings {
  try {
    const s = { ...LEAP_DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }
    if (!(Array.isArray(s.cal) && s.cal.length === 11 && s.cal.every(Number.isFinite))) s.cal = null
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
  if ('span' in patch || 'height' in patch || 'placement' in patch) { patch = { ...patch, cal: null }; resetFit() }
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

const CAM_DIST = 350   // mm entre la caméra virtuelle (à l'écran) et le centre de la zone
const CENTER_Y = 200   // hauteur du centre de la zone au-dessus du capteur (mm)
const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const add = (a: V3, b: V3, k = 1): V3 => ({ x: a.x + b.x * k, y: a.y + b.y * k, z: a.z + b.z * k })
const lerp = (a: V3, b: V3, t: number): V3 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t })
const cross = (a: V3, b: V3): V3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x })

/** Repère du capteur → repère « bureau ». Capteur fixé à l'écran : sa normale (y) pointe
 *  vers l'utilisateur et son axe z vers le bas. */
function dir(a: any, s: LeapSettings): V3 | null {
  if (!Array.isArray(a) || a.length < 3 || !a.every(Number.isFinite)) return null
  return s.placement === 'screen' ? { x: a[0], y: -a[2], z: a[1] } : { x: a[0], y: a[1], z: a[2] }
}
function pos(a: any, s: LeapSettings): V3 | null {
  const d = dir(a, s); if (!d) return null
  return s.placement === 'screen' ? { x: d.x, y: d.y + CENTER_Y, z: d.z - 250 } : d
}

/** Caméra par défaut : à l'écran, 350 mm derrière le capteur, à la hauteur réglée, à l'horizontale. */
export function priorCal(s: LeapSettings, aspect: number): LeapCal {
  const d = CAM_DIST / 100, f = CAM_DIST / Math.max(120, s.span), cy = (s.placement === 'screen' ? CENTER_Y : s.height) / 100
  return [-f / d, 0, 0, 0, 0, -f * aspect / d, 0, f * aspect * cy / d, 0, 0, 1 / d]
}
export const calOf = (s: LeapSettings, aspect: number): LeapCal => s.cal ?? priorCal(s, aspect)

/** Position mm → coordonnées image 0..1 de la webcam (non miroir : la droite de l'utilisateur
 *  est à gauche de l'image, les ateliers font déjà `1 - x`). `k` = largeurs d'image par mm. */
export function project(p: V3, c: LeapCal) {
  const x = p.x / 100, y = p.y / 100, z = p.z / 100
  const w = Math.max(0.12, c[8] * x + c[9] * y + c[10] * z + 1)
  return { x: 0.5 + (c[0] * x + c[1] * y + c[2] * z + c[3]) / w, y: 0.5 + (c[4] * x + c[5] * y + c[6] * z + c[7]) / w, k: Math.hypot(c[0], c[1], c[2]) / w / 100 }
}
/** Largeurs d'image par millimètre, pour une main au-dessus du capteur (échelle de la profondeur). */
export const leapWidthPerMm = () => project({ x: 0, y: 250, z: 0 }, calOf(settings, S.aspect || 16 / 9)).k

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
  const cal = calOf(s, aspect)
  const lm = pts.map((p) => { const q = project(p, cal); return { x: q.x, y: q.y, z: (p.z - wrist.z) * q.k } })
  // le service donne-t-il les vraies articulations, ou seulement le bout des doigts ?
  const full = fingers.slice(0, 5).every((f) => !!f.mcpPosition || (Array.isArray(f.positions) && f.positions.length >= 5))
  const tT = pts[4], tI = pts[8]
  // Orion 4 laisse souvent pinchStrength à 0 en mode bureau (mesuré sur le vrai capteur) :
  // on prend le max avec une pince déduite de la distance pouce-index (≤ 15 mm → 1, ≥ 60 mm → 0).
  const byDist = clamp01(1 - (Math.hypot(tT.x - tI.x, tT.y - tI.y, tT.z - tI.z) - 15) / 45)
  return {
    lm, pts, full,
    hand: {
      type: right ? 'right' : 'left',
      pinchMm: lerp(tT, tI, 0.5), palmMm: palm, normal, direction,
      pinch: Math.max(+h.pinchStrength || 0, byDist),
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
// tombe sur celle de l'image, on estime la projection de la webcam dans le repère du Leap à
// partir des mêmes jalons vus des deux côtés. Pour un jalon (u, v) de l'image et le même
// point X = (x, y, z) chez le Leap, la projection s'écrit de façon linéaire en ses 11 nombres :
//   a·[X 1] − (u − ½)·(c·X) = u − ½        b·[X 1] − (v − ½)·(c·X) = v − ½
// Moindres carrés cumulés, retenus vers la caméra courante tant que la main n'a pas assez
// bougé pour tout déterminer (surtout la perspective, c).

const NP = 11
const FIT = { A: new Float64Array(NP * NP), b: new Float64Array(NP), n: 0, err: 0, rej: 0, lastAt: 0, savedAt: 0 }
const RIDGE = [1, 1, 1, 0.2, 1, 1, 1, 0.2, 6, 6, 6]
export function resetFit() { FIT.A.fill(0); FIT.b.fill(0); FIT.n = 0; FIT.err = 0; FIT.rej = 0 }
/** Oublier le calage mesuré et repartir de la caméra par défaut. */
export function resetLeapCal() { resetFit(); setLeapSettings({ cal: null }); publish({ fit: { n: 0, err: 0 } }) }

/** Résout M·x = r (n × n) par élimination de Gauss avec pivot ; `null` si le système est dégénéré. */
function solve(M: Float64Array, r: Float64Array, n: number): number[] | null {
  const a = Array.from({ length: n }, (_, i) => [...M.slice(i * n, i * n + n), r[i]])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let i = c + 1; i < n; i++) if (Math.abs(a[i][c]) > Math.abs(a[p][c])) p = i
    if (Math.abs(a[p][c]) < 1e-10) return null
    ;[a[c], a[p]] = [a[p], a[c]]
    for (let i = 0; i < n; i++) if (i !== c) { const f = a[i][c] / a[c][c]; for (let j = c; j <= n; j++) a[i][j] -= f * a[c][j] }
  }
  return a.map((row, i) => row[n] / row[i])
}

/** Une mesure : les mains du Leap (`leap`, 21 points en mm chacune) et les mêmes mains vues
 *  par la webcam (`cam`, jalons MediaPipe). Renvoie la caméra recalée, ou `null` si la mesure
 *  est écartée (mains en nombre différent, incohérente, système dégénéré). */
export function calibrate(leap: { pts: V3[]; full: boolean }[], cam: { x: number; y: number }[][], cal: LeapCal): LeapCal | null {
  if (!leap.length || leap.length !== cam.length) return null
  // apparier par ordre horizontal dans l'image (avec la caméra courante pour le Leap)
  const L = [...leap].sort((p, q) => project(p.pts[0], cal).x - project(q.pts[0], cal).x)
  const C = [...cam].sort((p, q) => p[0].x - q[0].x)
  const rows: { r: number[]; y: number }[] = []
  let err = 0, cnt = 0
  L.forEach((h, i) => {
    const idx = h.full ? Array.from({ length: 21 }, (_, j) => j) : [0, 4, 8, 12, 16, 20]   // sans articulations : poignet + bouts des doigts
    for (const j of idx) {
      const p = h.pts[j], m = C[i][j]; if (!p || !m) continue
      const x = p.x / 100, y = p.y / 100, z = p.z / 100, q = project(p, cal), du = m.x - 0.5, dv = m.y - 0.5
      err += Math.hypot(q.x - m.x, q.y - m.y); cnt++
      rows.push({ r: [x, y, z, 1, 0, 0, 0, 0, -du * x, -du * y, -du * z], y: du })
      rows.push({ r: [0, 0, 0, 0, x, y, z, 1, -dv * x, -dv * y, -dv * z], y: dv })
    }
  })
  if (!cnt) return null
  err /= cnt
  // Mesure écartée (autre main que celle du Leap, fausse détection) : rien n'est retenu. Si cela
  // dure 3 s d'affilée, c'est le calage accumulé qui est faux : on repart de zéro.
  const A0 = Float64Array.from(FIT.A), b0 = Float64Array.from(FIT.b)
  const reject = () => { FIT.A.set(A0); FIT.b.set(b0); if (++FIT.rej >= 15) resetFit(); return null }
  if (FIT.n >= 20 && err > 0.25) return reject()
  for (let i = 0; i < NP * NP; i++) FIT.A[i] *= 0.997   // les vieilles mesures s'effacent lentement
  for (let i = 0; i < NP; i++) FIT.b[i] *= 0.997
  for (const { r, y } of rows) for (let i = 0; i < NP; i++) { if (!r[i]) continue; FIT.b[i] += r[i] * y; for (let j = 0; j < NP; j++) FIT.A[i * NP + j] += r[i] * r[j] }
  const M = Float64Array.from(FIT.A), r = Float64Array.from(FIT.b)
  for (let i = 0; i < NP; i++) { M[i * NP + i] += RIDGE[i]; r[i] += RIDGE[i] * cal[i] }
  const c = solve(M, r, NP); if (!c || !c.every(Number.isFinite)) return reject()
  // garde-fous : tous les points devant la caméra, et une échelle plausible (150 mm à 3 m pour la largeur de l'image)
  const sane = L.every((h) => h.pts.every((p) => c[8] * p.x / 100 + c[9] * p.y / 100 + c[10] * p.z / 100 + 1 > 0.2 && (() => { const k = project(p, c).k; return k > 1 / 3000 && k < 1 / 150 })()))
  if (!sane) return reject()
  // une vraie correspondance s'explique par la caméra recalée ; une autre main, non
  let post = 0
  L.forEach((h, i) => h.pts.forEach((p, j) => { if (h.full || j % 4 === 0) { const q = project(p, c); post += Math.hypot(q.x - C[i][j].x, q.y - C[i][j].y) } }))
  if (FIT.n >= 5 && post / cnt > 0.05) return reject()
  FIT.n++; FIT.rej = 0; FIT.err += (err - FIT.err) * (FIT.n === 1 ? 1 : 0.1)
  return c
}
export const fitState = () => ({ n: FIT.n, err: FIT.err })

/** Pendant que le Leap pilote : regarder la webcam ~6 fois par seconde et recaler. */
export function leapAutoCalibrate(video: HTMLVideoElement | null, model: any, clock: HandClock) {
  if (!video || video.readyState < 2) return
  if (video.videoWidth > 0 && video.videoHeight > 0) S.aspect = video.videoWidth / video.videoHeight
  const now = performance.now()
  if (!settings.autoCal || !model || video.currentTime === clock.t || now - FIT.lastAt < 150) return
  clock.t = video.currentTime; FIT.lastAt = now
  if (S.speed > 150) return                           // main rapide : la webcam a ~80 ms de retard sur le Leap
  let cam: { x: number; y: number }[][]
  try { cam = (model.recognizeForVideo ? model.recognizeForVideo(video, now) : model.detectForVideo(video, now)).landmarks ?? [] } catch { return }
  const pointables = Array.isArray(S.raw?.pointables) ? S.raw.pointables : []
  const aspect = S.aspect || 16 / 9
  const leap = (Array.isArray(S.raw?.hands) ? S.raw.hands : []).map((h: any) => convertHand(h, pointables, settings, aspect)).filter(Boolean)
  const c = calibrate(leap, cam, calOf(settings, aspect))
  if (!c) return
  settings = { ...settings, cal: c }
  if (now - FIT.savedAt > 3000) {                    // enregistrer et afficher de temps en temps, pas à chaque mesure
    FIT.savedAt = now
    try { localStorage.setItem(KEY, JSON.stringify(settings)) } catch { /* stockage indisponible */ }
    publish({ settings, fit: { n: FIT.n, err: FIT.err } })
  }
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
