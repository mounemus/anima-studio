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

  const [style, setStyle] = useState<DrawStyle>('lines')
  const [segments, setSegments] = useState(12)
  const [size, setSize] = useState(6)
  const [fade, setFade] = useState(15)        // 100 = persistant (infini)
  const [skeleton, setSkeleton] = useState(true)
  const [interconnect, setInterconnect] = useState(true)
  const [audioReact, setAudioReact] = useState(true)
  const [crystal, setCrystal] = useState(true)
  const [volumetric, setVolumetric] = useState(true)
  const [status, setStatus] = useState('Initialisation de la caméra et du modèle…')
  const [error, setError] = useState<string | null>(null)

  // The render loop reads parameters through a ref so slider changes apply live
  // without re-subscribing the rAF closure.
  const paramsRef = useRef({ style, segments, size, fade, skeleton, interconnect, audioReact, crystal, volumetric })
  paramsRef.current = { style, segments, size, fade, skeleton, interconnect, audioReact, crystal, volumetric }

  const pathsRef = useRef<MandalaElement[]>([])
  const lastPosRef = useRef<Record<number, { x: number; y: number }>>({})
  const clearRef = useRef(false)
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

    type ScreenJob = { kind: 'skeleton'; lm: { x: number; y: number }[] } | { kind: 'link'; a: { x: number; y: number }; b: { x: number; y: number } }

    const loop = () => {
      if (!running) return
      const p = paramsRef.current
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      if (clearRef.current) { pathsRef.current = []; clearRef.current = false }

      // Fade out (persistence). 100 = infini (no fade).
      if (p.fade !== 100) {
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

            if (p.style === 'lines' && lastPosRef.current[handIdx]) {
              pathsRef.current.push({ type: 'lines', x1: lastPosRef.current[handIdx].x, y1: lastPosRef.current[handIdx].y, x2: x, y2: y, size: strokeSize, hue, alpha: 1, isPinching })
            } else {
              pathsRef.current.push({ type: p.style, x1: x, y1: y, size: strokeSize, hue, alpha: 1, isPinching })
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
      for (const el of pathsRef.current) renderElement(el, p.segments)
      for (const job of crystalJobs) renderCrystal(job.pts, job.palm, p.segments, job.hue, job.intensity)
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
    c.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = `mandala-${Date.now()}.png`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }, 'image/png')
  }

  const enableAudio = () => { startAudio().catch(() => {}) }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000', overflow: 'hidden', userSelect: 'none', fontFamily: 'var(--font, system-ui)' }}>
      <video ref={videoRef} autoPlay playsInline muted
        style={{ position: 'absolute', inset: 0, width: '100vw', height: '100vh', objectFit: 'cover', transform: 'scaleX(-1)', zIndex: 1 }} />
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100vw', height: '100vh', zIndex: 2 }} />

      {/* Control panel */}
      <div style={{
        position: 'absolute', top: 16, left: 16, zIndex: 10, width: 280,
        background: 'rgba(10,10,15,0.85)', padding: 18, borderRadius: 16,
        backdropFilter: 'blur(10px)', border: '1px solid rgba(255,255,255,0.15)',
        boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <strong style={{ color: '#00f0ff', textTransform: 'uppercase', letterSpacing: 1, fontSize: 14 }}>Mandala Studio</strong>
          <Link to="/" style={{ color: '#aaa', fontSize: 12, textDecoration: 'none' }}>← Studio</Link>
        </div>

        <Field label="Style de tracé">
          <select value={style} onChange={(e) => setStyle(e.target.value as DrawStyle)} style={selStyle}>
            <option value="lines">Lignes continues</option>
            <option value="points">Points lumineux</option>
            <option value="stars">Étoiles géométriques</option>
          </select>
        </Field>

        <Field label={`Symétries (branches) — ${segments}`}>
          <input type="range" min={2} max={64} step={1} value={segments} onChange={(e) => setSegments(+e.target.value)} style={rngStyle} />
        </Field>

        <Field label={`Épaisseur — ${size}`}>
          <input type="range" min={1} max={25} value={size} onChange={(e) => setSize(+e.target.value)} style={rngStyle} />
        </Field>

        <Field label={`Persistance — ${fade === 100 ? 'Infini' : 'Éphémère'}`}>
          <input type="range" min={1} max={100} value={fade} onChange={(e) => setFade(+e.target.value)} style={rngStyle} />
        </Field>

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
      </div>

      {/* Status / instructions */}
      <div style={{
        position: 'absolute', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 10,
        textAlign: 'center', pointerEvents: 'none', background: 'rgba(0,0,0,0.7)',
        padding: '8px 28px', borderRadius: 28, backdropFilter: 'blur(5px)', border: '1px solid rgba(255,255,255,0.1)',
      }}>
        <div style={{ color: '#00f0ff', fontSize: 16, textTransform: 'uppercase', letterSpacing: 1 }}>Mandala Studio AR</div>
        <div style={{ color: error ? '#ff6b6b' : '#aaa', fontSize: 12 }}>{error ?? status}</div>
        {!error && <div style={{ color: '#888', fontSize: 11 }}>Pince pour intensifier · serre les doigts pour le cristal ✦ · avance/recule la main pour la 3D ◈</div>}
      </div>
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
