/**
 * Mandala Studio AR — a kaleidoscopic hand-drawing instrument.
 *
 * The user's index finger paints strokes that are mirrored around the canvas
 * center into N-fold radial symmetry, producing live generative mandalas over
 * the webcam feed. Pinch (thumb+index) boosts stroke intensity; two hands can
 * be energetically linked.
 *
 * Adapted from a standalone TensorFlow-handpose prototype to the app's stack :
 *  - Uses @mediapipe/tasks-vision HandLandmarker (GPU, already a dependency)
 *    with numHands:2 instead of pulling the heavy TF.js CDN bundles.
 *  - Proper React lifecycle : camera + landmarker + rAF are all torn down on
 *    unmount, so navigating away releases the webcam cleanly.
 *  - Additions : PNG export, audio-reactive hue/glow (taps senseBus.audio),
 *    app-themed control panel, graceful camera-permission failure.
 */
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision'
import { senseBus } from '../senses/SenseBus'
import { startAudio } from '../senses/Audio'

const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

type DrawStyle = 'lines' | 'points' | 'stars'
type GenMode = 'classic' | 'quantum' | 'sonic' | 'sacred' | 'cyberpunk'
const QUANTUM_N = 380   // particle pool size for Fluide Quantique

interface MandalaElement {
  type: DrawStyle
  x1: number; y1: number
  x2?: number; y2?: number
  size: number
  hue: number
  alpha: number
  isPinching: boolean
}

// MediaPipe HandLandmarker indices
const TIP_THUMB = 4
const TIP_INDEX = 8
const FINGER_CHAINS: number[][] = [
  [0, 1, 2, 3, 4],      // thumb
  [0, 5, 6, 7, 8],      // index
  [0, 9, 10, 11, 12],   // middle
  [0, 13, 14, 15, 16],  // ring
  [0, 17, 18, 19, 20],  // pinky
]

export function MandalaStudio() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const [genMode, setGenMode] = useState<GenMode>('classic')
  const [style, setStyle] = useState<DrawStyle>('lines')
  const [segments, setSegments] = useState(12)
  const [size, setSize] = useState(6)
  const [fade, setFade] = useState(15)        // 100 = persistant (infini)
  const [skeleton, setSkeleton] = useState(true)
  const [interconnect, setInterconnect] = useState(true)
  const [audioReact, setAudioReact] = useState(true)
  const [crystal, setCrystal] = useState(true)
  const [volumetric, setVolumetric] = useState(true)
  const [permanent, setPermanent] = useState(false)             // tracé non-éphémère (pour export propre)
  const [bgMode, setBgMode] = useState<'webcam' | 'black' | 'color'>('webcam')
  const [bgColor, setBgColor] = useState('#05060f')
  const [panelOpen, setPanelOpen] = useState(true)
  const [status, setStatus] = useState('Initialisation de la caméra et du modèle…')
  const [error, setError] = useState<string | null>(null)

  // The render loop reads parameters through a ref so slider changes apply live
  // without re-subscribing the rAF closure.
  const paramsRef = useRef({ genMode, style, segments, size, fade, skeleton, interconnect, audioReact, crystal, volumetric, permanent })
  paramsRef.current = { genMode, style, segments, size, fade, skeleton, interconnect, audioReact, crystal, volumetric, permanent }

  const pathsRef = useRef<MandalaElement[]>([])
  const lastPosRef = useRef<Record<number, { x: number; y: number }>>({})
  const clearRef = useRef(false)
  // Generative-mode state pools (persist across frames)
  const quantumRef = useRef<{ px: Float32Array; py: Float32Array; vx: Float32Array; vy: Float32Array; hue: Float32Array } | null>(null)
  const ringsRef = useRef<{ x: number; y: number; r: number; vel: number; hue: number; life: number }[]>([])
  const velPosRef = useRef<Record<number, { x: number; y: number }>>({})
  // Smoothed pseudo-3D state (volumetric effect): depth 0..1 (far→near),
  // tilt -1..1 (hand horizontal position → pivot angle).
  const depthRef = useRef(0)
  const tiltRef = useRef(0)

  useEffect(() => {
    const video = videoRef.current!
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    let landmarker: HandLandmarker | null = null
    let stream: MediaStream | null = null
    let rafId = 0
    let running = true
    let hueBase = 0
    let lastVideoTime = -1

    const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight }
    resize()
    window.addEventListener('resize', resize)

    const renderElement = (el: MandalaElement, segCount: number) => {
      const cx = canvas.width / 2, cy = canvas.height / 2
      ctx.save()
      ctx.translate(cx, cy)
      const r1 = Math.hypot(el.x1 - cx, el.y1 - cy)
      const a1base = Math.atan2(el.y1 - cy, el.x1 - cx)
      let r2 = 0, a2base = 0
      if (el.type === 'lines' && el.x2 != null) {
        r2 = Math.hypot(el.x2 - cx, el.y2! - cy)
        a2base = Math.atan2(el.y2! - cy, el.x2 - cx)
      }
      for (let i = 0; i < segCount; i++) {
        const off = (i * Math.PI * 2) / segCount
        const dx1 = Math.cos(a1base + off) * r1
        const dy1 = Math.sin(a1base + off) * r1
        ctx.fillStyle = ctx.strokeStyle = `hsla(${el.hue}, 100%, 60%, ${el.alpha})`
        ctx.shadowBlur = el.isPinching ? 25 : 8
        ctx.shadowColor = ctx.fillStyle as string
        if (el.type === 'lines' && el.x2 != null) {
          const dx2 = Math.cos(a2base + off) * r2
          const dy2 = Math.sin(a2base + off) * r2
          ctx.lineWidth = el.size
          ctx.lineCap = 'round'
          ctx.beginPath(); ctx.moveTo(dx1, dy1); ctx.lineTo(dx2, dy2); ctx.stroke()
        } else if (el.type === 'stars') {
          ctx.beginPath()
          ctx.arc(dx1, dy1, el.size * 1.5, 0, Math.PI * 2)
          ctx.rect(dx1 - el.size, dy1 - el.size, el.size * 2, el.size * 2)
          ctx.fill()
        } else {
          ctx.beginPath(); ctx.arc(dx1, dy1, el.size, 0, Math.PI * 2); ctx.fill()
        }
      }
      ctx.restore()
    }

    // CRYSTAL : draw a kaleidoscoped web connecting the five fingertips + palm.
    // Triggered when the fingers close together (shadow-puppet gesture). The
    // crystal is rendered live every frame (not accumulated) so it follows the
    // hand, and is mirrored N-fold like the rest of the mandala.
    const renderCrystal = (pts: { x: number; y: number }[], palm: { x: number; y: number }, segCount: number, hue: number, intensity: number) => {
      const cx = canvas.width / 2, cy = canvas.height / 2
      const nodes = [...pts, palm]
      // Edge list : every pair of nodes (complete graph) → dense crystalline lattice.
      const edges: [number, number][] = []
      for (let a = 0; a < nodes.length; a++) for (let b = a + 1; b < nodes.length; b++) edges.push([a, b])
      ctx.save()
      ctx.translate(cx, cy)
      ctx.lineCap = 'round'
      for (let s = 0; s < segCount; s++) {
        const off = (s * Math.PI * 2) / segCount
        for (const [ia, ib] of edges) {
          const A = nodes[ia], B = nodes[ib]
          const rA = Math.hypot(A.x - cx, A.y - cy), aA = Math.atan2(A.y - cy, A.x - cx) + off
          const rB = Math.hypot(B.x - cx, B.y - cy), aB = Math.atan2(B.y - cy, B.x - cx) + off
          ctx.strokeStyle = `hsla(${hue}, 100%, ${55 + intensity * 25}%, ${0.25 + intensity * 0.55})`
          ctx.lineWidth = 1 + intensity * 2
          ctx.shadowBlur = 6 + intensity * 18
          ctx.shadowColor = ctx.strokeStyle
          ctx.beginPath()
          ctx.moveTo(Math.cos(aA) * rA, Math.sin(aA) * rA)
          ctx.lineTo(Math.cos(aB) * rB, Math.sin(aB) * rB)
          ctx.stroke()
        }
      }
      ctx.restore()
    }

    // Run a draw callback rotated `seg` times around the canvas center.
    const kaleido = (seg: number, drawFn: () => void) => {
      const cx = canvas.width / 2, cy = canvas.height / 2
      const n = Math.max(1, Math.min(seg, 48))
      for (let s = 0; s < n; s++) {
        ctx.save(); ctx.translate(cx, cy); ctx.rotate((s * Math.PI * 2) / n); ctx.translate(-cx, -cy)
        drawFn(); ctx.restore()
      }
    }

    // Compact Bowyer-Watson Delaunay for a small point set → triangle index triples.
    const delaunay = (pts: { x: number; y: number }[]): [number, number, number][] => {
      const n = pts.length
      if (n < 3) return []
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const p of pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y) }
      const dmax = Math.max(maxX - minX, maxY - minY) || 1
      const mx = (minX + maxX) / 2, my = (minY + maxY) / 2
      const V = pts.concat([{ x: mx - 20 * dmax, y: my - dmax }, { x: mx, y: my + 20 * dmax }, { x: mx + 20 * dmax, y: my - dmax }])
      const circum = (a: number, b: number, c: number) => {
        const ax = V[a].x, ay = V[a].y, bx = V[b].x, by = V[b].y, cx = V[c].x, cy = V[c].y
        const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
        if (Math.abs(d) < 1e-9) return { ux: 0, uy: 0, r2: Infinity }
        const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d
        const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d
        return { ux, uy, r2: (ax - ux) ** 2 + (ay - uy) ** 2 }
      }
      let tris: [number, number, number][] = [[n, n + 1, n + 2]]
      for (let i = 0; i < n; i++) {
        const bad: [number, number, number][] = []
        for (const t of tris) { const c = circum(t[0], t[1], t[2]); if ((V[i].x - c.ux) ** 2 + (V[i].y - c.uy) ** 2 < c.r2) bad.push(t) }
        const poly: [number, number][] = []
        for (const t of bad) {
          for (const e of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]] as [number, number][]) {
            const shared = bad.some((o) => o !== t && [[o[0], o[1]], [o[1], o[2]], [o[2], o[0]]].some(([a, b]) => (a === e[0] && b === e[1]) || (a === e[1] && b === e[0])))
            if (!shared) poly.push(e)
          }
        }
        tris = tris.filter((t) => !bad.includes(t))
        for (const e of poly) tris.push([e[0], e[1], i])
      }
      return tris.filter((t) => t[0] < n && t[1] < n && t[2] < n)
    }

    // ── MODE: Fluide Quantique — particles attracted to fingertips ──────────
    const renderQuantum = (attractors: { x: number; y: number; hue: number }[], seg: number, bass: number) => {
      if (!quantumRef.current) {
        const q = { px: new Float32Array(QUANTUM_N), py: new Float32Array(QUANTUM_N), vx: new Float32Array(QUANTUM_N), vy: new Float32Array(QUANTUM_N), hue: new Float32Array(QUANTUM_N) }
        for (let i = 0; i < QUANTUM_N; i++) { q.px[i] = Math.random() * canvas.width; q.py[i] = Math.random() * canvas.height; q.hue[i] = Math.random() * 360 }
        quantumRef.current = q
      }
      const q = quantumRef.current
      const damp = 0.96
      for (let i = 0; i < QUANTUM_N; i++) {
        let ax = 0, ay = 0
        for (const a of attractors) {
          const dx = a.x - q.px[i], dy = a.y - q.py[i]
          const d2 = dx * dx + dy * dy + 400
          const f = 12000 / d2
          ax += dx * f / Math.sqrt(d2); ay += dy * f / Math.sqrt(d2)
          // tangential component → orbiting vortex
          ax += -dy * f * 0.6 / Math.sqrt(d2); ay += dx * f * 0.6 / Math.sqrt(d2)
        }
        q.vx[i] = (q.vx[i] + ax) * damp
        q.vy[i] = (q.vy[i] + ay) * damp
        q.px[i] += q.vx[i]; q.py[i] += q.vy[i]
        // wrap
        if (q.px[i] < 0) q.px[i] += canvas.width; else if (q.px[i] > canvas.width) q.px[i] -= canvas.width
        if (q.py[i] < 0) q.py[i] += canvas.height; else if (q.py[i] > canvas.height) q.py[i] -= canvas.height
      }
      const segN = Math.min(seg, 8)   // cap symmetry copies for perf
      const r = 1.4 + bass * 2
      kaleido(segN, () => {
        for (let i = 0; i < QUANTUM_N; i++) {
          const spd = Math.min(1, Math.hypot(q.vx[i], q.vy[i]) / 12)
          ctx.fillStyle = `hsla(${(q.hue[i] + spd * 120) % 360}, 100%, ${55 + spd * 30}%, ${0.5 + spd * 0.4})`
          ctx.fillRect(q.px[i] - r, q.py[i] - r, r * 2, r * 2)
        }
      })
    }

    // ── MODE: Ondes de Choc — expanding rings from fast moves / pinch ───────
    const renderSonic = (seg: number) => {
      const rings = ringsRef.current
      ctx.lineCap = 'round'
      const segN = Math.min(seg, 16)
      for (let i = rings.length - 1; i >= 0; i--) {
        const rg = rings[i]
        rg.r += rg.vel; rg.vel *= 0.985; rg.life -= 0.018
        if (rg.life <= 0) { rings.splice(i, 1); continue }
        kaleido(segN, () => {
          ctx.strokeStyle = `hsla(${rg.hue}, 100%, 62%, ${rg.life * 0.7})`
          ctx.lineWidth = 1 + rg.life * 4
          ctx.shadowBlur = 16 * rg.life; ctx.shadowColor = ctx.strokeStyle as string
          ctx.beginPath(); ctx.arc(rg.x, rg.y, rg.r, 0, Math.PI * 2); ctx.stroke()
        })
      }
      ctx.shadowBlur = 0
    }

    // ── MODE: Cristal Sacré — Delaunay of fingertips, filled translucent ────
    const renderSacred = (points: { x: number; y: number; hue: number }[], seg: number) => {
      if (points.length < 3) return
      const tris = delaunay(points)
      const segN = Math.min(seg, 16)
      kaleido(segN, () => {
        for (const [a, b, c] of tris) {
          const hue = (points[a].hue + points[b].hue + points[c].hue) / 3
          ctx.fillStyle = `hsla(${hue}, 90%, 55%, 0.18)`
          ctx.strokeStyle = `hsla(${hue}, 100%, 70%, 0.7)`
          ctx.lineWidth = 1.5; ctx.shadowBlur = 8; ctx.shadowColor = ctx.strokeStyle as string
          ctx.beginPath()
          ctx.moveTo(points[a].x, points[a].y); ctx.lineTo(points[b].x, points[b].y); ctx.lineTo(points[c].x, points[c].y); ctx.closePath()
          ctx.fill(); ctx.stroke()
        }
      })
      ctx.shadowBlur = 0
    }

    // ── MODE: Néon Cyberpunk — paths with RGB chromatic aberration + glow ───
    const renderNeon = (el: MandalaElement, segCount: number) => {
      const cx = canvas.width / 2, cy = canvas.height / 2
      const r1 = Math.hypot(el.x1 - cx, el.y1 - cy), a1 = Math.atan2(el.y1 - cy, el.x1 - cx)
      let r2 = 0, a2 = 0
      if (el.x2 != null) { r2 = Math.hypot(el.x2 - cx, el.y2! - cy); a2 = Math.atan2(el.y2! - cy, el.x2 - cx) }
      const channels: [string, number, number][] = [['rgba(255,40,90,', -3, 0], ['rgba(40,255,160,', 0, 0], ['rgba(60,120,255,', 3, 0]]
      ctx.save(); ctx.translate(cx, cy)
      for (let s = 0; s < segCount; s++) {
        const off = (s * Math.PI * 2) / segCount
        for (const [col, ox, oy] of channels) {
          ctx.strokeStyle = ctx.fillStyle = `${col}${el.alpha * 0.85})`
          ctx.shadowBlur = 18; ctx.shadowColor = `${col}1)`
          ctx.lineWidth = el.size; ctx.lineCap = 'round'
          const x1 = Math.cos(a1 + off) * r1 + ox, y1 = Math.sin(a1 + off) * r1 + oy
          if (el.x2 != null) {
            ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(Math.cos(a2 + off) * r2 + ox, Math.sin(a2 + off) * r2 + oy); ctx.stroke()
          } else { ctx.beginPath(); ctx.arc(x1, y1, el.size, 0, Math.PI * 2); ctx.fill() }
        }
      }
      ctx.restore(); ctx.shadowBlur = 0
    }

    type ScreenJob = { kind: 'skeleton'; lm: { x: number; y: number }[] } | { kind: 'link'; a: { x: number; y: number }; b: { x: number; y: number } }

    const loop = () => {
      if (!running) return
      const p = paramsRef.current
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      if (clearRef.current) { pathsRef.current = []; clearRef.current = false }

      // Fade out (persistence). 100 = infini, or the "permanent" toggle disables
      // fade entirely so the full drawing accumulates for a clean export.
      if (p.fade !== 100 && !p.permanent) {
        const dec = p.fade / 1000
        const next: MandalaElement[] = []
        for (const el of pathsRef.current) { el.alpha -= dec; if (el.alpha > 0) next.push(el) }
        pathsRef.current = next
      }

      // Audio-reactive: bass speeds the hue cycle + a global glow lift
      const bass = p.audioReact ? (senseBus.audio.bass ?? 0) : 0
      hueBase = (hueBase + 0.3 + bass * 2) % 360

      // ---- DETECTION (gather everything, defer the screen-space overlays) ----
      const crystalJobs: { pts: { x: number; y: number }[]; palm: { x: number; y: number }; hue: number; intensity: number }[] = []
      const screenJobs: ScreenJob[] = []
      const tips: { x: number; y: number }[] = []
      const attractors: { x: number; y: number; hue: number }[] = []   // all fingertips, for quantum + sacred modes

      if (video.readyState >= 2 && video.currentTime !== lastVideoTime && landmarker) {
        lastVideoTime = video.currentTime
        const res = landmarker.detectForVideo(video, performance.now())
        const hands = res.landmarks ?? []
        if (hands.length > 0) {
          hands.forEach((lm, handIdx) => {
            const toScreen = (i: number) => ({ x: (1 - lm[i].x) * canvas.width, y: lm[i].y * canvas.height })
            const idxTip = lm[TIP_INDEX]
            const thumbTip = lm[TIP_THUMB]
            const x = (1 - idxTip.x) * canvas.width
            const y = idxTip.y * canvas.height
            const hue = (hueBase + handIdx * 130) % 360
            tips.push({ x, y })
            // Collect all 5 fingertips as attractors (quantum) / nodes (sacred)
            for (const ti of [TIP_THUMB, TIP_INDEX, 12, 16, 20]) {
              const s = toScreen(ti); attractors.push({ x: s.x, y: s.y, hue: (hue + ti * 4) % 360 })
            }

            // ---- VOLUMETRIC z-depth : hand scale (palm size) → near/far ----
            // landmark 0 = wrist, 9 = middle-finger base. A bigger gap = hand
            // closer to the camera. The smoothed value drives a pseudo-3D pivot.
            const handScale = Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y)
            const depthNorm = Math.max(0, Math.min(1, (handScale - 0.08) / 0.22))
            const tiltRaw = ((1 - lm[9].x) - 0.5) * 2   // hand horizontal position → pivot
            if (handIdx === 0) {
              depthRef.current += (depthNorm - depthRef.current) * 0.12
              tiltRef.current += (tiltRaw - tiltRef.current) * 0.12
            }

            // ---- CRYSTAL : finger closeness (shadow-puppet) ----
            const fingerTips = [TIP_INDEX, 12, 16, 20].map(toScreen)
            const cxc = fingerTips.reduce((s, t) => s + t.x, 0) / fingerTips.length
            const cyc = fingerTips.reduce((s, t) => s + t.y, 0) / fingerTips.length
            const spreadPx = fingerTips.reduce((s, t) => s + Math.hypot(t.x - cxc, t.y - cyc), 0) / fingerTips.length
            const handScalePx = handScale * canvas.width
            const spreadNorm = handScalePx > 1 ? spreadPx / handScalePx : 1
            const closeness = Math.max(0, Math.min(1, (0.95 - spreadNorm) / 0.55))   // 0 = wide, 1 = fingers together
            if (p.crystal && closeness > 0.18) {
              const allTips = [TIP_THUMB, TIP_INDEX, 12, 16, 20].map(toScreen)
              crystalJobs.push({ pts: allTips, palm: toScreen(9), hue, intensity: closeness })
            }

            // ---- normal index stroke (thickness lifts with depth + bass) ----
            const pinchDist = Math.hypot(idxTip.x - thumbTip.x, idxTip.y - thumbTip.y)
            const isPinching = pinchDist < 0.06
            let strokeSize = p.size * (1 + bass * 1.5 + depthRef.current * 0.8)
            if (isPinching) strokeSize *= 2.5

            // ---- SONIC : fast index move OR pinch → spawn an expanding ring ----
            const vp = velPosRef.current[handIdx]
            const moveSpeed = vp ? Math.hypot(x - vp.x, y - vp.y) : 0
            velPosRef.current[handIdx] = { x, y }
            if (p.genMode === 'sonic' && (moveSpeed > 28 || isPinching) && ringsRef.current.length < 60) {
              ringsRef.current.push({ x, y, r: 4, vel: Math.max(7, moveSpeed * 0.35) + (isPinching ? 6 : 0), hue, life: 1 })
            }

            // Stroke accumulation only feeds the path-based modes (classic + cyberpunk).
            if (p.genMode === 'classic' || p.genMode === 'cyberpunk') {
              if (p.style === 'lines' && lastPosRef.current[handIdx]) {
                pathsRef.current.push({ type: 'lines', x1: lastPosRef.current[handIdx].x, y1: lastPosRef.current[handIdx].y, x2: x, y2: y, size: strokeSize, hue, alpha: 1, isPinching })
              } else {
                pathsRef.current.push({ type: p.style, x1: x, y1: y, size: strokeSize, hue, alpha: 1, isPinching })
              }
            }
            lastPosRef.current[handIdx] = { x, y }
            if (p.skeleton) screenJobs.push({ kind: 'skeleton', lm: lm.map((_, i) => toScreen(i)) })
          })
          if (p.interconnect && tips.length >= 2) screenJobs.push({ kind: 'link', a: tips[0], b: tips[1] })
        } else {
          lastPosRef.current = {}
          // Ease depth/tilt back to neutral when no hand is present.
          depthRef.current *= 0.95
          tiltRef.current *= 0.95
        }
      }

      // ---- RENDER mandala (paths + crystal) inside the pseudo-3D pivot ----
      const depth = p.volumetric ? depthRef.current : 0
      const tilt = p.volumetric ? tiltRef.current : 0
      ctx.save()
      if (p.volumetric && (depth !== 0 || tilt !== 0)) {
        const cx = canvas.width / 2, cy = canvas.height / 2
        ctx.translate(cx + tilt * depth * 70, cy)   // depth shifts the calc center
        ctx.rotate(tilt * 0.4)                        // hand L/R pivots the structure
        ctx.scale(0.85 + depth * 0.5, (0.85 + depth * 0.5) * (1 - 0.32 * Math.abs(tilt)))  // near = bigger; pivot foreshortens Y
        ctx.translate(-cx, -cy)
      }
      // Branch by generative mode (all rendered inside the pseudo-3D pivot).
      if (p.genMode === 'quantum') {
        renderQuantum(attractors, p.segments, bass)
      } else if (p.genMode === 'sonic') {
        renderSonic(p.segments)
      } else if (p.genMode === 'sacred') {
        renderSacred(attractors, p.segments)
      } else if (p.genMode === 'cyberpunk') {
        for (const el of pathsRef.current) renderNeon(el, p.segments)
      } else {
        // classic
        for (const el of pathsRef.current) renderElement(el, p.segments)
        for (const job of crystalJobs) renderCrystal(job.pts, job.palm, p.segments, job.hue, job.intensity)
      }
      ctx.restore()

      // ---- SCREEN-SPACE overlays on top (track the real hand, no 3D) ----
      for (const job of screenJobs) {
        if (job.kind === 'skeleton') {
          ctx.save(); ctx.strokeStyle = 'rgba(0,240,255,0.4)'; ctx.lineWidth = 2
          for (const chain of FINGER_CHAINS) {
            ctx.beginPath()
            chain.forEach((idx, i) => { const pt = job.lm[idx]; if (i === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y) })
            ctx.stroke()
          }
          ctx.restore()
        } else {
          ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1; ctx.setLineDash([5, 10])
          ctx.beginPath(); ctx.moveTo(job.a.x, job.a.y); ctx.lineTo(job.b.x, job.b.y); ctx.stroke(); ctx.restore()
        }
      }

      // Hard cap the path buffer so an "infini" session can't grow without bound.
      if (pathsRef.current.length > 6000) pathsRef.current.splice(0, pathsRef.current.length - 6000)
      rafId = requestAnimationFrame(loop)
    }

    const init = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false })
        video.srcObject = stream
        await new Promise<void>((res) => { video.onloadedmetadata = () => res() })
        await video.play()
        const files = await FilesetResolver.forVisionTasks(WASM_BASE)
        landmarker = await HandLandmarker.createFromOptions(files, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numHands: 2,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        })
        setStatus('Studio prêt — dessine avec ton index ✦')
        loop()
      } catch (e: any) {
        setError(`Caméra ou modèle indisponible : ${e?.message ?? e}`)
      }
    }
    init()

    return () => {
      running = false
      if (rafId) cancelAnimationFrame(rafId)
      window.removeEventListener('resize', resize)
      try { landmarker?.close() } catch { /* noop */ }
      if (stream) stream.getTracks().forEach((t) => t.stop())
      video.srcObject = null
    }
  }, [])

  const exportPng = () => {
    const c = canvasRef.current
    if (!c) return
    // Composite the chosen background behind the mandala geometry so the export
    // matches what's on screen (webcam frame / solid color / black) instead of a
    // bare transparent PNG.
    const out = document.createElement('canvas')
    out.width = c.width; out.height = c.height
    const octx = out.getContext('2d')!
    if (bgMode === 'webcam' && videoRef.current && videoRef.current.readyState >= 2) {
      octx.save(); octx.translate(out.width, 0); octx.scale(-1, 1)   // mirror to match display
      octx.drawImage(videoRef.current, 0, 0, out.width, out.height)
      octx.restore()
    } else if (bgMode === 'color') {
      octx.fillStyle = bgColor; octx.fillRect(0, 0, out.width, out.height)
    } else if (bgMode === 'black') {
      octx.fillStyle = '#000'; octx.fillRect(0, 0, out.width, out.height)
    }
    // (if 'webcam' but no video, leaves transparent — fine for overlay use)
    octx.drawImage(c, 0, 0)
    out.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = `mandala-${Date.now()}.png`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }, 'image/png')
  }

  const enableAudio = () => { startAudio().catch(() => {}) }

  // Container background : transparent lets the webcam show; otherwise a solid fill.
  const containerBg = bgMode === 'webcam' ? '#000' : bgMode === 'color' ? bgColor : '#000'

  return (
    <div style={{ position: 'fixed', inset: 0, background: containerBg, overflow: 'hidden', userSelect: 'none', fontFamily: 'var(--font, system-ui)' }}>
      {/* Keep the video element rendering even when hidden (opacity, not display:none)
          so MediaPipe keeps reading frames for hand tracking. */}
      <video ref={videoRef} autoPlay playsInline muted
        style={{ position: 'absolute', inset: 0, width: '100vw', height: '100vh', objectFit: 'cover', transform: 'scaleX(-1)', zIndex: 1, opacity: bgMode === 'webcam' ? 1 : 0 }} />
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100vw', height: '100vh', zIndex: 2 }} />

      {/* Collapsed: a single re-open button */}
      {!panelOpen && (
        <button onClick={() => setPanelOpen(true)} title="Ouvrir le panneau"
          style={{ position: 'absolute', top: 16, left: 16, zIndex: 11, width: 'auto', padding: '8px 12px', ...selStyle, fontSize: 16 }}>☰</button>
      )}

      {/* Control panel */}
      {panelOpen && (
      <div style={{
        position: 'absolute', top: 16, left: 16, zIndex: 10, width: 280,
        background: 'rgba(10,10,15,0.85)', padding: 18, borderRadius: 16,
        backdropFilter: 'blur(10px)', border: '1px solid rgba(255,255,255,0.15)',
        boxShadow: '0 10px 30px rgba(0,0,0,0.5)', maxHeight: 'calc(100vh - 32px)', overflowY: 'auto',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <strong style={{ color: '#00f0ff', textTransform: 'uppercase', letterSpacing: 1, fontSize: 14 }}>Mandala Studio</strong>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Link to="/" style={{ color: '#aaa', fontSize: 12, textDecoration: 'none' }}>← Studio</Link>
            <button onClick={() => setPanelOpen(false)} title="Réduire le panneau"
              style={{ background: 'transparent', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: 16, padding: 0, lineHeight: 1 }}>«</button>
          </div>
        </div>
        <div style={{ color: error ? '#ff6b6b' : '#7a7a85', fontSize: 11, marginBottom: 12, lineHeight: 1.3 }}>{error ?? status}</div>

        <Field label="✦ Mode de design génératif">
          <select value={genMode} onChange={(e) => setGenMode(e.target.value as GenMode)} style={selStyle}>
            <option value="classic">🎨 Classique (tracé + cristal)</option>
            <option value="quantum">🌌 Fluide Quantique (particules)</option>
            <option value="sonic">💥 Ondes de Choc (anneaux)</option>
            <option value="sacred">🔷 Cristal Sacré (Delaunay 3D)</option>
            <option value="cyberpunk">🌈 Néon Cyberpunk (aberration)</option>
          </select>
        </Field>
        <p style={{ fontSize: 10, color: '#7a7a85', margin: '-6px 0 10px', lineHeight: 1.35 }}>
          {genMode === 'quantum' && 'Tes doigts attirent des milliers de particules — bouge pour créer vortex & nébuleuses.'}
          {genMode === 'sonic' && 'Mouvement rapide ou pincement → ondes de choc circulaires qui sculptent le mandala.'}
          {genMode === 'sacred' && 'Structure low-poly translucide reliant tes doigts (triangulation de Delaunay).'}
          {genMode === 'cyberpunk' && 'Traînées néon à fort glow + aberration chromatique RVB — esthétique sci-fi.'}
          {genMode === 'classic' && 'Tracé kaléidoscopique + armature cristalline (doigts serrés).'}
        </p>

        {(genMode === 'classic' || genMode === 'cyberpunk') && (
          <Field label="Style de tracé">
            <select value={style} onChange={(e) => setStyle(e.target.value as DrawStyle)} style={selStyle}>
              <option value="lines">Lignes continues</option>
              <option value="points">Points lumineux</option>
              <option value="stars">Étoiles géométriques</option>
            </select>
          </Field>
        )}

        <Field label={`Symétries (branches) — ${segments}`}>
          <input type="range" min={2} max={64} step={1} value={segments} onChange={(e) => setSegments(+e.target.value)} style={rngStyle} />
        </Field>

        <Field label={`Épaisseur — ${size}`}>
          <input type="range" min={1} max={25} value={size} onChange={(e) => setSize(+e.target.value)} style={rngStyle} />
        </Field>

        <Field label={`Persistance — ${permanent ? 'Permanent' : fade === 100 ? 'Infini' : 'Éphémère'}`}>
          <input type="range" min={1} max={100} value={fade} disabled={permanent} onChange={(e) => setFade(+e.target.value)} style={{ ...rngStyle, opacity: permanent ? 0.4 : 1 }} />
        </Field>
        <label style={chkRow} title="Le tracé ne s'efface jamais — idéal pour composer puis exporter une œuvre complète">
          <input type="checkbox" checked={permanent} onChange={(e) => setPermanent(e.target.checked)} style={{ accentColor: '#00f0ff' }} />
          🔒 Tracé permanent (non-éphémère)
        </label>

        <Field label="Fond (arrière-plan)">
          <select value={bgMode} onChange={(e) => setBgMode(e.target.value as any)} style={selStyle}>
            <option value="webcam">📷 Webcam (AR)</option>
            <option value="black">⬛ Noir (épuré)</option>
            <option value="color">🎨 Couleur personnalisée</option>
          </select>
        </Field>
        {bgMode === 'color' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <span style={{ fontSize: 11, color: '#aaa' }}>Couleur du fond</span>
            <input type="color" value={bgColor} onChange={(e) => setBgColor(e.target.value)} style={{ marginLeft: 'auto', width: 44, height: 28, border: 'none', background: 'none', cursor: 'pointer' }} />
          </div>
        )}

        <Field label="Squelette des mains">
          <select value={skeleton ? 'visible' : 'hidden'} onChange={(e) => setSkeleton(e.target.value === 'visible')} style={selStyle}>
            <option value="visible">Visible (cyan AR)</option>
            <option value="hidden">Masqué (art épuré)</option>
          </select>
        </Field>

        <label style={chkRow}>
          <input type="checkbox" checked={interconnect} onChange={(e) => setInterconnect(e.target.checked)} style={{ accentColor: '#00f0ff' }} />
          Lien d'énergie inter-mains
        </label>
        <label style={chkRow} title="Rapproche tes doigts (ombre chinoise) → armature cristalline mirroir">
          <input type="checkbox" checked={crystal} onChange={(e) => setCrystal(e.target.checked)} style={{ accentColor: '#00f0ff' }} />
          ✦ Armature cristalline (doigts serrés)
        </label>
        <label style={chkRow} title="Avance/recule la main près de la caméra → la profondeur z fait pivoter le mandala en 3D">
          <input type="checkbox" checked={volumetric} onChange={(e) => setVolumetric(e.target.checked)} style={{ accentColor: '#00f0ff' }} />
          ◈ Volumétrique 3D (profondeur z)
        </label>
        <label style={chkRow}>
          <input type="checkbox" checked={audioReact} onChange={(e) => setAudioReact(e.target.checked)} style={{ accentColor: '#00f0ff' }} />
          Réactif au son (micro) <button onClick={enableAudio} style={miniBtn} title="Activer le micro">🎤</button>
        </label>

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button onClick={() => { clearRef.current = true }} style={{ ...selStyle, flex: 1, background: 'rgba(255,40,100,0.2)', borderColor: 'rgba(255,40,100,0.4)' }}>Réinitialiser</button>
          <button onClick={exportPng} style={{ ...selStyle, flex: 1 }}>📸 Exporter</button>
        </div>
        <p style={{ color: '#777', fontSize: 10, marginTop: 10, marginBottom: 0, lineHeight: 1.4 }}>
          Pince pour intensifier · serre les doigts pour le cristal ✦ · avance/recule la main pour la 3D ◈
        </p>
      </div>
      )}
    </div>
  )
}

const selStyle: React.CSSProperties = {
  width: '100%', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)',
  color: 'white', padding: 8, borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: 13,
}
const rngStyle: React.CSSProperties = { width: '100%', accentColor: '#00f0ff' }
const chkRow: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: '#ccc', marginTop: 8, cursor: 'pointer' }
const miniBtn: React.CSSProperties = { background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 13, padding: 0, marginLeft: 'auto' }

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, color: '#00f0ff', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5 }}>{label}</div>
      {children}
    </div>
  )
}
