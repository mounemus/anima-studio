/**
 * Lutherie d'air — composer en dessinant ses instruments dans l'image de la caméra.
 *
 * On pince pour dessiner, on joue en traversant du bout des doigts :
 *  · CORDE : pince, étire, relâche. Sa longueur donne la note (deux fois plus courte = une octave
 *    plus haut), accordée sur la gamme choisie. Les graduations sont de vraies frettes : pince la
 *    corde d'une main sur une graduation, gratte de l'autre, la note change.
 *  · TAMBOUR : un cercle. Grand = grosse caisse, moyen = tom, petit = charleston.
 *  · CLOCHETTE : un point. Plus il est haut dans l'image, plus il est aigu.
 *  · MANÈGE : un cercle dont le rayon tourne au tempo et joue tout ce qu'il croise. C'est lui qui
 *    transforme un dessin en morceau : la place des cordes autour du centre devient le rythme.
 *
 * Mains par la caméra ou par le Leap Motion ; la souris fait un doigt. Route /music.
 */
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { FilesetResolver, GestureRecognizer } from '@mediapipe/tasks-vision'
import { pollHands, handClock, autoConnectLeap, isPinching, type HandFrame } from '../senses/Leap'
import { LeapToggle } from '../ui/LeapToggle'
import { Synth, TIMBRES, type Timbre } from './synth'
import { SCALES, NOTE_NAMES, stringMidi, frets, frettedMidi, cross, nearest, sweep, sweepPoint, drumVoice, bellMidi, midiToHz, noteName, type P2, type Fret } from './theory'

const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
const GESTURE_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task'
const FINGER_CHAINS = [[0, 1, 2, 3, 4], [0, 5, 6, 7, 8], [0, 9, 10, 11, 12], [0, 13, 14, 15, 16], [0, 17, 18, 19, 20]]
const TIPS = [4, 8, 12, 16, 20]
const SAVE_KEY = 'digiart:music'
const clamp = (a: number, b: number, v: number) => Math.max(a, Math.min(b, v))
const dist = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1])

type Kind = 'string' | 'drum' | 'bell' | 'wheel'
type Tool = 'play' | Kind | 'erase'
/** Un instrument dessiné. Coordonnées en largeurs d'écran (x et y divisés par la largeur), donc
 *  indépendantes de la taille de la fenêtre. `b` = autre bout de la corde, ou point du bord du cercle. */
interface Thing { id: string; kind: Kind; a: P2; b: P2; timbre: Timbre }

const TOOLS: { id: Tool; icon: string; label: string; hint: string }[] = [
  { id: 'play', icon: '✋', label: 'Jouer', hint: 'Traverse les cordes du bout des doigts, entre dans les tambours, effleure les clochettes. Rien ne se dessine.' },
  { id: 'string', icon: '🎻', label: 'Corde', hint: 'Pince, étire, relâche. Longue = grave, courte = aiguë.' },
  { id: 'drum', icon: '🥁', label: 'Tambour', hint: 'Pince au centre, écarte pour la taille. Grand = grosse caisse, petit = charleston.' },
  { id: 'bell', icon: '🔔', label: 'Clochette', hint: 'Une pince pose une clochette. Plus haut = plus aigu.' },
  { id: 'wheel', icon: '🎠', label: 'Manège', hint: 'Pince au centre, écarte : le rayon tourne au tempo et joue tout ce qu\'il croise.' },
  { id: 'erase', icon: '🧽', label: 'Gomme', hint: 'Pince un instrument pour le retirer.' },
]

/** Un petit morceau tout fait : six cordes de harpe en couronne, un tom et quatre charlestons, autour d'un manège. */
function example(aspect: number): Thing[] {   // aspect = hauteur / largeur de l'écran
  const c: P2 = [aspect < 1 ? 0.6 : 0.5, 0.48 * aspect], out: Thing[] = []
  const at = (deg: number, r: number): P2 => [c[0] + Math.cos(deg * Math.PI / 180) * r, c[1] + Math.sin(deg * Math.PI / 180) * r]
  ;[0.25, 0.21, 0.187, 0.167, 0.14, 0.125].forEach((len, i) => {
    const deg = i * 60 + 20, m = at(deg, 0.12), tx = -Math.sin(deg * Math.PI / 180) * len / 2, ty = Math.cos(deg * Math.PI / 180) * len / 2
    out.push({ id: `ex-s${i}`, kind: 'string', a: [m[0] - tx, m[1] - ty], b: [m[0] + tx, m[1] + ty], timbre: i % 3 === 2 ? 'guitar' : 'harp' })
  })
  ;[45, 135, 225, 315].forEach((deg, i) => { const p = at(deg, 0.215); out.push({ id: `ex-h${i}`, kind: 'drum', a: p, b: [p[0] + 0.028, p[1]], timbre: 'guitar' }) })
  const tom = at(180, 0.2); out.push({ id: 'ex-t', kind: 'drum', a: tom, b: [tom[0] + 0.07, tom[1]], timbre: 'guitar' })
  out.push({ id: 'ex-b', kind: 'bell', a: at(0, 0.22), b: at(0, 0.22), timbre: 'harp' })
  out.push({ id: 'ex-w', kind: 'wheel', a: c, b: at(0, 0.24), timbre: 'guitar' })
  return out
}

const SET_KEY = 'digiart:music:reglages'
function savedSettings(): any { try { return JSON.parse(localStorage.getItem(SET_KEY) || '{}') ?? {} } catch { return {} } }
const okScale = (v: any) => typeof v === 'string' && Object.hasOwn(SCALES, v), okTimbre = (v: any) => typeof v === 'string' && Object.hasOwn(TIMBRES, v), okRoot = (v: any) => Number.isInteger(v) && v >= 0 && v < 12
const okBpm = (v: any) => Number.isFinite(v) && v >= 40 && v <= 180, okTurn = (v: any) => Number.isFinite(v) && v >= 1 && v <= 256
const okPoint = (q: any) => Array.isArray(q) && Number.isFinite(q[0]) && Number.isFinite(q[1])
const TURNS: [number, string][] = [[4, 'une mesure'], [8, 'deux mesures'], [16, 'quatre mesures'], [32, 'huit mesures'], [64, 'seize mesures']]

function loadSaved(): Thing[] {
  try { const s = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); return Array.isArray(s?.things) ? s.things : [] } catch { return [] }
}

interface Hand { has: boolean; seen: number; since: number; pinch: boolean; was: boolean; raw: boolean; rawAt: number; tips: P2[]; prev: P2[] | null; at: P2; grip: P2; lm: P2[] }
const mkHand = (): Hand => ({ has: false, seen: 0, since: 0, pinch: false, was: false, raw: false, rawAt: 0, tips: [], prev: null, at: [0, 0], grip: [0, 0], lm: [] })

export function MusicStudio() {
  const [tool, setTool] = useState<Tool>('string')
  const [s0] = useState(savedSettings)
  const [timbre, setTimbre] = useState<Timbre>(okTimbre(s0.timbre) ? s0.timbre : 'harp')
  const [scale, setScale] = useState<string>(okScale(s0.scale) ? s0.scale : 'penta')
  const [root, setRoot] = useState<number>(okRoot(s0.root) ? s0.root : 0)
  const [bpm, setBpm] = useState<number>(okBpm(s0.bpm) ? s0.bpm : 90)
  const [turn, setTurn] = useState<number>(okTurn(s0.turn) ? s0.turn : 8)   // temps pour un tour de manège
  const [pieces, setPieces] = useState<{ id: string; title: string; style: string }[]>([])
  useEffect(() => { try { localStorage.setItem(SET_KEY, JSON.stringify({ timbre, scale, root, bpm, turn })) } catch { /* stockage plein */ } }, [timbre, scale, root, bpm, turn])
  useEffect(() => { fetch('/morceaux/index.json').then((r) => (r.ok ? r.json() : [])).then((l) => { if (Array.isArray(l)) setPieces(l) }).catch(() => { /* pas de liste : le bouton Ouvrir reste */ }) }, [])
  const [reverb, setReverb] = useState(0.45)
  const [echo, setEcho] = useState(0.2)
  const [volume, setVolume] = useState(0.8)
  const [bg, setBg] = useState<'webcam' | 'dark'>('webcam')
  const [showHands, setShowHands] = useState(true)
  const [handsOn, setHandsOn] = useState(true)
  const [audioOn, setAudioOn] = useState(false)
  const [recording, setRecording] = useState(false)
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth > 700)
  const [status, setStatus] = useState('Chargement…')
  const [error, setError] = useState<string | null>(null)
  const [count, setCount] = useState(0)

  const P = { tool, timbre, scale, root, bpm, turn, bg, showHands, handsOn }
  const paramsRef = useRef(P); paramsRef.current = P
  const cmdRef = useRef<{ type: string; data?: any }[]>([])
  const send = (type: string, data?: any) => { cmdRef.current.push({ type, data }) }
  const synthRef = useRef<Synth | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null), canvasRef = useRef<HTMLCanvasElement>(null), fileRef = useRef<HTMLInputElement>(null)

  /** Le son ne peut démarrer que sur un vrai clic (règle des navigateurs). */
  const startAudio = () => {
    const s = synthRef.current ?? (synthRef.current = new Synth())
    void s.resume().then(() => { setAudioOn(s.running); s.volume = volume; s.reverb = reverb; s.setEcho(echo, bpm) })
  }
  useEffect(() => { const s = synthRef.current; if (s) { s.volume = volume; s.reverb = reverb; s.setEcho(echo, bpm) } }, [volume, reverb, echo, bpm])

  useEffect(() => {
    const video = videoRef.current!, canvas = canvasRef.current!, g = canvas.getContext('2d')!
    let rafId = 0, running = true, W = 1, H = 1
    let landmarker: GestureRecognizer | null = null, stream: MediaStream | null = null
    const clock = handClock(); autoConnectLeap()
    const resize = () => { const d = Math.min(window.devicePixelRatio, 2); W = window.innerWidth; H = window.innerHeight; canvas.width = W * d; canvas.height = H * d; g.setTransform(d, 0, 0, d, 0, 0) }
    resize(); window.addEventListener('resize', resize)

    // ───────── les instruments ─────────
    let things: Thing[] = loadSaved()
    const past: string[] = []
    let seq = 0
    const hits = new Map<string, { t: number; amp: number; pos: number; midi?: number }>()   // dernière fois que chaque instrument a sonné
    const sparks: { x: number; y: number; vx: number; vy: number; t: number; hue: number }[] = []
    const stats = { plucks: 0, drums: 0, bells: 0, last: 0, log: [] as [number, number][] }   // `last` = dernière note de corde jouée (midi)
    const save = () => { try { localStorage.setItem(SAVE_KEY, JSON.stringify({ things })) } catch { /* stockage plein : le morceau reste à l'écran */ } setCount(things.length) }
    const push = () => { past.push(JSON.stringify(things)); if (past.length > 50) past.shift() }
    const add = (t: Omit<Thing, 'id'>) => { push(); things.push({ ...t, id: `m${(seq++).toString(36)}${Date.now().toString(36)}` }); save() }
    const px = (p: P2): P2 => [p[0] * W, p[1] * W]
    const fretCache = new Map<string, { open: number; list: Fret[] }>()
    /** Note à vide et frettes d'une corde, pour la gamme en cours. */
    const tuning = (s: Thing, p: typeof P) => {
      const key = `${s.id}|${dist(s.a, s.b).toFixed(4)}|${p.scale}|${p.root}|${s.timbre}`
      let v = fretCache.get(key)
      if (!v) { const steps = SCALES[p.scale].steps, open = stringMidi(dist(s.a, s.b), p.root, steps, TIMBRES[s.timbre].octave); v = { open, list: frets(open, p.root, steps) }; if (fretCache.size > 400) fretCache.clear(); fretCache.set(key, v) }
      return v
    }
    const hueOf = (t: Thing) => (t.kind === 'string' ? TIMBRES[t.timbre].hue : t.kind === 'drum' ? 12 : t.kind === 'bell' ? 52 : 275)
    const burst = (at: P2, hue: number, n: number) => { const q = px(at); for (let i = 0; i < n; i++) { const a = Math.random() * 6.283, v = 60 + Math.random() * 220; sparks.push({ x: q[0], y: q[1], vx: Math.cos(a) * v, vy: Math.sin(a) * v, t: performance.now(), hue }) } if (sparks.length > 400) sparks.splice(0, sparks.length - 400) }

    // ───────── faire sonner ─────────
    /** Pincer une corde à `t` (0..1). `fretT` : endroit où l'autre main la bloque, s'il y en a un. */
    const pluck = (s: Thing, t: number, vel: number, p: typeof P, fretT: number | null, now: number) => {
      const last = hits.get(s.id); if (last && now - last.t < 70) return
      const { open, list } = tuning(s, p)
      // la partie qui vibre est celle où l'on gratte : la frette se compte depuis le bout opposé
      const midi = fretT === null ? open : frettedMidi(open, list, t > fretT ? fretT : 1 - fretT)
      synthRef.current?.pluck(midiToHz(midi), vel, s.timbre, t)
      hits.set(s.id, { t: now, amp: vel, pos: t, midi }); stats.plucks++; stats.last = midi; if (import.meta.env.DEV && stats.log.length < 2000) stats.log.push([now, midi])
      burst([s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t], hueOf(s), 4 + Math.round(vel * 8))
    }
    const strike = (d: Thing, vel: number, p: typeof P, now: number) => {
      const last = hits.get(d.id); if (last && now - last.t < 90) return
      if (d.kind === 'drum') { const v = drumVoice(dist(d.a, d.b)); synthRef.current?.drum(v.kind, v.hz, vel); stats.drums++ }
      else { synthRef.current?.bell(midiToHz(bellMidi(d.a[1] * W / H, p.root, SCALES[p.scale].steps)), vel); stats.bells++ }
      hits.set(d.id, { t: now, amp: vel, pos: 0.5 }); burst(d.a, hueOf(d), 6)
    }
    const BELL_R = 0.02

    // ───────── mains ─────────
    const hands: Hand[] = [mkHand(), mkHand(), mkHand()]   // deux mains, et la souris en troisième
    const toScreen = (x: number, y: number): P2 => {
      const va = video.videoWidth > 0 ? video.videoWidth / video.videoHeight : W / H
      return W / H > va ? [(1 - x), (H / 2 + (y - 0.5) * W / va) / W] : [(W / 2 + (0.5 - x) * H * va) / W, y * H / W]
    }
    const drop = (h: Hand) => { h.has = false; h.pinch = false; h.raw = false; h.prev = null; h.lm = [] }
    const readHands = (res: HandFrame, now: number) => {
      const list = (res.landmarks ?? []).slice(0, 2)
      const wr = list.map((lm) => toScreen(lm[0].x, lm[0].y))
      const cost = (i: number, s: number) => (hands[s].has && hands[s].lm[0] ? dist(wr[i], hands[s].lm[0]) : 0)
      let order = [0, 1]
      if (list.length === 2) { if (cost(0, 1) + cost(1, 0) < cost(0, 0) + cost(1, 1)) order = [1, 0] }
      else if (list.length === 1) order = [hands[1].has && (!hands[0].has || cost(0, 1) < cost(0, 0)) ? 1 : 0]
      const used = new Set<number>()
      list.forEach((lm, i) => {
        const h = hands[order[i]]; used.add(order[i])
        const raw = isPinching(res, i, h.pinch)
        if (!h.has) { h.since = now; h.prev = null }
        if (raw !== h.raw) { h.raw = raw; h.rawAt = now }
        if (raw && !h.pinch && now - h.rawAt >= 50 && now - h.since >= 250) h.pinch = true
        else if (!raw && h.pinch && now - h.rawAt >= 90) h.pinch = false
        h.lm = lm.map((q: { x: number; y: number }) => toScreen(q.x, q.y))
        h.prev = h.tips.length ? h.tips : null; h.tips = TIPS.map((j) => h.lm[j])
        h.at = [(h.lm[4][0] + h.lm[8][0]) / 2, (h.lm[4][1] + h.lm[8][1]) / 2]
        if (raw || !h.pinch) h.grip = h.at                    // en relâchant, les doigts s'écartent : on garde le dernier point vraiment pincé
        h.has = true; h.seen = now
      })
      for (let i = 0; i < 2; i++) if (!used.has(i)) drop(hands[i])
    }

    // souris : le bouton enfoncé vaut une pince, le pointeur qui passe vaut un doigt
    const mouse = hands[2]
    const where = (e: PointerEvent): P2 => [e.clientX / W, e.clientY / W]
    const onMove = (e: PointerEvent) => { mouse.at = mouse.grip = where(e); mouse.tips = [mouse.at]; mouse.has = true; mouse.seen = performance.now() }
    const onDown = (e: PointerEvent) => { try { canvas.setPointerCapture?.(e.pointerId) } catch { /* pointeur déjà relâché */ } onMove(e); mouse.pinch = true }
    const onUp = () => { mouse.pinch = false }
    const onLeave = () => { if (!mouse.pinch) { mouse.has = false; mouse.prev = null } }
    canvas.addEventListener('pointermove', onMove); canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointerup', onUp); canvas.addEventListener('pointercancel', onUp); canvas.addEventListener('pointerleave', onLeave)

    // ───────── dessiner un instrument ─────────
    let draft: { slot: number; kind: Kind; a: P2; b: P2 } | null = null
    const erased = { on: false }
    const pickNear = (at: P2): Thing | null => {
      let best: Thing | null = null, bd = 0.035
      for (const t of things) {
        const d = t.kind === 'string' ? nearest(at, t.a, t.b).d : t.kind === 'bell' ? dist(at, t.a) : Math.min(dist(at, t.a), Math.abs(dist(at, t.a) - dist(t.a, t.b)))
        if (d < bd) { bd = d; best = t }
      }
      return best
    }
    const edit = (p: typeof P) => {
      if (draft) {
        const h = hands[draft.slot]
        if (h.has && h.pinch) { draft.b = h.grip; return }
        const size = dist(draft.a, draft.b)
        if (size > 0.03) { add({ kind: draft.kind, a: draft.a, b: draft.b, timbre: p.timbre }); setStatus(draft.kind === 'string' ? 'Corde posée : traverse-la du bout des doigts.' : draft.kind === 'drum' ? 'Tambour posé : frappe dedans.' : 'Manège lancé : pose des cordes sur son passage.') }
        else setStatus('Trop petit : pince, écarte la main, puis relâche.')
        draft = null; return
      }
      if (p.tool === 'play') return
      for (let i = 0; i < 3; i++) {
        const h = hands[i]; if (!h.has || !h.pinch) continue
        if (p.tool === 'erase') { const t = pickNear(h.grip); if (t) { if (!erased.on) push(); erased.on = true; things = things.filter((x) => x !== t); hits.delete(t.id); save() } continue }
        if (h.was) continue                                  // seul le début de la pince pose ou commence un instrument
        if (p.tool === 'bell') { add({ kind: 'bell', a: h.grip, b: h.grip, timbre: p.timbre }); setStatus('Clochette posée.') }
        else { draft = { slot: i, kind: p.tool, a: h.grip, b: h.grip }; break }
      }
      if (!hands.some((h) => h.has && h.pinch)) erased.on = false
    }

    // ───────── jouer : les doigts, puis les manèges ─────────
    const play = (p: typeof P, now: number, dt: number) => {
      const pinchers = hands.filter((h) => h.has && h.pinch)
      for (let hi = 0; hi < 3; hi++) {
        const h = hands[hi]
        if (!h.has || !h.prev || h.pinch || (draft && draft.slot === hi)) continue
        h.tips.forEach((cur, f) => {
          const prev = h.prev![f]; if (!prev) return
          const speed = dist(cur, prev) / dt                 // largeurs d'écran par seconde
          if (speed < 0.12 || speed > 12) return             // immobile, ou saut de détection
          const vel = clamp(0.15, 1, speed / 2.2)
          for (const t of things) {
            if (t.kind === 'string') {
              const at = cross(prev, cur, t.a, t.b); if (at === null) continue
              // l'autre main qui pince tout près de la corde la bloque à cet endroit
              let fret: number | null = null
              for (const o of pinchers) { if (o === h) continue; const n = nearest(o.grip, t.a, t.b); if (n.d < 0.035) fret = n.t }
              pluck(t, at, vel, p, fret, now)
            } else if (t.kind !== 'wheel') {
              const r = t.kind === 'drum' ? dist(t.a, t.b) : BELL_R
              if (dist(prev, t.a) > r && dist(cur, t.a) <= r) strike(t, vel, p, now)   // le doigt vient d'entrer
            }
          }
        })
      }
      for (const w of things) {
        if (w.kind !== 'wheel') continue
        const r = dist(w.a, w.b), phase = Math.atan2(w.b[1] - w.a[1], w.b[0] - w.a[0])
        const spot = (b: number): P2 => { const g = phase + b / p.turn * Math.PI * 2; return [w.a[0] + Math.cos(g) * r, w.a[1] + Math.sin(g) * r] }
        const tip = spot(beat), from = spot(prevBeat)   // le rayon maintenant, et à l'image d'avant
        for (const t of things) {
          if (t.kind === 'wheel') continue
          const key = `${w.id}>${t.id}`, was = touching.has(key)
          const at = t.kind === 'string' ? sweep(w.a, from, tip, t.a, t.b) : sweepPoint(w.a, from, tip, t.a, 0.018) ? 0.5 : null
          if (at !== null && !was) { touching.add(key); if (t.kind === 'string') pluck(t, at, 0.6, p, null, now); else strike(t, 0.7, p, now) }
          else if (at === null && was) touching.delete(key)
        }
        arms.set(w.id, tip)
      }
    }
    const touching = new Set<string>(), arms = new Map<string, P2>()
    let beat = 0, prevBeat = 0   // position des manèges, en temps
    /** Un morceau dessiné sur un autre écran peut déborder : on le recentre, sans toucher aux longueurs (donc aux notes). */
    const fit = () => {
      let x0 = 9, x1 = -9, y0 = 9, y1 = -9
      for (const t of things) for (const q of [t.a, t.b]) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]) }
      if (!things.length || (x0 >= 0 && x1 <= 1 && y0 >= 0 && y1 <= H / W)) return
      const dx = 0.5 - (x0 + x1) / 2, dy = H / W / 2 - (y0 + y1) / 2
      things = things.map((t) => ({ ...t, a: [t.a[0] + dx, t.a[1] + dy], b: [t.b[0] + dx, t.b[1] + dy] }))
    }

    // ───────── commandes du panneau ─────────
    const run = (c: { type: string; data?: any }) => {
      if (c.type === 'undo') { if (past.length) { things = JSON.parse(past.pop()!); save(); setStatus('↶ Annulé.') } else setStatus('Rien à annuler.') }
      else if (c.type === 'clear') { if (things.length) { push(); things = []; touching.clear(); save(); setStatus('Tout est effacé. « Annuler » pour retrouver le morceau.') } }
      else if (c.type === 'example') { push(); things = example(H / W); touching.clear(); beat = prevBeat = 0; save(); setStatus('Exemple chargé : écoute le manège, puis ajoute tes cordes.') }
      else if (c.type === 'load') {   // fichier venu d'ailleurs : on ne garde que ce qui a la bonne forme
        const f = c.data ?? {}, st = f.settings ?? {}
        const list = (Array.isArray(f.things) ? f.things as Thing[] : []).filter((t) => t && okPoint(t.a) && okPoint(t.b) && ['string', 'drum', 'bell', 'wheel'].includes(t.kind)).slice(0, 400)
          .map((t, i) => ({ ...t, id: typeof t.id === 'string' ? t.id : `f${i}`, a: [t.a[0], t.a[1]] as P2, b: [t.b[0], t.b[1]] as P2, timbre: okTimbre(t.timbre) ? t.timbre : 'harp' }))
        if (!list.length) { setStatus("Ce fichier ne contient aucun instrument lisible : rien n'a été changé."); return }
        push(); things = list
        if (okScale(st.scale)) setScale(st.scale); if (okRoot(st.root)) setRoot(st.root); if (okBpm(st.bpm)) setBpm(Math.round(st.bpm)); if (okTurn(st.turn)) setTurn(+st.turn)
        fit(); touching.clear(); beat = prevBeat = -1; save()   // le manège repart un temps avant le début
        setStatus(typeof f.title === 'string' ? `« ${f.title.slice(0, 80)} » : ${things.length} instruments. Active le son et écoute, puis joue par-dessus.` : `Morceau chargé : ${things.length} instruments.`)
      }
      else if (c.type === 'save') { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify({ app: 'digiart-lutherie', version: 1, settings: { scale: paramsRef.current.scale, root: paramsRef.current.root, bpm: paramsRef.current.bpm, turn: paramsRef.current.turn }, things })], { type: 'application/json' })); a.download = `morceau-${Date.now()}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1500) }
      else if (c.type === 'record') toggleRecord()
    }

    // ───────── enregistrement : l'image et le son ensemble ─────────
    let recorder: MediaRecorder | null = null
    const toggleRecord = () => {
      if (recorder) { recorder.stop(); return }
      const synth = synthRef.current
      if (!synth?.running) { setStatus('Active d\'abord le son pour enregistrer.'); return }
      const media = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...synth.stream.getAudioTracks()])
      const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m))
      const chunks: Blob[] = []
      try { recorder = new MediaRecorder(media, mime ? { mimeType: mime } : undefined) } catch (e: any) { setStatus(`Enregistrement impossible : ${e?.message ?? e}`); return }
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
      recorder.onstop = () => { recorder = null; setRecording(false); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' })); a.download = `lutherie-${Date.now()}.webm`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 3000); setStatus('Vidéo enregistrée (image et son).') }
      recorder.start(); setRecording(true); setStatus('Enregistrement en cours…')
    }

    // ───────── dessin à l'écran ─────────
    const glow = (hue: number, light: number, alpha: number, width: number, blur: number) => { g.strokeStyle = `hsla(${hue},95%,${light}%,${alpha})`; g.lineWidth = width; g.shadowColor = `hsla(${hue},100%,60%,0.9)`; g.shadowBlur = blur }
    const label = (text: string, x: number, y: number, hue: number) => { g.shadowBlur = 0; g.font = '600 12px system-ui'; g.textAlign = 'center'; g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.75)'; g.strokeText(text, x, y); g.fillStyle = `hsl(${hue},90%,82%)`; g.fillText(text, x, y) }
    const drawString = (s: { a: P2; b: P2 }, hue: number, tune: { open: number; list: Fret[] } | null, hit: { t: number; amp: number; pos: number; midi?: number } | undefined, now: number) => {
      const A = px(s.a), B = px(s.b), dx = B[0] - A[0], dy = B[1] - A[1], len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len
      const age = hit ? (now - hit.t) / 1000 : 9, amp = hit && age < 2.5 ? hit.amp * 14 * Math.exp(-age * 2.6) : 0
      glow(hue, amp > 0.5 ? 82 : 70, 0.95, 2.2, amp > 0.5 ? 18 : 9)
      g.beginPath()
      if (amp > 0.3) {   // la corde vibre : un ventre dont la bosse part de l'endroit du pincement
        for (let i = 0; i <= 40; i++) { const u = i / 40, w = Math.sin(Math.PI * u) * Math.sin(age * 55 + (u - hit!.pos) * 4) * amp; const x = A[0] + dx * u + nx * w, y = A[1] + dy * u + ny * w; if (i) g.lineTo(x, y); else g.moveTo(x, y) }
      } else { g.moveTo(A[0], A[1]); g.lineTo(B[0], B[1]) }
      g.stroke()
      g.shadowBlur = 0; g.lineWidth = 1.2; g.strokeStyle = `hsla(${hue},90%,85%,0.85)`
      for (const end of [A, B]) { g.beginPath(); g.arc(end[0], end[1], 4, 0, 6.283); g.moveTo(end[0] - nx * 9, end[1] - ny * 9); g.lineTo(end[0] + nx * 9, end[1] + ny * 9); g.stroke() }
      if (tune) {
        for (const f of tune.list) { const x = A[0] + dx * f.t, y = A[1] + dy * f.t, big = (f.midi - tune.open) % 12 === 0 ? 7 : 4; g.beginPath(); g.moveTo(x, y); g.lineTo(x + nx * big, y + ny * big); g.stroke() }
        if (things.length <= 24 || s === draft || age < 1.2) label(noteName(hit && age < 1.2 && hit.midi !== undefined ? hit.midi : tune.open), A[0] - nx * 16, A[1] - ny * 16 + 4, hue)
      }
    }

    let lastT = performance.now()
    const loop = () => {
      if (!running) return
      const p = paramsRef.current, now = performance.now(), dt = clamp(0.004, 0.1, (now - lastT) / 1000); lastT = now
      for (const c of cmdRef.current.splice(0)) run(c)
      const res = p.handsOn ? pollHands(video, landmarker, clock) : null
      if (res) readHands(res, now)
      for (let i = 0; i < 2; i++) if (hands[i].has && now - hands[i].seen > 350) drop(hands[i])
      if (mouse.has && !mouse.pinch && now - mouse.seen > 1500) { mouse.has = false; mouse.prev = null }
      edit(p)
      prevBeat = beat; beat += dt * p.bpm / 60
      play(p, now, dt)
      for (const h of hands) { h.was = h.pinch; if (h === mouse) h.prev = h.has ? [h.at] : null }

      // fond : la caméra en miroir, assombrie pour que les instruments ressortent
      g.shadowBlur = 0
      if (p.bg === 'webcam' && video.readyState >= 2 && video.videoWidth) {
        const va = video.videoWidth / video.videoHeight, dw = W / H > va ? W : H * va, dh = W / H > va ? W / va : H
        g.save(); g.translate(W, 0); g.scale(-1, 1); g.drawImage(video, (W - dw) / 2, (H - dh) / 2, dw, dh); g.restore()
        g.fillStyle = 'rgba(4,6,14,0.38)'; g.fillRect(0, 0, W, H)
      } else { g.fillStyle = '#05060d'; g.fillRect(0, 0, W, H) }

      for (const t of things) {
        const hue = hueOf(t), hit = hits.get(t.id), age = hit ? (now - hit.t) / 1000 : 9
        if (t.kind === 'string') drawString(t, hue, tuning(t, p), hit, now)
        else if (t.kind === 'wheel') {
          const c = px(t.a), r = dist(t.a, t.b) * W, tip = px(arms.get(t.id) ?? t.b)
          glow(hue, 70, 0.4, 1.2, 0); g.setLineDash([4, 8]); g.beginPath(); g.arc(c[0], c[1], r, 0, 6.283); g.stroke(); g.setLineDash([])
          glow(hue, 78, 0.95, 2.2, 12); g.beginPath(); g.moveTo(c[0], c[1]); g.lineTo(tip[0], tip[1]); g.stroke()
          g.shadowBlur = 0; g.fillStyle = `hsl(${hue},90%,80%)`; g.beginPath(); g.arc(c[0], c[1], 5, 0, 6.283); g.fill(); g.beginPath(); g.arc(tip[0], tip[1], 4, 0, 6.283); g.fill()
        } else {
          const c = px(t.a), r = (t.kind === 'drum' ? dist(t.a, t.b) : BELL_R) * W, pop = age < 0.25 ? 1 + (0.25 - age) * 0.5 : 1
          glow(hue, age < 0.25 ? 85 : 68, 0.95, 2.2, age < 0.4 ? 22 : 8); g.beginPath(); g.arc(c[0], c[1], r * pop, 0, 6.283); g.stroke()
          g.fillStyle = `hsla(${hue},95%,60%,${age < 0.3 ? 0.35 - age : 0.07})`; g.fill()
          if (t.kind === 'drum') { const v = drumVoice(dist(t.a, t.b)); label(v.kind === 'kick' ? 'Grosse caisse' : v.kind === 'tom' ? 'Tom' : 'Charleston', c[0], c[1] + 4, hue) }
          else label(noteName(bellMidi(t.a[1] * W / H, p.root, SCALES[p.scale].steps)), c[0], c[1] - r - 6, hue)
        }
      }
      if (draft) {   // l'instrument en cours de dessin, avec sa note annoncée
        const hue = draft.kind === 'string' ? TIMBRES[p.timbre].hue : draft.kind === 'drum' ? 12 : 275
        if (draft.kind === 'string') { const steps = SCALES[p.scale].steps, open = stringMidi(dist(draft.a, draft.b), p.root, steps, TIMBRES[p.timbre].octave); drawString(draft, hue, { open, list: frets(open, p.root, steps) }, undefined, now) }
        else { const c = px(draft.a), r = dist(draft.a, draft.b) * W; glow(hue, 75, 0.9, 2, 10); g.beginPath(); g.arc(c[0], c[1], r, 0, 6.283); g.stroke(); if (draft.kind === 'drum') { const v = drumVoice(dist(draft.a, draft.b)); label(v.kind === 'kick' ? 'Grosse caisse' : v.kind === 'tom' ? 'Tom' : 'Charleston', c[0], c[1] + 4, hue) } }
      }
      // étincelles
      g.shadowBlur = 0; g.lineWidth = 1.6
      for (let i = sparks.length - 1; i >= 0; i--) { const s = sparks[i], a = (now - s.t) / 1000; if (a > 0.6) { sparks.splice(i, 1); continue } const x = s.x + s.vx * a, y = s.y + s.vy * a; g.strokeStyle = `hsla(${s.hue},100%,80%,${1 - a / 0.6})`; g.beginPath(); g.moveTo(x, y); g.lineTo(x - s.vx * 0.03, y - s.vy * 0.03); g.stroke() }
      // mains
      for (let i = 0; i < 2; i++) {
        const h = hands[i]; if (!h.has || !h.lm.length) continue
        if (p.showHands) { g.lineWidth = 2; g.strokeStyle = 'rgba(255,255,255,0.45)'; for (const ch of FINGER_CHAINS) { g.beginPath(); ch.forEach((ci, n) => { const q = px(h.lm[ci]); if (n) g.lineTo(q[0], q[1]); else g.moveTo(q[0], q[1]) }); g.stroke() } }
        for (const tip of h.tips) { const q = px(tip); g.beginPath(); g.arc(q[0], q[1], 5, 0, 6.283); g.fillStyle = h.pinch ? '#ffd200' : 'rgba(255,255,255,0.85)'; g.fill() }
        if (h.pinch) { const q = px(h.grip); g.beginPath(); g.arc(q[0], q[1], 11, 0, 6.283); g.lineWidth = 3; g.strokeStyle = '#ffd200'; g.stroke() }
      }
      rafId = requestAnimationFrame(loop)
    }

    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement; if (t && /INPUT|SELECT|TEXTAREA/.test(t.tagName)) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); send('undo') }
      else if (/^[1-6]$/.test(e.key)) setTool(TOOLS[+e.key - 1].id)
      else if (e.key === ' ' && !(t && t.tagName === 'BUTTON')) { e.preventDefault(); setHandsOn((v) => !v) }
    }
    window.addEventListener('keydown', onKey)
    if (import.meta.env.DEV) (window as any).__music = { stats, hands, get things() { return things }, get synth() { return synthRef.current } }   // pour les essais automatisés

    const init = async () => {
      setCount(things.length); loop()
      setStatus('Prêt à la souris. Caméra en cours de démarrage…')
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false }).catch(() => navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false }))
        if (!running) { stream.getTracks().forEach((t) => t.stop()); return }
        video.srcObject = stream; await new Promise<void>((res) => { video.onloadedmetadata = () => res() }); await video.play()
        const files = await FilesetResolver.forVisionTasks(WASM_BASE)
        landmarker = await GestureRecognizer.createFromOptions(files, { baseOptions: { modelAssetPath: GESTURE_MODEL_URL, delegate: 'GPU' }, runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.45, minHandPresenceConfidence: 0.3, minTrackingConfidence: 0.3 })
        setStatus('Prêt : pince pour dessiner une corde, puis traverse-la du bout des doigts ✦')
      } catch (e: any) { setError(`Caméra ou modèle indisponible (${e?.message ?? e}). Le Leap Motion et la souris restent utilisables.`); setStatus('Prêt : souris ou Leap Motion.') }
    }
    init()

    return () => {
      running = false; if (rafId) cancelAnimationFrame(rafId)
      window.removeEventListener('resize', resize); window.removeEventListener('keydown', onKey)
      canvas.removeEventListener('pointermove', onMove); canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointercancel', onUp); canvas.removeEventListener('pointerleave', onLeave)
      try { recorder?.stop() } catch { /* déjà arrêté */ }
      try { landmarker?.close() } catch { /* noop */ }
      if (stream) stream.getTracks().forEach((t) => t.stop()); video.srcObject = null
      synthRef.current?.close(); synthRef.current = null
    }
  }, [])

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; e.target.value = ''; if (!f) return
    f.text().then((t) => { const d = JSON.parse(t); if (!Array.isArray(d.things)) throw new Error('pas de liste d\'instruments'); send('load', d) }).catch((err) => setError(`Fichier illisible : ${err?.message ?? err}`))
  }

  const hint = TOOLS.find((t) => t.id === tool)?.hint ?? ''
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#05060d', overflow: 'hidden', userSelect: 'none', fontFamily: 'system-ui' }}>
      <video ref={videoRef} autoPlay playsInline muted style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }} />
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100vw', height: '100vh', touchAction: 'none', cursor: 'crosshair' }} />

      {!audioOn && (
        <button onClick={startAudio} style={{ position: 'absolute', left: 0, right: 0, top: '42%', margin: '0 auto', width: 'fit-content', zIndex: 12, padding: '16px 26px', borderRadius: 14, border: '2px solid #ffd200', background: 'rgba(10,12,18,0.9)', color: '#ffd200', fontSize: 18, fontWeight: 700, cursor: 'pointer', boxShadow: '0 0 40px rgba(255,210,0,0.35)' }}>
          🔊 Activer le son
        </button>
      )}

      <div role="toolbar" aria-label="Outils" style={{ position: 'absolute', bottom: 14, left: 0, right: 0, margin: '0 auto', width: 'fit-content', boxSizing: 'border-box', zIndex: 10, display: 'flex', gap: 6, padding: 6, borderRadius: 14, background: 'rgba(10,12,18,0.82)', border: '1px solid rgba(255,255,255,0.15)', backdropFilter: 'blur(10px)', maxWidth: 'calc(100vw - 24px)', overflowX: 'auto' }}>
        {TOOLS.map((t, i) => (
          <button key={t.id} onClick={() => setTool(t.id)} aria-pressed={tool === t.id} title={`${t.label} (${i + 1}) — ${t.hint}`} style={{ ...bar, border: `1px solid ${tool === t.id ? '#ffd200' : 'transparent'}`, background: tool === t.id ? 'rgba(255,210,0,0.2)' : 'transparent' }}>
            <div style={{ fontSize: 20, lineHeight: 1.2 }}>{t.icon}</div>{t.label}
          </button>
        ))}
        <span style={{ width: 1, background: 'rgba(255,255,255,0.2)', margin: '4px 2px', flexShrink: 0 }} />
        <button onClick={() => setHandsOn((v) => !v)} aria-pressed={handsOn} title="Suivi des mains (barre d'espace)" style={{ ...bar, color: handsOn ? '#fff' : '#ffd200' }}><div style={{ fontSize: 20, lineHeight: 1.2 }}>{handsOn ? '🖐' : '⏸'}</div>{handsOn ? 'Mains' : 'En pause'}</button>
        <button onClick={() => send('undo')} title="Annuler (Ctrl+Z)" style={bar}><div style={{ fontSize: 20, lineHeight: 1.2 }}>↶</div>Annuler</button>
        <button onClick={() => send('record')} aria-pressed={recording} title="Enregistrer une vidéo du morceau, image et son" style={{ ...bar, color: recording ? '#ff5d5d' : '#fff' }}><div style={{ fontSize: 20, lineHeight: 1.2 }}>{recording ? '⏹' : '⏺'}</div>{recording ? 'Arrêter' : 'Filmer'}</button>
        <button onClick={() => send('clear')} disabled={!count} title="Effacer tous les instruments (annulable)" style={{ ...bar, color: '#ff8a8a', opacity: count ? 1 : 0.4 }}><div style={{ fontSize: 20, lineHeight: 1.2 }}>🗑</div>Tout effacer</button>
      </div>

      {!panelOpen && <button onClick={() => setPanelOpen(true)} aria-label="Ouvrir le panneau" style={{ position: 'absolute', top: 16, left: 16, zIndex: 11, ...sel, width: 'auto', padding: '8px 12px' }}>☰</button>}
      {panelOpen && (
        <div style={{ position: 'absolute', top: 16, left: 16, zIndex: 10, width: 300, maxWidth: 'calc(100vw - 32px)', boxSizing: 'border-box', background: 'rgba(10,10,15,0.86)', padding: 16, borderRadius: 16, backdropFilter: 'blur(10px)', border: '1px solid rgba(255,255,255,0.15)', boxShadow: '0 10px 30px rgba(0,0,0,0.5)', maxHeight: 'calc(100vh - 110px)', overflowY: 'auto', color: '#ccc' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <strong style={{ color: '#ffd200', textTransform: 'uppercase', letterSpacing: 1, fontSize: 14 }}>Lutherie d'air</strong>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Link to="/" style={{ color: '#aaa', fontSize: 12, textDecoration: 'none' }}>← Studio</Link><button onClick={() => setPanelOpen(false)} aria-label="Replier le panneau" style={{ background: 'transparent', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: 16 }}>«</button></div>
          </div>
          <div role="status" style={{ color: '#8d8d99', fontSize: 11, marginBottom: 8, lineHeight: 1.35 }}>{status}</div>
          {error && <div role="alert" style={{ color: '#ff6b6b', fontSize: 11, marginBottom: 8, lineHeight: 1.35 }}>{error}</div>}
          <div style={{ fontSize: 11, color: '#ffd200', marginBottom: 10, lineHeight: 1.4, background: 'rgba(255,210,0,0.08)', padding: 8, borderRadius: 6 }}>
            <b>{TOOLS.find((t) => t.id === tool)?.label}</b> — {hint}<br />
            🎸 Avec l'outil Jouer : pince une corde d'une main sur une graduation, gratte de l'autre, la note change.<br />
            🖱️ Souris : glisser = pince, passer sur une corde = la pincer.
          </div>

          <button onClick={() => send('example')} style={{ ...sel, marginBottom: 12, borderColor: '#ffd200', color: '#ffd200' }}>🎼 Charger un morceau d'exemple</button>
          {pieces.length > 0 && (
            <select value="" aria-label="Morceaux connus" style={{ ...sel, marginBottom: 12 }} onChange={(e) => {
              const id = e.target.value; if (!id) return
              fetch(`/morceaux/${encodeURIComponent(id)}.json`).then((r) => { if (!r.ok) throw new Error(`réponse ${r.status}`); return r.json() }).then((d) => { setError(null); send('load', d) }).catch((err) => setError(`Morceau indisponible : ${err?.message ?? err}`))
            }}>
              <option value="">🎵 Morceaux connus…</option>
              {pieces.map((m) => <option key={m.id} value={m.id}>{m.title} — {m.style}</option>)}
            </select>
          )}
          <LeapToggle accent="#ffd200" />

          <Field label="Son des cordes"><select value={timbre} onChange={(e) => setTimbre(e.target.value as Timbre)} style={sel}>{(Object.keys(TIMBRES) as Timbre[]).map((k) => <option key={k} value={k}>{TIMBRES[k].label}</option>)}</select></Field>
          <Field label="Gamme"><select value={scale} onChange={(e) => setScale(e.target.value)} style={sel}>{Object.entries(SCALES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
          <Field label="Tonalité"><select value={root} onChange={(e) => setRoot(+e.target.value)} style={sel}>{NOTE_NAMES.map((n, i) => <option key={n} value={i}>{n}</option>)}</select></Field>
          <Field label={`Tempo — ${bpm} à la minute`}><input type="range" min={40} max={180} value={bpm} onChange={(e) => setBpm(+e.target.value)} style={rng} /></Field>
          <Field label="Un tour de manège"><select value={turn} onChange={(e) => setTurn(+e.target.value)} style={sel}>{TURNS.map(([n, l]) => <option key={n} value={n}>{n} temps ({l})</option>)}{!TURNS.some(([n]) => n === turn) && <option value={turn}>{turn} temps</option>}</select></Field>
          <Field label={`Réverbération — ${Math.round(reverb * 100)} %`}><input type="range" min={0} max={1} step={0.05} value={reverb} onChange={(e) => setReverb(+e.target.value)} style={rng} /></Field>
          <Field label={`Écho — ${Math.round(echo * 100)} %`}><input type="range" min={0} max={1} step={0.05} value={echo} onChange={(e) => setEcho(+e.target.value)} style={rng} /></Field>
          <Field label={`Volume — ${Math.round(volume * 100)} %`}><input type="range" min={0} max={1} step={0.05} value={volume} onChange={(e) => setVolume(+e.target.value)} style={rng} /></Field>
          <Field label="Fond"><select value={bg} onChange={(e) => setBg(e.target.value as 'webcam' | 'dark')} style={sel}><option value="webcam">Caméra (réalité augmentée)</option><option value="dark">Noir</option></select></Field>
          <label style={chk}><input type="checkbox" checked={showHands} onChange={(e) => setShowHands(e.target.checked)} /> Squelette des mains</label>

          <div style={{ fontSize: 10, color: '#ffd200', textTransform: 'uppercase', letterSpacing: 1, margin: '6px 0' }}>Morceau ({count} instruments)</div>
          <div style={{ display: 'flex', gap: 6 }}><button onClick={() => send('save')} style={{ ...sel, flex: 1 }}>Enregistrer</button><button onClick={() => fileRef.current?.click()} style={{ ...sel, flex: 1 }}>Ouvrir</button></div>
          <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={onFile} />
          <p style={{ color: '#777', fontSize: 10, margin: '10px 0 0', lineHeight: 1.4 }}>Le morceau se garde tout seul dans ce navigateur. « Filmer » en fait une vidéo avec le son.</p>
        </div>
      )}
    </div>
  )
}

const sel: React.CSSProperties = { width: '100%', boxSizing: 'border-box', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', color: 'white', padding: 8, borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: 13 }
const bar: React.CSSProperties = { minWidth: 58, flexShrink: 0, padding: '6px 4px', borderRadius: 10, cursor: 'pointer', border: '1px solid transparent', background: 'transparent', color: '#fff', fontSize: 11, fontWeight: 600 }
const rng: React.CSSProperties = { width: '100%', accentColor: '#ffd200' }
const chk: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: '#ccc', margin: '6px 0 10px', cursor: 'pointer' }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return (<label style={{ display: 'block', marginBottom: 12 }}><div style={{ fontSize: 11, color: '#ffd200', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5 }}>{label}</div>{children}</label>) }
