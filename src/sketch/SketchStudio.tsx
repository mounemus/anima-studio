/**
 * Sketch AR Studio — dessin 3D dans l'espace avec les doigts (webcam + MediaPipe).
 *
 * Inspiré de Gravity Sketch (tracé 3D immersif) et de Sketchar mural projector
 * (projection d'une image de référence à décalquer). L'utilisateur PINCE
 * (pouce+index) pour tracer des tubes lumineux 3D qui suivent le bout de l'index ;
 * la profondeur z vient de la distance main↔caméra. On peut faire TOURNER le
 * croquis en 3D (glisser à la souris) pour le voir sous tous les angles, importer
 * une image de référence semi-transparente à décalquer, activer une grille de
 * repère et la symétrie miroir (fresques). Export PNG.
 *
 * Studio autonome (comme MandalaStudio) : caméra + HandLandmarker + rAF + scène
 * Three.js montés/démontés proprement. Route /sketch, protégée par FrontGate.
 */
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import * as THREE from 'three'
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision'

const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

const TIP_THUMB = 4
const TIP_INDEX = 8
const TIP_MIDDLE = 12
const PIP_INDEX = 6      // index proximal joint (for "index levé" detection)
const FINGER_CHAINS = [
  [0, 1, 2, 3, 4], [0, 5, 6, 7, 8], [0, 9, 10, 11, 12], [0, 13, 14, 15, 16], [0, 17, 18, 19, 20],
]

type DrawMode = 'pinch' | 'index'
type BgMode = 'webcam' | 'black'

interface Stroke { mesh: THREE.Mesh; mirror?: THREE.Mesh }

export function SketchStudio() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const mountRef = useRef<HTMLDivElement>(null)   // hosts the THREE canvas
  const overlayRef = useRef<HTMLCanvasElement>(null)  // 2D skeleton / cursor
  const fileRef = useRef<HTMLInputElement>(null)

  const [color, setColor] = useState('#00f0ff')
  const [brush, setBrush] = useState(6)
  const [drawMode, setDrawMode] = useState<DrawMode>('pinch')
  const [symmetry, setSymmetry] = useState(false)
  const [autoRotate, setAutoRotate] = useState(false)
  const [showGrid, setShowGrid] = useState(true)
  const [showSkeleton, setShowSkeleton] = useState(true)
  const [bgMode, setBgMode] = useState<BgMode>('webcam')
  const [refUrl, setRefUrl] = useState<string | null>(null)
  const [refOpacity, setRefOpacity] = useState(0.5)
  const [panelOpen, setPanelOpen] = useState(true)
  const [status, setStatus] = useState('Initialisation de la caméra et du modèle…')
  const [error, setError] = useState<string | null>(null)

  const paramsRef = useRef({ color, brush, drawMode, symmetry, autoRotate, showGrid, showSkeleton })
  paramsRef.current = { color, brush, drawMode, symmetry, autoRotate, showGrid, showSkeleton }

  // Imperative handles the render loop reaches through refs.
  const clearRef = useRef(false)
  const undoRef = useRef(false)
  const recenterRef = useRef(false)
  const strokesRef = useRef<Stroke[]>([])
  const sceneRef = useRef<THREE.Scene | null>(null)
  const gridRef = useRef<THREE.GridHelper | null>(null)

  useEffect(() => {
    const video = videoRef.current!
    const mount = mountRef.current!
    const overlay = overlayRef.current!
    const octx = overlay.getContext('2d')!
    let landmarker: HandLandmarker | null = null
    let stream: MediaStream | null = null
    let rafId = 0
    let running = true
    let lastVideoTime = -1

    // ── THREE setup ────────────────────────────────────────────────────────
    const scene = new THREE.Scene()
    sceneRef.current = scene
    const camera = new THREE.PerspectiveCamera(55, 1, 0.01, 100)
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
    renderer.setClearColor(0x000000, 0)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    mount.appendChild(renderer.domElement)
    renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100vw;height:100vh;'

    const grid = new THREE.GridHelper(4, 16, 0x2a6f7a, 0x14343a)
    ;(grid.material as THREE.Material).transparent = true
    ;(grid.material as THREE.Material).opacity = 0.35
    grid.position.y = -1.4
    scene.add(grid)
    gridRef.current = grid

    // Spherical camera (manual orbit). Front view = az 0, polar PI/2.
    const cam = { radius: 3.2, az: 0, polar: Math.PI / 2, targetAz: 0, targetPolar: Math.PI / 2 }
    const applyCam = () => {
      const sp = Math.sin(cam.polar), cp = Math.cos(cam.polar)
      camera.position.set(cam.radius * sp * Math.sin(cam.az), cam.radius * cp, cam.radius * sp * Math.cos(cam.az))
      camera.lookAt(0, 0, 0)
    }
    const resize = () => {
      const w = window.innerWidth, h = window.innerHeight
      renderer.setSize(w, h, false)
      camera.aspect = w / h; camera.updateProjectionMatrix()
      overlay.width = w; overlay.height = h
    }
    resize()
    window.addEventListener('resize', resize)

    // Mouse orbit (only when not actively drawing).
    let dragging = false, lastX = 0, lastY = 0
    const onDown = (e: PointerEvent) => { dragging = true; lastX = e.clientX; lastY = e.clientY }
    const onMove = (e: PointerEvent) => {
      if (!dragging) return
      cam.targetAz -= (e.clientX - lastX) * 0.008
      cam.targetPolar = Math.max(0.2, Math.min(Math.PI - 0.2, cam.targetPolar - (e.clientY - lastY) * 0.008))
      lastX = e.clientX; lastY = e.clientY
    }
    const onUp = () => { dragging = false }
    const onWheel = (e: WheelEvent) => { cam.radius = Math.max(1.2, Math.min(8, cam.radius + e.deltaY * 0.002)) }
    renderer.domElement.addEventListener('pointerdown', onDown)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    renderer.domElement.addEventListener('wheel', onWheel, { passive: true })

    // ── stroke building ──────────────────────────────────────────────────
    const mkMat = (hex: string) => new THREE.MeshBasicMaterial({
      color: new THREE.Color(hex), transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false,
    })
    const buildTube = (pts: THREE.Vector3[], radius: number): THREE.BufferGeometry | null => {
      if (pts.length < 2) return null
      const curve = new THREE.CatmullRomCurve3(pts)
      const seg = Math.max(4, Math.min(600, pts.length * 4))
      return new THREE.TubeGeometry(curve, seg, radius, 7, false)
    }

    // Active stroke state
    let activePts: THREE.Vector3[] = []
    let activeMirrorPts: THREE.Vector3[] = []
    let activeMesh: THREE.Mesh | null = null
    let activeMirror: THREE.Mesh | null = null
    let activeMat: THREE.MeshBasicMaterial | null = null
    let wasDrawing = false

    const disposeMesh = (m: THREE.Mesh | null) => {
      if (!m) return
      scene.remove(m); m.geometry.dispose()
    }
    const finalizeActive = () => {
      if (activeMesh && activePts.length >= 2) {
        strokesRef.current.push({ mesh: activeMesh, mirror: activeMirror ?? undefined })
      } else {
        disposeMesh(activeMesh); disposeMesh(activeMirror)
      }
      activeMesh = null; activeMirror = null; activeMat = null
      activePts = []; activeMirrorPts = []
    }

    // world mapping (front-facing frame). ndc in [-1,1], depthNorm 0..1
    const ndcToWorld = (ndcX: number, ndcY: number, depthNorm: number) => {
      const halfH = Math.tan((55 * Math.PI / 180) / 2) * cam.radius
      const halfW = halfH * camera.aspect
      const z = (depthNorm - 0.5) * 1.6
      return new THREE.Vector3(ndcX * halfW * 0.92, ndcY * halfH * 0.92, z)
    }

    const loop = () => {
      if (!running) return
      const p = paramsRef.current

      if (clearRef.current) {
        for (const s of strokesRef.current) { disposeMesh(s.mesh); disposeMesh(s.mirror ?? null) }
        strokesRef.current = []
        disposeMesh(activeMesh); disposeMesh(activeMirror)
        activeMesh = activeMirror = null; activePts = []; activeMirrorPts = []
        clearRef.current = false
      }
      if (undoRef.current) {
        const s = strokesRef.current.pop()
        if (s) { disposeMesh(s.mesh); disposeMesh(s.mirror ?? null) }
        undoRef.current = false
      }
      if (recenterRef.current) { cam.targetAz = 0; cam.targetPolar = Math.PI / 2; recenterRef.current = false }

      grid.visible = p.showGrid

      octx.clearRect(0, 0, overlay.width, overlay.height)
      let cursor: { x: number; y: number; drawing: boolean } | null = null

      if (video.readyState >= 2 && video.currentTime !== lastVideoTime && landmarker) {
        lastVideoTime = video.currentTime
        const res = landmarker.detectForVideo(video, performance.now())
        const hands = res.landmarks ?? []
        if (hands.length > 0) {
          const lm = hands[0]
          const idx = lm[TIP_INDEX], thumb = lm[TIP_THUMB]
          const ndcX = (1 - idx.x) * 2 - 1   // mirror X to match the flipped display, → [-1,1]
          const ndcY = -(idx.y * 2 - 1)
          const handScale = Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y)
          const depthNorm = Math.max(0, Math.min(1, (handScale - 0.08) / 0.22))

          const pinch = Math.hypot(idx.x - thumb.x, idx.y - thumb.y)
          const indexUp = lm[TIP_INDEX].y < lm[PIP_INDEX].y && lm[TIP_MIDDLE].y > lm[PIP_INDEX].y
          const isDrawing = p.drawMode === 'pinch' ? pinch < 0.055 : indexUp

          const sx = (1 - idx.x) * overlay.width, sy = idx.y * overlay.height
          cursor = { x: sx, y: sy, drawing: isDrawing }

          if (isDrawing) {
            // While drawing, ease the camera back to front so points land where the hand is.
            cam.targetAz += (0 - cam.targetAz) * 0.15
            cam.targetPolar += (Math.PI / 2 - cam.targetPolar) * 0.15
            const wp = ndcToWorld(ndcX, ndcY, depthNorm)
            if (!wasDrawing) {
              activeMat = mkMat(p.color)
              activePts = [wp]
              activeMesh = new THREE.Mesh(new THREE.BufferGeometry(), activeMat)
              activeMesh.frustumCulled = false
              scene.add(activeMesh)
              if (p.symmetry) {
                activeMirrorPts = [new THREE.Vector3(-wp.x, wp.y, wp.z)]
                activeMirror = new THREE.Mesh(new THREE.BufferGeometry(), activeMat)
                activeMirror.frustumCulled = false
                scene.add(activeMirror)
              }
            } else {
              const last = activePts[activePts.length - 1]
              const rWorld = p.brush * 0.0016 * cam.radius
              if (wp.distanceTo(last) > Math.max(0.006, rWorld * 0.6)) {
                activePts.push(wp)
                if (activePts.length > 400) activePts.shift()
                if (p.symmetry) activeMirrorPts.push(new THREE.Vector3(-wp.x, wp.y, wp.z))
              }
            }
            // Rebuild active tube geometry
            const radius = Math.max(0.004, p.brush * 0.0016 * cam.radius)
            const g = buildTube(activePts, radius)
            if (g && activeMesh) { activeMesh.geometry.dispose(); activeMesh.geometry = g }
            if (p.symmetry && activeMirror) {
              const gm = buildTube(activeMirrorPts, radius)
              if (gm) { activeMirror.geometry.dispose(); activeMirror.geometry = gm }
            }
          } else if (wasDrawing) {
            finalizeActive()
          }
          wasDrawing = isDrawing

          // skeleton overlay
          if (p.showSkeleton) {
            octx.strokeStyle = 'rgba(0,240,255,0.35)'; octx.lineWidth = 2
            for (const chain of FINGER_CHAINS) {
              octx.beginPath()
              chain.forEach((i, k) => {
                const px = (1 - lm[i].x) * overlay.width, py = lm[i].y * overlay.height
                if (k === 0) octx.moveTo(px, py); else octx.lineTo(px, py)
              })
              octx.stroke()
            }
          }
        } else if (wasDrawing) {
          finalizeActive(); wasDrawing = false
        }
      }

      // cursor dot
      if (cursor) {
        octx.beginPath()
        octx.arc(cursor.x, cursor.y, cursor.drawing ? 14 : 8, 0, Math.PI * 2)
        octx.fillStyle = cursor.drawing ? p.color : 'rgba(255,255,255,0.6)'
        octx.globalAlpha = cursor.drawing ? 0.85 : 0.5
        octx.fill(); octx.globalAlpha = 1
        octx.lineWidth = 2; octx.strokeStyle = p.color; octx.stroke()
      }

      // camera update (auto-rotate when not drawing)
      if (p.autoRotate && !wasDrawing) cam.targetAz += 0.004
      cam.az += (cam.targetAz - cam.az) * 0.15
      cam.polar += (cam.targetPolar - cam.polar) * 0.15
      applyCam()
      renderer.render(scene, camera)
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
          runningMode: 'VIDEO', numHands: 1,
          minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
        })
        setStatus('Prêt — pince (pouce+index) et trace dans l\'espace ✦')
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
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('wheel', onWheel)
      try { landmarker?.close() } catch { /* noop */ }
      if (stream) stream.getTracks().forEach((t) => t.stop())
      video.srcObject = null
      for (const s of strokesRef.current) { s.mesh.geometry.dispose(); s.mirror?.geometry.dispose() }
      strokesRef.current = []
      renderer.dispose()
      if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement)
    }
  }, [])

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    if (refUrl) URL.revokeObjectURL(refUrl)
    setRefUrl(URL.createObjectURL(f))
    e.target.value = ''
  }

  const exportPng = () => {
    const three = mountRef.current?.querySelector('canvas') as HTMLCanvasElement | null
    if (!three) return
    const out = document.createElement('canvas')
    out.width = three.width; out.height = three.height
    const c = out.getContext('2d')!
    if (bgMode === 'webcam' && videoRef.current && videoRef.current.readyState >= 2) {
      c.save(); c.translate(out.width, 0); c.scale(-1, 1)
      c.drawImage(videoRef.current, 0, 0, out.width, out.height); c.restore()
    } else { c.fillStyle = '#05060f'; c.fillRect(0, 0, out.width, out.height) }
    c.drawImage(three, 0, 0, out.width, out.height)
    out.toBlob((b) => {
      if (!b) return
      const url = URL.createObjectURL(b)
      const a = document.createElement('a'); a.href = url; a.download = `sketch-ar-${Date.now()}.png`; a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }, 'image/png')
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000', overflow: 'hidden', userSelect: 'none', fontFamily: 'system-ui' }}>
      <video ref={videoRef} autoPlay playsInline muted
        style={{ position: 'absolute', inset: 0, width: '100vw', height: '100vh', objectFit: 'cover', transform: 'scaleX(-1)', zIndex: 1, opacity: bgMode === 'webcam' ? 1 : 0 }} />
      {refUrl && (
        <img src={refUrl} alt="" style={{ position: 'absolute', inset: 0, width: '100vw', height: '100vh', objectFit: 'contain', zIndex: 2, opacity: refOpacity, pointerEvents: 'none' }} />
      )}
      <div ref={mountRef} style={{ position: 'absolute', inset: 0, zIndex: 3 }} />
      <canvas ref={overlayRef} style={{ position: 'absolute', inset: 0, width: '100vw', height: '100vh', zIndex: 4, pointerEvents: 'none' }} />

      {!panelOpen && (
        <button onClick={() => setPanelOpen(true)} title="Ouvrir le panneau"
          style={{ position: 'absolute', top: 16, left: 16, zIndex: 11, ...selStyle, width: 'auto', padding: '8px 12px' }}>☰</button>
      )}

      {panelOpen && (
        <div style={{
          position: 'absolute', top: 16, left: 16, zIndex: 10, width: 288,
          background: 'rgba(10,10,15,0.85)', padding: 18, borderRadius: 16, backdropFilter: 'blur(10px)',
          border: '1px solid rgba(255,255,255,0.15)', boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
          maxHeight: 'calc(100vh - 32px)', overflowY: 'auto', color: '#ccc',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <strong style={{ color: '#00f0ff', textTransform: 'uppercase', letterSpacing: 1, fontSize: 14 }}>Sketch AR 3D</strong>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Link to="/" style={{ color: '#aaa', fontSize: 12, textDecoration: 'none' }}>← Studio</Link>
              <button onClick={() => setPanelOpen(false)} style={{ background: 'transparent', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: 16 }}>«</button>
            </div>
          </div>
          <div style={{ color: error ? '#ff6b6b' : '#7a7a85', fontSize: 11, marginBottom: 12, lineHeight: 1.3 }}>{error ?? status}</div>

          <Field label="Couleur & épaisseur">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ width: 40, height: 30, border: 'none', background: 'none', cursor: 'pointer' }} />
              <input type="range" min={2} max={22} value={brush} onChange={(e) => setBrush(+e.target.value)} style={{ ...rngStyle, flex: 1 }} />
              <span style={{ fontSize: 12, width: 20, textAlign: 'right' }}>{brush}</span>
            </div>
          </Field>

          <Field label="Geste de tracé">
            <select value={drawMode} onChange={(e) => setDrawMode(e.target.value as DrawMode)} style={selStyle}>
              <option value="pinch">✌️ Pince (pouce + index)</option>
              <option value="index">☝️ Index levé (autres pliés)</option>
            </select>
          </Field>

          <label style={chkRow} title="Trace symétriquement à gauche/droite — idéal fresques">
            <input type="checkbox" checked={symmetry} onChange={(e) => setSymmetry(e.target.checked)} style={{ accentColor: '#00f0ff' }} /> ⇋ Symétrie miroir
          </label>
          <label style={chkRow} title="Grille de repère au sol (pivote avec la vue)">
            <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} style={{ accentColor: '#00f0ff' }} /> ▦ Grille de repère
          </label>
          <label style={chkRow}>
            <input type="checkbox" checked={autoRotate} onChange={(e) => setAutoRotate(e.target.checked)} style={{ accentColor: '#00f0ff' }} /> ↻ Rotation auto (présentation)
          </label>
          <label style={chkRow}>
            <input type="checkbox" checked={showSkeleton} onChange={(e) => setShowSkeleton(e.target.checked)} style={{ accentColor: '#00f0ff' }} /> ✋ Squelette de la main
          </label>

          <Field label="Image de référence (à décalquer)">
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => fileRef.current?.click()} style={{ ...selStyle, flex: 1 }}>📥 Importer</button>
              {refUrl && <button onClick={() => { URL.revokeObjectURL(refUrl); setRefUrl(null) }} style={{ ...selStyle, flex: 1, background: 'rgba(255,40,100,0.2)', borderColor: 'rgba(255,40,100,0.4)' }}>Retirer</button>}
            </div>
            <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onFile} />
            {refUrl && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                <span style={{ fontSize: 11, color: '#aaa' }}>Opacité</span>
                <input type="range" min={0.05} max={1} step={0.05} value={refOpacity} onChange={(e) => setRefOpacity(+e.target.value)} style={{ ...rngStyle, flex: 1 }} />
              </div>
            )}
          </Field>

          <Field label="Fond">
            <select value={bgMode} onChange={(e) => setBgMode(e.target.value as BgMode)} style={selStyle}>
              <option value="webcam">📷 Webcam (AR)</option>
              <option value="black">⬛ Noir (épuré)</option>
            </select>
          </Field>

          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <button onClick={() => { undoRef.current = true }} style={{ ...selStyle, flex: 1 }}>↶ Annuler</button>
            <button onClick={() => { recenterRef.current = true }} style={{ ...selStyle, flex: 1 }}>⊙ Vue</button>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button onClick={() => { clearRef.current = true }} style={{ ...selStyle, flex: 1, background: 'rgba(255,40,100,0.2)', borderColor: 'rgba(255,40,100,0.4)' }}>Effacer tout</button>
            <button onClick={exportPng} style={{ ...selStyle, flex: 1 }}>📸 Export</button>
          </div>
          <p style={{ color: '#777', fontSize: 10, marginTop: 10, marginBottom: 0, lineHeight: 1.4 }}>
            Pince pour tracer · avance/recule la main = profondeur z · glisse à la souris pour tourner le croquis en 3D · molette = zoom
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, color: '#00f0ff', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5 }}>{label}</div>
      {children}
    </div>
  )
}
