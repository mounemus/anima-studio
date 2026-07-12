/**
 * Sketch AR Studio PRO — dessin 3D dans l'espace avec les doigts (webcam + MediaPipe).
 *
 * Inspiré de Gravity Sketch (tracé 3D immersif) et de Sketchar mural projector
 * (image de référence à décalquer). L'utilisateur trace des tubes 3D lumineux qui
 * suivent le bout de l'index ; la PROFONDEUR z vient de la distance main↔caméra
 * (approche/éloigne la main). On tourne le croquis en 3D à la souris.
 *
 * PRO : 5 pinceaux (tube mat, néon, marqueur, métal, fil lumineux), gomme 3D,
 * jauge de profondeur, symétrie miroir, grille, référence, et EXPORT 3D étanche
 * (.glb pour les apps 3D, .stl pour l'impression) — chaque trait est un tube
 * fermé par des calottes sphériques → maillage solide imprimable.
 *
 * Studio autonome (comme MandalaStudio). Route /sketch, protégée par FrontGate.
 */
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import * as THREE from 'three'
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'

const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

const TIP_THUMB = 4, TIP_INDEX = 8, TIP_MIDDLE = 12, PIP_INDEX = 6
const FINGER_CHAINS = [
  [0, 1, 2, 3, 4], [0, 5, 6, 7, 8], [0, 9, 10, 11, 12], [0, 13, 14, 15, 16], [0, 17, 18, 19, 20],
]

type BrushKind = 'tube' | 'neon' | 'marker' | 'metal' | 'wire'
type DrawMode = 'pinch' | 'index'
type BgMode = 'webcam' | 'black'

const BRUSHES: { kind: BrushKind; label: string; rMul: number }[] = [
  { kind: 'tube', label: '🩵 Tube mat', rMul: 1 },
  { kind: 'neon', label: '💡 Néon lumineux', rMul: 0.9 },
  { kind: 'marker', label: '🖊️ Marqueur plat', rMul: 1.1 },
  { kind: 'metal', label: '⚙️ Métal chromé', rMul: 1 },
  { kind: 'wire', label: '✨ Fil fin', rMul: 0.45 },
]

function makeBrushMaterial(kind: BrushKind, hex: string): THREE.Material {
  const color = new THREE.Color(hex)
  switch (kind) {
    case 'neon': return new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })
    case 'marker': return new THREE.MeshBasicMaterial({ color })
    case 'metal': return new THREE.MeshStandardMaterial({ color, metalness: 0.95, roughness: 0.22 })
    case 'wire': return new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false })
    case 'tube': default: return new THREE.MeshStandardMaterial({ color, metalness: 0.1, roughness: 0.55 })
  }
}

/** Tube along `pts`, optionally closed by end-cap spheres → a watertight solid. */
function buildStrokeGeometry(pts: THREE.Vector3[], radius: number, capped: boolean): THREE.BufferGeometry | null {
  const geoms: THREE.BufferGeometry[] = []
  if (pts.length >= 2) {
    const curve = new THREE.CatmullRomCurve3(pts)
    const seg = Math.max(4, Math.min(700, pts.length * 4))
    geoms.push(new THREE.TubeGeometry(curve, seg, radius, 8, false))
    if (capped) {
      for (const e of [pts[0], pts[pts.length - 1]]) {
        const s = new THREE.SphereGeometry(radius, 10, 8); s.translate(e.x, e.y, e.z); geoms.push(s)
      }
    }
  } else if (pts.length === 1) {
    const s = new THREE.SphereGeometry(radius, 10, 8); s.translate(pts[0].x, pts[0].y, pts[0].z); geoms.push(s)
  }
  if (!geoms.length) return null
  return geoms.length === 1 ? geoms[0] : mergeGeometries(geoms, false)
}

interface StrokeRec {
  pts: THREE.Vector3[]; mirrorPts: THREE.Vector3[] | null
  radius: number; hex: string; brush: BrushKind; group: THREE.Group
}

export function SketchStudio() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const mountRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const [color, setColor] = useState('#00f0ff')
  const [brush, setBrush] = useState<BrushKind>('tube')
  const [eraser, setEraser] = useState(false)
  const [size, setSize] = useState(6)
  const [drawMode, setDrawMode] = useState<DrawMode>('pinch')
  const [symmetry, setSymmetry] = useState(false)
  const [depthScale, setDepthScale] = useState(1)
  const [autoRotate, setAutoRotate] = useState(false)
  const [showGrid, setShowGrid] = useState(true)
  const [showSkeleton, setShowSkeleton] = useState(true)
  const [bgMode, setBgMode] = useState<BgMode>('webcam')
  const [refUrl, setRefUrl] = useState<string | null>(null)
  const [refOpacity, setRefOpacity] = useState(0.5)
  const [panelOpen, setPanelOpen] = useState(true)
  const [count, setCount] = useState(0)
  const [status, setStatus] = useState('Initialisation de la caméra et du modèle…')
  const [error, setError] = useState<string | null>(null)

  const paramsRef = useRef({ color, brush, eraser, size, drawMode, symmetry, depthScale, autoRotate, showGrid, showSkeleton })
  paramsRef.current = { color, brush, eraser, size, drawMode, symmetry, depthScale, autoRotate, showGrid, showSkeleton }

  const clearRef = useRef(false)
  const undoRef = useRef(false)
  const recenterRef = useRef(false)
  const exportRef = useRef<null | 'stl' | 'glb'>(null)
  const strokesRef = useRef<StrokeRec[]>([])

  useEffect(() => {
    const video = videoRef.current!
    const mount = mountRef.current!
    const overlay = overlayRef.current!
    const octx = overlay.getContext('2d')!
    let landmarker: HandLandmarker | null = null
    let stream: MediaStream | null = null
    let rafId = 0, running = true, lastVideoTime = -1

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(55, 1, 0.01, 100)
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true })
    renderer.setClearColor(0x000000, 0)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    mount.appendChild(renderer.domElement)
    renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100vw;height:100vh;'

    scene.add(new THREE.AmbientLight(0xffffff, 0.65))
    const dir = new THREE.DirectionalLight(0xffffff, 0.9); dir.position.set(1.2, 2, 2.5); scene.add(dir)
    const dir2 = new THREE.DirectionalLight(0x88bbff, 0.35); dir2.position.set(-2, -1, -1); scene.add(dir2)

    const grid = new THREE.GridHelper(4, 16, 0x2a6f7a, 0x14343a)
    ;(grid.material as THREE.Material).transparent = true
    ;(grid.material as THREE.Material).opacity = 0.35
    grid.position.y = -1.4; scene.add(grid)

    const strokeGroup = new THREE.Group(); scene.add(strokeGroup)

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
    resize(); window.addEventListener('resize', resize)

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

    const disposeGroup = (g: THREE.Group) => {
      strokeGroup.remove(g)
      g.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose() })
    }

    // active stroke
    let aPts: THREE.Vector3[] = [], aMirror: THREE.Vector3[] = []
    let aGroup: THREE.Group | null = null, aMain: THREE.Mesh | null = null, aMir: THREE.Mesh | null = null
    let aMat: THREE.Material | null = null
    let wasDrawing = false

    const finalize = () => {
      const p = paramsRef.current
      if (aGroup && aMain && aPts.length >= 2) {
        // rebuild capped (watertight) geometry for the finished stroke
        const cap = buildStrokeGeometry(aPts, aMain.userData.radius, true)
        if (cap) { aMain.geometry.dispose(); aMain.geometry = cap }
        if (aMir && aMirror.length >= 2) {
          const cm = buildStrokeGeometry(aMirror, aMain.userData.radius, true)
          if (cm) { aMir.geometry.dispose(); aMir.geometry = cm }
        }
        strokesRef.current.push({ pts: aPts, mirrorPts: p.symmetry ? aMirror : null, radius: aMain.userData.radius, hex: p.color, brush: p.brush, group: aGroup })
        setCount(strokesRef.current.length)
      } else if (aGroup) { disposeGroup(aGroup) }
      aGroup = null; aMain = null; aMir = null; aMat = null; aPts = []; aMirror = []
    }

    const ndcToWorld = (ndcX: number, ndcY: number, depthNorm: number, dScale: number) => {
      const halfH = Math.tan((55 * Math.PI / 180) / 2) * cam.radius
      const halfW = halfH * camera.aspect
      const z = (depthNorm - 0.5) * 1.7 * dScale
      return new THREE.Vector3(ndcX * halfW * 0.92, ndcY * halfH * 0.92, z)
    }

    const doExport = (fmt: 'stl' | 'glb') => {
      const recs = strokesRef.current
      if (!recs.length) { setStatus('Rien à exporter — trace d\'abord un croquis.'); return }
      if (fmt === 'stl') {
        // merge every stroke's watertight (capped) geometry into one solid mesh
        const geoms: THREE.BufferGeometry[] = []
        for (const s of recs) {
          const g = buildStrokeGeometry(s.pts, s.radius, true); if (g) geoms.push(g)
          if (s.mirrorPts) { const gm = buildStrokeGeometry(s.mirrorPts, s.radius, true); if (gm) geoms.push(gm) }
        }
        if (!geoms.length) return
        const merged = geoms.length === 1 ? geoms[0] : mergeGeometries(geoms, false)
        const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial())
        const stl = new STLExporter().parse(mesh, { binary: false })
        downloadBlob(new Blob([stl], { type: 'model/stl' }), `sketch-${Date.now()}.stl`)
        merged.dispose()
        setStatus(`Export STL : ${recs.length} traits (maillage étanche pour impression 3D).`)
      } else {
        const g = new THREE.Group()
        for (const s of recs) {
          const geo = buildStrokeGeometry(s.pts, s.radius, true)
          if (geo) g.add(new THREE.Mesh(geo, makeBrushMaterial(s.brush, s.hex)))
          if (s.mirrorPts) { const gm = buildStrokeGeometry(s.mirrorPts, s.radius, true); if (gm) g.add(new THREE.Mesh(gm, makeBrushMaterial(s.brush, s.hex))) }
        }
        new GLTFExporter().parse(g, (res) => {
          downloadBlob(new Blob([res as ArrayBuffer], { type: 'model/gltf-binary' }), `sketch-${Date.now()}.glb`)
          g.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose() })
        }, () => setStatus('Échec export GLB.'), { binary: true })
        setStatus(`Export GLB : ${recs.length} traits (couleurs + matériaux conservés).`)
      }
    }

    const loop = () => {
      if (!running) return
      const p = paramsRef.current

      if (clearRef.current) {
        for (const s of strokesRef.current) disposeGroup(s.group)
        strokesRef.current = []; setCount(0)
        if (aGroup) disposeGroup(aGroup)
        aGroup = aMain = aMir = null; aPts = []; aMirror = []
        clearRef.current = false
      }
      if (undoRef.current) { const s = strokesRef.current.pop(); if (s) { disposeGroup(s.group); setCount(strokesRef.current.length) } undoRef.current = false }
      if (recenterRef.current) { cam.targetAz = 0; cam.targetPolar = Math.PI / 2; recenterRef.current = false }
      if (exportRef.current) { doExport(exportRef.current); exportRef.current = null }

      grid.visible = p.showGrid
      octx.clearRect(0, 0, overlay.width, overlay.height)
      let cursor: { x: number; y: number; on: boolean; erase: boolean } | null = null
      let depthNorm = 0.5

      if (video.readyState >= 2 && video.currentTime !== lastVideoTime && landmarker) {
        lastVideoTime = video.currentTime
        const hands = (landmarker.detectForVideo(video, performance.now()).landmarks) ?? []
        if (hands.length > 0) {
          const lm = hands[0]
          const idx = lm[TIP_INDEX], thumb = lm[TIP_THUMB]
          const ndcX = (1 - idx.x) * 2 - 1, ndcY = -(idx.y * 2 - 1)
          const handScale = Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y)
          depthNorm = Math.max(0, Math.min(1, (handScale - 0.08) / 0.22))
          const pinch = Math.hypot(idx.x - thumb.x, idx.y - thumb.y)
          const indexUp = lm[TIP_INDEX].y < lm[PIP_INDEX].y && lm[TIP_MIDDLE].y > lm[PIP_INDEX].y
          const on = p.drawMode === 'pinch' ? pinch < 0.055 : indexUp
          const sx = (1 - idx.x) * overlay.width, sy = idx.y * overlay.height
          cursor = { x: sx, y: sy, on, erase: p.eraser }
          const wp = ndcToWorld(ndcX, ndcY, depthNorm, p.depthScale)
          const radius = Math.max(0.004, p.size * 0.0016 * cam.radius * (BRUSHES.find((b) => b.kind === p.brush)?.rMul ?? 1))

          if (on && p.eraser) {
            // erase strokes whose any point is near the fingertip
            const er = Math.max(0.05, radius * 6)
            for (let i = strokesRef.current.length - 1; i >= 0; i--) {
              const s = strokesRef.current[i]
              const hit = s.pts.some((q) => q.distanceTo(wp) < er) || (s.mirrorPts?.some((q) => q.distanceTo(wp) < er) ?? false)
              if (hit) { disposeGroup(s.group); strokesRef.current.splice(i, 1) }
            }
            setCount(strokesRef.current.length)
            wasDrawing = false
          } else if (on) {
            cam.targetAz += (0 - cam.targetAz) * 0.15
            cam.targetPolar += (Math.PI / 2 - cam.targetPolar) * 0.15
            if (!wasDrawing) {
              aMat = makeBrushMaterial(p.brush, p.color)
              aPts = [wp]; aMirror = p.symmetry ? [new THREE.Vector3(-wp.x, wp.y, wp.z)] : []
              aGroup = new THREE.Group()
              aMain = new THREE.Mesh(new THREE.BufferGeometry(), aMat); aMain.frustumCulled = false; aMain.userData.radius = radius
              aGroup.add(aMain)
              if (p.symmetry) { aMir = new THREE.Mesh(new THREE.BufferGeometry(), aMat); aMir.frustumCulled = false; aGroup.add(aMir) }
              strokeGroup.add(aGroup)
            } else {
              const last = aPts[aPts.length - 1]
              if (wp.distanceTo(last) > Math.max(0.006, radius * 0.6)) {
                aPts.push(wp); if (aPts.length > 500) aPts.shift()
                if (p.symmetry) aMirror.push(new THREE.Vector3(-wp.x, wp.y, wp.z))
              }
            }
            const g = buildStrokeGeometry(aPts, aMain!.userData.radius, false)
            if (g && aMain) { aMain.geometry.dispose(); aMain.geometry = g }
            if (p.symmetry && aMir) { const gm = buildStrokeGeometry(aMirror, aMain!.userData.radius, false); if (gm) { aMir.geometry.dispose(); aMir.geometry = gm } }
            wasDrawing = true
          } else if (wasDrawing) { finalize(); wasDrawing = false }

          if (p.showSkeleton) {
            octx.strokeStyle = 'rgba(0,240,255,0.35)'; octx.lineWidth = 2
            for (const chain of FINGER_CHAINS) {
              octx.beginPath()
              chain.forEach((i, k) => { const px = (1 - lm[i].x) * overlay.width, py = lm[i].y * overlay.height; if (k === 0) octx.moveTo(px, py); else octx.lineTo(px, py) })
              octx.stroke()
            }
          }
        } else if (wasDrawing) { finalize(); wasDrawing = false }
      }

      // cursor
      if (cursor) {
        octx.beginPath(); octx.arc(cursor.x, cursor.y, cursor.on ? 15 : 8, 0, Math.PI * 2)
        octx.fillStyle = cursor.erase ? 'rgba(255,80,80,0.5)' : (cursor.on ? p.color : 'rgba(255,255,255,0.55)')
        octx.globalAlpha = cursor.on ? 0.85 : 0.5; octx.fill(); octx.globalAlpha = 1
        octx.lineWidth = 2; octx.strokeStyle = cursor.erase ? '#ff5050' : p.color; octx.stroke()
      }
      // depth gauge (right side): near=top, far=bottom
      const gx = overlay.width - 34, gy0 = overlay.height * 0.28, gh = overlay.height * 0.44
      octx.fillStyle = 'rgba(255,255,255,0.12)'; octx.fillRect(gx, gy0, 8, gh)
      const gy = gy0 + gh * (1 - depthNorm)
      octx.fillStyle = p.color; octx.fillRect(gx - 3, gy - 3, 14, 6)
      octx.fillStyle = 'rgba(255,255,255,0.55)'; octx.font = '10px system-ui'
      octx.fillText('proche', gx - 34, gy0 + 4); octx.fillText('loin', gx - 24, gy0 + gh)

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
        setStatus('Prêt — trace dans l\'espace, approche/éloigne la main pour la profondeur ✦')
        loop()
      } catch (e: any) { setError(`Caméra ou modèle indisponible : ${e?.message ?? e}`) }
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
      for (const s of strokesRef.current) s.group.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose() })
      strokesRef.current = []
      renderer.dispose()
      if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement)
    }
  }, [])

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return
    if (refUrl) URL.revokeObjectURL(refUrl)
    setRefUrl(URL.createObjectURL(f)); e.target.value = ''
  }
  const exportPng = () => {
    const three = mountRef.current?.querySelector('canvas') as HTMLCanvasElement | null
    if (!three) return
    const out = document.createElement('canvas'); out.width = three.width; out.height = three.height
    const c = out.getContext('2d')!
    if (bgMode === 'webcam' && videoRef.current && videoRef.current.readyState >= 2) {
      c.save(); c.translate(out.width, 0); c.scale(-1, 1); c.drawImage(videoRef.current, 0, 0, out.width, out.height); c.restore()
    } else { c.fillStyle = '#05060f'; c.fillRect(0, 0, out.width, out.height) }
    c.drawImage(three, 0, 0, out.width, out.height)
    out.toBlob((b) => { if (b) downloadBlob(b, `sketch-ar-${Date.now()}.png`) }, 'image/png')
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000', overflow: 'hidden', userSelect: 'none', fontFamily: 'system-ui' }}>
      <video ref={videoRef} autoPlay playsInline muted
        style={{ position: 'absolute', inset: 0, width: '100vw', height: '100vh', objectFit: 'cover', transform: 'scaleX(-1)', zIndex: 1, opacity: bgMode === 'webcam' ? 1 : 0 }} />
      {refUrl && <img src={refUrl} alt="" style={{ position: 'absolute', inset: 0, width: '100vw', height: '100vh', objectFit: 'contain', zIndex: 2, opacity: refOpacity, pointerEvents: 'none' }} />}
      <div ref={mountRef} style={{ position: 'absolute', inset: 0, zIndex: 3 }} />
      <canvas ref={overlayRef} style={{ position: 'absolute', inset: 0, width: '100vw', height: '100vh', zIndex: 4, pointerEvents: 'none' }} />

      {!panelOpen && <button onClick={() => setPanelOpen(true)} style={{ position: 'absolute', top: 16, left: 16, zIndex: 11, ...selStyle, width: 'auto', padding: '8px 12px' }}>☰</button>}

      {panelOpen && (
        <div style={{ position: 'absolute', top: 16, left: 16, zIndex: 10, width: 300, background: 'rgba(10,10,15,0.86)', padding: 18, borderRadius: 16, backdropFilter: 'blur(10px)', border: '1px solid rgba(255,255,255,0.15)', boxShadow: '0 10px 30px rgba(0,0,0,0.5)', maxHeight: 'calc(100vh - 32px)', overflowY: 'auto', color: '#ccc' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <strong style={{ color: '#00f0ff', textTransform: 'uppercase', letterSpacing: 1, fontSize: 14 }}>Sketch AR 3D · Pro</strong>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Link to="/" style={{ color: '#aaa', fontSize: 12, textDecoration: 'none' }}>← Studio</Link>
              <button onClick={() => setPanelOpen(false)} style={{ background: 'transparent', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: 16 }}>«</button>
            </div>
          </div>
          <div style={{ color: error ? '#ff6b6b' : '#7a7a85', fontSize: 11, marginBottom: 12, lineHeight: 1.3 }}>{error ?? status}</div>

          <Field label="Pinceau">
            <select value={brush} onChange={(e) => { setBrush(e.target.value as BrushKind); setEraser(false) }} style={selStyle}>
              {BRUSHES.map((b) => <option key={b.kind} value={b.kind}>{b.label}</option>)}
            </select>
          </Field>
          <button onClick={() => setEraser((v) => !v)} style={{ ...selStyle, marginBottom: 12, background: eraser ? 'rgba(255,80,80,0.28)' : 'rgba(255,255,255,0.1)', borderColor: eraser ? 'rgba(255,80,80,0.6)' : 'rgba(255,255,255,0.2)' }}>
            🧽 Gomme 3D {eraser ? '— ACTIVE' : ''}
          </button>

          <Field label="Couleur & épaisseur">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ width: 40, height: 30, border: 'none', background: 'none', cursor: 'pointer' }} />
              <input type="range" min={2} max={24} value={size} onChange={(e) => setSize(+e.target.value)} style={{ ...rngStyle, flex: 1 }} />
              <span style={{ fontSize: 12, width: 20, textAlign: 'right' }}>{size}</span>
            </div>
          </Field>

          <Field label="Geste de tracé">
            <select value={drawMode} onChange={(e) => setDrawMode(e.target.value as DrawMode)} style={selStyle}>
              <option value="pinch">✌️ Pince (pouce + index)</option>
              <option value="index">☝️ Index levé (autres pliés)</option>
            </select>
          </Field>

          <Field label={`Profondeur 3D (main proche/loin) — ×${depthScale.toFixed(1)}`}>
            <input type="range" min={0} max={3} step={0.1} value={depthScale} onChange={(e) => setDepthScale(+e.target.value)} style={rngStyle} />
          </Field>

          <label style={chkRow}><input type="checkbox" checked={symmetry} onChange={(e) => setSymmetry(e.target.checked)} style={{ accentColor: '#00f0ff' }} /> ⇋ Symétrie miroir</label>
          <label style={chkRow}><input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} style={{ accentColor: '#00f0ff' }} /> ▦ Grille de repère</label>
          <label style={chkRow}><input type="checkbox" checked={autoRotate} onChange={(e) => setAutoRotate(e.target.checked)} style={{ accentColor: '#00f0ff' }} /> ↻ Rotation auto</label>
          <label style={chkRow}><input type="checkbox" checked={showSkeleton} onChange={(e) => setShowSkeleton(e.target.checked)} style={{ accentColor: '#00f0ff' }} /> ✋ Squelette de la main</label>

          <Field label="Image de référence (à décalquer)">
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => fileRef.current?.click()} style={{ ...selStyle, flex: 1 }}>📥 Importer</button>
              {refUrl && <button onClick={() => { URL.revokeObjectURL(refUrl); setRefUrl(null) }} style={{ ...selStyle, flex: 1, background: 'rgba(255,40,100,0.2)', borderColor: 'rgba(255,40,100,0.4)' }}>Retirer</button>}
            </div>
            <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onFile} />
            {refUrl && <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}><span style={{ fontSize: 11, color: '#aaa' }}>Opacité</span><input type="range" min={0.05} max={1} step={0.05} value={refOpacity} onChange={(e) => setRefOpacity(+e.target.value)} style={{ ...rngStyle, flex: 1 }} /></div>}
          </Field>

          <Field label="Fond">
            <select value={bgMode} onChange={(e) => setBgMode(e.target.value as BgMode)} style={selStyle}>
              <option value="webcam">📷 Webcam (AR)</option>
              <option value="black">⬛ Noir (épuré)</option>
            </select>
          </Field>

          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => { undoRef.current = true }} style={{ ...selStyle, flex: 1 }}>↶ Annuler</button>
            <button onClick={() => { recenterRef.current = true }} style={{ ...selStyle, flex: 1 }}>⊙ Vue</button>
            <button onClick={() => { clearRef.current = true }} style={{ ...selStyle, flex: 1, background: 'rgba(255,40,100,0.2)', borderColor: 'rgba(255,40,100,0.4)' }}>Effacer</button>
          </div>
          <div style={{ fontSize: 10, color: '#00f0ff', textTransform: 'uppercase', letterSpacing: 1, margin: '14px 0 6px' }}>Export ({count} traits)</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={exportPng} style={{ ...selStyle, flex: 1 }}>📸 PNG</button>
            <button onClick={() => { exportRef.current = 'glb' }} style={{ ...selStyle, flex: 1 }}>🧊 .glb</button>
            <button onClick={() => { exportRef.current = 'stl' }} style={{ ...selStyle, flex: 1 }} title="Maillage étanche pour impression 3D">🖨️ .stl</button>
          </div>
          <p style={{ color: '#777', fontSize: 10, marginTop: 10, marginBottom: 0, lineHeight: 1.4 }}>
            Trace dans l'espace · main proche/loin = profondeur z (jauge à droite) · glisse à la souris = tourner en 3D · molette = zoom · .stl = solide imprimable
          </p>
        </div>
      )}
    </div>
  )
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1500)
}

const selStyle: React.CSSProperties = { width: '100%', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', color: 'white', padding: 8, borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: 13 }
const rngStyle: React.CSSProperties = { width: '100%', accentColor: '#00f0ff' }
const chkRow: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: '#ccc', marginTop: 8, cursor: 'pointer' }

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (<div style={{ marginBottom: 12 }}><div style={{ fontSize: 11, color: '#00f0ff', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5 }}>{label}</div>{children}</div>)
}
