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
  /** Se reconnecter tout seul à l'ouverture d'un atelier. */
  auto: boolean
}
export const LEAP_DEFAULTS: LeapSettings = { url: 'ws://127.0.0.1:6437/v6.json', placement: 'desk', span: 600, auto: false }
const KEY = 'digiart:leap'

function loadSettings(): LeapSettings {
  try { return { ...LEAP_DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') } } catch { return { ...LEAP_DEFAULTS } }
}
let settings = loadSettings()

export type LeapStatus = 'off' | 'connecting' | 'on' | 'error'
interface View { status: LeapStatus; message: string; settings: LeapSettings }
let view: View = { status: 'off', message: '', settings }
const subs = new Set<() => void>()
const frameSubs = new Set<(f: HandFrame) => void>()
const S = { ws: null as WebSocket | null, raw: null as any, seq: 0, connected: false, lastAt: 0, watch: 0 as any }

function publish(patch: Partial<View>) { view = { ...view, ...patch }; subs.forEach((f) => f()) }

export function setLeapSettings(patch: Partial<LeapSettings>) {
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

/** Position mm → coordonnées image 0..1 d'une webcam virtuelle (non miroir : la droite de
 *  l'utilisateur est à gauche de l'image, les ateliers font déjà `1 - x`). */
function project(p: V3, s: LeapSettings, aspect: number) {
  const depth = Math.max(80, p.z + CAM_DIST), f = CAM_DIST / Math.max(120, s.span)
  return { x: 0.5 - f * p.x / depth, y: 0.5 - f * aspect * (p.y - CENTER_Y) / depth, depth, f }
}

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

export function convertHand(h: any, pointables: any[], s: LeapSettings, aspect: number): { lm: V3[]; hand: LeapHand } | null {
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
  const w = project(wrist, s, aspect)
  const lm = pts.map((p) => { const q = project(p, s, aspect); return { x: q.x, y: q.y, z: (q.depth - w.depth) * q.f / q.depth } })
  const tT = pts[4], tI = pts[8]
  // Orion 4 laisse souvent pinchStrength à 0 en mode bureau (mesuré sur le vrai capteur) :
  // on prend le max avec une pince déduite de la distance pouce-index (≤ 15 mm → 1, ≥ 60 mm → 0).
  const byDist = clamp01(1 - (Math.hypot(tT.x - tI.x, tT.y - tI.y, tT.z - tI.z) - 15) / 45)
  return {
    lm,
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
export const leapFrame = (): HandFrame => convertFrame(S.raw, settings, screenAspect())

// ───────────────────────── source unique pour les ateliers ─────────────────────────

export interface HandClock { t: number; seq: number }
export const handClock = (): HandClock => ({ t: -1, seq: -1 })

/** Mains de la trame courante, ou `null` s'il n'y a rien de neuf depuis le dernier appel.
 *  Leap connecté → trames du capteur ; sinon → modèle MediaPipe sur la vidéo. */
export function pollHands(video: HTMLVideoElement | null, model: any, clock: HandClock): HandFrame | null {
  if (leapConnected()) {
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
        S.raw = m; S.seq++; S.lastAt = performance.now()
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
