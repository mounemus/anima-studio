/**
 * Esquisse spatiale — dessin et modelage 3D en réalité augmentée, piloté par les mains
 * seulement : Leap Motion (profondeur réelle, en millimètres) ou caméra (MediaPipe).
 *
 * Même famille d'outils qu'un logiciel de croquis 3D en réalité virtuelle, sans casque ni
 * manette : trait (tube, ruban, barre), révolution, surface entre deux bords, volumes,
 * saisie à une ou deux mains, édition des points de contrôle, peinture, gomme, symétrie
 * miroir ou radiale, calques, aimantation à la grille, vues mémorisées, export.
 *
 * Gestes : PINCE = agir avec l'outil · POING = attraper le monde (un poing le déplace,
 * deux poings le tournent et le redimensionnent) · PAUME OUVERTE de l'autre main =
 * palette d'outils autour de la paume (pince un outil avec la main qui dessine).
 *
 * Tout objet reste paramétrique (voir build.ts) : annulation, sauvegarde et réédition
 * rejouent simplement la liste des objets. Route /spatial, protégée par FrontGate.
 */
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import * as THREE from 'three'
import { FilesetResolver, GestureRecognizer } from '@mediapipe/tasks-vision'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js'
import { pollHands, handClock, autoConnectLeap, leapSettings, type LeapHand } from '../senses/Leap'
import { LeapToggle } from '../ui/LeapToggle'
import { buildGeometry, makeMaterial, symMatrices, objMatrix, simplify, bakeForExport, type Obj, type P3, type Kind, type Section, type Prim, type Mat, type Sym } from './build'

const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
const GESTURE_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task'
const FINGER_CHAINS = [[0, 1, 2, 3, 4], [0, 5, 6, 7, 8], [0, 9, 10, 11, 12], [0, 13, 14, 15, 16], [0, 17, 18, 19, 20]]
const SAVE_KEY = 'digiart:spatial'
const CAM_Z = 5, FOV = 50
const clamp = (a: number, b: number, v: number) => Math.max(a, Math.min(b, v))

type Tool = 'stroke' | 'revolve' | 'surface' | 'prim' | 'grab' | 'edit' | 'paint' | 'erase'
type Bg = 'webcam' | 'dark' | 'studio'
interface Layer { id: string; name: string; visible: boolean; locked: boolean }
interface View { id: string; pos: P3; quat: [number, number, number, number]; scale: number }
interface Cmd { type: string; data?: any }

const TOOLS: { id: Tool; icon: string; label: string; hint: string }[] = [
  { id: 'stroke', icon: '✏️', label: 'Trait', hint: 'Pince et déplace la main : le trait suit ta pince dans l\'espace.' },
  { id: 'revolve', icon: '🏺', label: 'Révolution', hint: 'Trace un profil : il tourne autour de l\'axe. Pose ton autre main là où tu veux l\'axe.' },
  { id: 'surface', icon: '🪁', label: 'Surface', hint: 'Deux mains : pince des deux et balaie. Une main : trace un bord, puis le second.' },
  { id: 'prim', icon: '🧊', label: 'Volume', hint: 'Pince au centre, écarte pour donner la taille, relâche.' },
  { id: 'grab', icon: '🤏', label: 'Saisir', hint: 'Pince un objet pour le déplacer ; pince aussi de l\'autre main pour le tourner et le redimensionner.' },
  { id: 'edit', icon: '🎯', label: 'Points', hint: 'Pince un objet pour afficher ses points, puis tire un point.' },
  { id: 'paint', icon: '🎨', label: 'Peindre', hint: 'Pince un objet : il prend la couleur et la matière choisies.' },
  { id: 'erase', icon: '🧽', label: 'Gomme', hint: 'Pince un objet pour l\'effacer.' },
]
const PRIMS: { id: Prim; label: string }[] = [
  { id: 'sphere', label: 'Sphère' }, { id: 'box', label: 'Boîte (coin à coin)' }, { id: 'cylinder', label: 'Cylindre' }, { id: 'cone', label: 'Cône' },
  { id: 'pyramid', label: 'Pyramide' }, { id: 'torus', label: 'Tore' }, { id: 'capsule', label: 'Capsule' }, { id: 'plane', label: 'Plaque' },
]
const MATS: { id: Mat; label: string }[] = [
  { id: 'matte', label: 'Mat (argile)' }, { id: 'gloss', label: 'Laqué brillant' }, { id: 'metal', label: 'Métal' },
  { id: 'neon', label: 'Néon' }, { id: 'glass', label: 'Verre' }, { id: 'wire', label: 'Fil de fer' },
]
const SWATCHES = ['#00f0ff', '#ff2d78', '#ffd200', '#7cff00', '#ff7a00', '#8a5cff', '#ffffff', '#20232b']

function loadSaved(): { objs: Obj[]; layers: Layer[] } | null {
  try { const s = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); return s && Array.isArray(s.objs) && Array.isArray(s.layers) && s.layers.length ? s : null } catch { return null }
}

/** Une main suivie (0 et 1) ou la souris (2). */
interface Slot {
  has: boolean; seen: number
  pinch: boolean; was: boolean; fist: number; open: number
  scr: { x: number; y: number }; palmScr: { x: number; y: number }
  ndc: THREE.Vector2; p: THREE.Vector3; fresh: boolean
  lm: { x: number; y: number }[]; leap?: LeapHand
}
const mkSlot = (): Slot => ({ has: false, seen: 0, pinch: false, was: false, fist: 0, open: 0, scr: { x: 0, y: 0 }, palmScr: { x: 0, y: 0 }, ndc: new THREE.Vector2(), p: new THREE.Vector3(), fresh: true, lm: [] })

export function SpatialStudio() {
  const [saved] = useState(loadSaved)
  const [tool, setTool] = useState<Tool>('stroke')
  const [section, setSection] = useState<Section>('round')
  const [straight, setStraight] = useState(false)
  const [size, setSize] = useState(8)
  const [taper, setTaper] = useState(0.4)
  const [color, setColor] = useState('#00f0ff')
  const [mat, setMat] = useState<Mat>('matte')
  const [prim, setPrim] = useState<Prim>('sphere')
  const [sym, setSym] = useState<Sym>('none')
  const [symN, setSymN] = useState(6)
  const [sides, setSides] = useState(48)
  const [sweepDeg, setSweepDeg] = useState(360)
  const [snap, setSnap] = useState(false)
  const [snapStep, setSnapStep] = useState(0.25)
  const [duplicate, setDuplicate] = useState(false)
  const [layers, setLayers] = useState<Layer[]>(saved?.layers ?? [{ id: 'L1', name: 'Calque 1', visible: true, locked: false }])
  const [activeLayer, setActiveLayer] = useState(saved?.layers?.[0]?.id ?? 'L1')
  const [bg, setBg] = useState<Bg>('webcam')
  const [showGrid, setShowGrid] = useState(true)
  const [showHands, setShowHands] = useState(true)
  const [depthGain, setDepthGain] = useState(1)
  const [views, setViews] = useState<View[]>([])
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth > 700)   // sur téléphone, le panneau couvrirait la scène
  const [status, setStatus] = useState('Chargement…')
  const [error, setError] = useState<string | null>(null)
  const [count, setCount] = useState(0)
  const [selected, setSelected] = useState(false)
  const [handsOn, setHandsOn] = useState(true)   // suspendre le suivi : sinon des mains au clavier, vues par la caméra, dessinent

  const P = { tool, section, straight, size, taper, color, mat, prim, sym, symN, sides, sweepDeg, snap, snapStep, duplicate, layers, activeLayer, bg, showGrid, showHands, depthGain, views, handsOn }
  const paramsRef = useRef(P); paramsRef.current = P
  const cmdRef = useRef<Cmd[]>([])
  const send = (type: string, data?: any) => { cmdRef.current.push({ type, data }) }
  useEffect(() => { send('autosave') }, [layers])   // noms, visibilité et verrous des calques font partie du projet

  const videoRef = useRef<HTMLVideoElement>(null), mountRef = useRef<HTMLDivElement>(null), overlayRef = useRef<HTMLCanvasElement>(null)
  const fileRef = useRef<HTMLInputElement>(null), imgRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const video = videoRef.current!, mount = mountRef.current!, overlay = overlayRef.current!
    const octx = overlay.getContext('2d')!
    let rafId = 0, running = true
    let landmarker: GestureRecognizer | null = null, stream: MediaStream | null = null
    const clock = handClock(); autoConnectLeap()

    // ───────── scène ─────────
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true })
    renderer.setClearColor(0x000000, 0); renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    mount.appendChild(renderer.domElement)
    const el = renderer.domElement; el.style.cssText = 'position:absolute;inset:0;width:100vw;height:100vh;touch-action:none;user-select:none;'
    const scene = new THREE.Scene()
    const pmrem = new THREE.PMREMGenerator(renderer), envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    scene.environment = envTex; scene.environmentIntensity = 0.45   // reflets pour le métal et le laqué, sans délaver les couleurs
    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 200); camera.position.set(0, 0, CAM_Z)
    const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(3, 5, 4); scene.add(sun, new THREE.HemisphereLight(0xffffff, 0x2a3340, 0.45))
    // `world` = ce qu'on attrape avec les poings ; `content` = les objets dessinés.
    const world = new THREE.Group(), content = new THREE.Group(); scene.add(world); world.add(content)
    const grid = new THREE.GridHelper(8, 32, 0x00f0ff, 0x4a6578); grid.position.y = -1.6
    ;(grid.material as THREE.Material).transparent = true; (grid.material as THREE.Material).opacity = 0.4; world.add(grid)
    const mirrorPlane = new THREE.Mesh(new THREE.PlaneGeometry(7, 4.4), new THREE.MeshBasicMaterial({ color: 0xff2d78, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false }))
    mirrorPlane.rotation.y = Math.PI / 2; mirrorPlane.position.y = 0.6; world.add(mirrorPlane)
    const lineOf = (hex: number) => { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 1, 0)]), new THREE.LineBasicMaterial({ color: hex, transparent: true, opacity: 0.8, depthTest: false })); l.renderOrder = 9; l.frustumCulled = false; return l }
    const axisLine = lineOf(0xffd200), dropLine = lineOf(0xffffff); world.add(axisLine, dropLine)
    const setLine = (l: THREE.Line, a: THREE.Vector3, b: THREE.Vector3) => { const at = l.geometry.getAttribute('position') as THREE.BufferAttribute; at.setXYZ(0, a.x, a.y, a.z); at.setXYZ(1, b.x, b.y, b.z); at.needsUpdate = true }
    const cursorGeo = new THREE.SphereGeometry(1, 16, 12)
    const cursors = [0, 1, 2].map(() => { const m = new THREE.Mesh(cursorGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthTest: false })); m.renderOrder = 10; m.visible = false; scene.add(m); return m })
    const handles = new THREE.Group(); content.add(handles)
    const handleMat = new THREE.MeshBasicMaterial({ color: 0xffd200, depthTest: false, transparent: true, opacity: 0.95 })
    const railMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 })
    const ray = new THREE.Raycaster()

    const resize = () => { const w = window.innerWidth, h = window.innerHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); overlay.width = w; overlay.height = h }
    resize(); window.addEventListener('resize', resize)
    const visW = () => 2 * CAM_Z * Math.tan(FOV * Math.PI / 360) * camera.aspect   // largeur visible au centre de la scène

    // ───────── objets (liste paramétrique + nœuds three) ─────────
    let objs: Obj[] = saved?.objs ?? []
    const nodes = new Map<string, THREE.Group>()
    const past: string[] = []
    let future: string[] = [], seq = 0
    const disposeNode = (g: THREE.Object3D) => {
      g.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose(); const mt = m.material as (THREE.Material & { map?: THREE.Texture }) | undefined; if (mt && mt !== handleMat && mt !== railMat) { mt.map?.dispose(); mt.dispose() } })
      g.removeFromParent()
    }
    const buildNode = (o: Obj): THREE.Group | null => {
      const geo = buildGeometry(o); if (!geo) return null
      let material: THREE.Material
      if (o.kind === 'image') { const tex = new THREE.TextureLoader().load(o.img ?? ''); tex.colorSpace = THREE.SRGBColorSpace; material = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: true, opacity: 0.85, toneMapped: false }) }
      else material = makeMaterial(o.mat, o.color)
      const node = new THREE.Group(), own = objMatrix(o)
      for (const S of symMatrices(o.kind === 'image' ? 'none' : o.sym, o.symN)) { const m = new THREE.Mesh(geo, material); m.matrixAutoUpdate = false; m.matrix.copy(S).multiply(own); m.userData.id = o.id; node.add(m) }
      return node
    }
    const refresh = (o: Obj) => { const old = nodes.get(o.id); if (old) disposeNode(old); const n = buildNode(o); if (n) { content.add(n); nodes.set(o.id, n) } else nodes.delete(o.id) }
    const setPose = (o: Obj) => { const n = nodes.get(o.id); if (!n) return; const own = objMatrix(o), S = symMatrices(o.kind === 'image' ? 'none' : o.sym, o.symN); n.children.forEach((m, k) => { m.matrix.copy(S[k] ?? S[0]).multiply(own); m.matrixWorldNeedsUpdate = true }) }
    const syncAll = () => { nodes.forEach(disposeNode); nodes.clear(); objs.forEach(refresh); setCount(objs.length) }
    const autosave = () => { try { localStorage.setItem(SAVE_KEY, JSON.stringify({ objs, layers: paramsRef.current.layers })) } catch { /* quota : le projet reste en mémoire, « Enregistrer » le met dans un fichier */ } }
    const pushHistory = () => { past.push(JSON.stringify(objs)); if (past.length > 60) past.shift(); future = [] }
    const commit = (o: Obj) => { pushHistory(); objs.push(o); refresh(o); setCount(objs.length); autosave() }
    const remove = (id: string) => { objs = objs.filter((o) => o.id !== id); const n = nodes.get(id); if (n) { disposeNode(n); nodes.delete(id) } if (selId === id) select(null); setCount(objs.length) }
    const newObj = (kind: Kind, extra: Partial<Obj>): Obj => {
      const p = paramsRef.current
      return { id: `o${(seq++).toString(36)}${Date.now().toString(36)}`, kind, layer: p.activeLayer, color: p.color, mat: p.mat, pts: [], size: 0.02, section: p.section, taper: p.taper, sym: p.sym, symN: p.symN, pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: 1, ...extra }
    }
    const layerOf = (id: string) => paramsRef.current.layers.find((l) => l.id === id)
    const usable = (o: Obj) => { const l = layerOf(o.layer); return !!l && l.visible && !l.locked }

    // ───────── sélection et points de contrôle ─────────
    let selId: string | null = null
    const handleGeo = new THREE.SphereGeometry(1, 10, 8)
    const ctrlPts = (o: Obj): P3[] => o.kind === 'image' ? [] : [...o.pts, ...(o.pts2 ?? [])]
    const showHandles = () => {
      handles.clear()
      const o = objs.find((x) => x.id === selId); if (!o) return
      const own = objMatrix(o)
      for (const pt of ctrlPts(o).slice(0, 300)) { const h = new THREE.Mesh(handleGeo, handleMat); h.position.fromArray(pt).applyMatrix4(own); h.renderOrder = 11; handles.add(h) }
    }
    const select = (id: string | null) => { selId = id; showHandles(); setSelected(!!id) }

    // ───────── mains ─────────
    const slots: Slot[] = [mkSlot(), mkSlot(), mkSlot()]
    const suppress = [false, false, false]      // pince consommée par la palette
    const dist2 = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)
    const tmp = new THREE.Vector3(), dirV = new THREE.Vector3()
    /** Point 3D sous la position écran `ndc`, sur le plan de profondeur `dz` face à la caméra. */
    const pointAt = (ndc: THREE.Vector2, dz: number, out: THREE.Vector3) => {
      dirV.set(ndc.x, ndc.y, 0.5).unproject(camera).sub(camera.position).normalize()
      return out.copy(camera.position).addScaledVector(dirV, (dz - camera.position.z) / dirV.z)
    }
    const readHands = (res: { landmarks?: any[][]; gestures?: any[][]; leap?: LeapHand[] }, p: typeof P, now: number) => {
      const W = overlay.width, H = overlay.height
      const hands = (res.landmarks ?? []).slice(0, 2)
      const palms = hands.map((lm) => ({ x: (1 - lm[9].x) * W, y: lm[9].y * H }))
      // garder chaque main dans sa case d'une image à l'autre (la plus proche de sa position précédente)
      const cost = (i: number, s: number) => (slots[s].has ? dist2(palms[i], slots[s].palmScr) : 0)
      let order = [0, 1]
      if (hands.length === 2) { if (cost(0, 1) + cost(1, 0) < cost(0, 0) + cost(1, 1)) order = [1, 0] }
      else if (hands.length === 1) order = [slots[1].has && (!slots[0].has || cost(0, 1) < cost(0, 0)) ? 1 : 0]
      const used = new Set<number>()
      hands.forEach((lm, i) => {
        const s = slots[order[i]], leap = res.leap?.[i], g = res.gestures?.[i]?.[0]?.categoryName ?? 'None'
        used.add(order[i])
        const hs = Math.max(0.02, Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y))
        const fist = g === 'Closed_Fist'
        s.fist = fist ? Math.min(s.fist + 1, 9) : 0
        s.open = g === 'Open_Palm' ? Math.min(s.open + 1, 30) : 0
        // pince avec hystérésis : lue sur le capteur avec le Leap, sur les jalons avec la caméra
        const ratio = Math.hypot(lm[4].x - lm[8].x, lm[4].y - lm[8].y) / hs
        const on = leap ? (s.pinch ? leap.pinch > 0.55 : leap.pinch > 0.8) : (s.pinch ? ratio < 0.62 : ratio < 0.42)
        s.pinch = on && s.fist < 2
        // point d'action : milieu pouce-index (la paume quand le poing est fermé, plus stable)
        const ax = s.fist >= 2 ? lm[9].x : (lm[4].x + lm[8].x) / 2, ay = s.fist >= 2 ? lm[9].y : (lm[4].y + lm[8].y) / 2
        s.scr.x = (1 - ax) * W; s.scr.y = ay * H; s.palmScr = palms[i]
        s.ndc.set((1 - ax) * 2 - 1, -(ay * 2 - 1))
        // profondeur : millimètres réels du Leap, ou taille apparente de la main à la caméra
        // (main poussée vers l'écran = plus loin dans la scène)
        const dz = leap ? leap.pinchMm.z * (visW() / leapSettings().span) * p.depthGain : -clamp(-1, 1, (hs - 0.16) / 0.12) * 1.2 * p.depthGain
        pointAt(s.ndc, clamp(-3.5, 3.5, dz), tmp)
        if (s.fresh || !s.has) s.p.copy(tmp); else s.p.lerp(tmp, clamp(0.3, 0.9, 0.3 + tmp.distanceTo(s.p) * 3))
        s.fresh = false; s.has = true; s.seen = now; s.leap = leap
        s.lm = lm.map((k: { x: number; y: number }) => ({ x: (1 - k.x) * W, y: k.y * H }))
      })
      for (let i = 0; i < 2; i++) if (!used.has(i)) { const s = slots[i]; s.has = false; s.pinch = false; s.fist = 0; s.open = 0; s.fresh = true; s.lm = [] }
    }

    // ───────── souris / tactile (case 2) : même chemin que les mains ─────────
    let mouseDepth = 0, drag: null | 'draw' | 'orbit' | 'pan' = null, lastPtr = { x: 0, y: 0 }
    const ptrNdc = (e: PointerEvent | WheelEvent) => slots[2].ndc.set((e.clientX / window.innerWidth) * 2 - 1, -((e.clientY / window.innerHeight) * 2 - 1))
    const onDown = (e: PointerEvent) => {
      try { el.setPointerCapture?.(e.pointerId) } catch { /* pointeur déjà relâché */ }
      lastPtr = { x: e.clientX, y: e.clientY }; ptrNdc(e)
      drag = e.button === 2 ? 'orbit' : (e.button === 1 || e.altKey) ? 'pan' : 'draw'
      const s = slots[2]; s.scr = { x: e.clientX, y: e.clientY }
      if (drag === 'draw') { pointAt(s.ndc, mouseDepth, s.p); s.has = true; s.pinch = true }
    }
    const onMove = (e: PointerEvent) => {
      const dx = e.clientX - lastPtr.x, dy = e.clientY - lastPtr.y; lastPtr = { x: e.clientX, y: e.clientY }
      ptrNdc(e); slots[2].scr = { x: e.clientX, y: e.clientY }
      if (drag === 'orbit') { const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(dy * 0.006, dx * 0.006, 0)); world.position.applyQuaternion(q); world.quaternion.premultiply(q); viewGoal = null }
      else if (drag === 'pan') { const u = visW() / window.innerWidth; world.position.x += dx * u; world.position.y -= dy * u; viewGoal = null }
    }
    const onUp = () => { drag = null; slots[2].pinch = false; slots[2].has = false }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (e.shiftKey) { mouseDepth = clamp(-3.5, 3.5, mouseDepth - Math.sign(e.deltaY || e.deltaX) * 0.15); setStatus(`Profondeur du pointeur : ${mouseDepth.toFixed(2)}`); return }
      const f = clamp(0.5, 2, Math.exp(-e.deltaY * 0.0012)), s = clamp(0.1, 20, world.scale.x * f), k = s / world.scale.x
      world.scale.setScalar(s); world.position.multiplyScalar(k); viewGoal = null
    }
    const noMenu = (e: Event) => e.preventDefault()
    el.addEventListener('pointerdown', onDown); el.addEventListener('pointermove', onMove); el.addEventListener('pointerup', onUp); el.addEventListener('pointercancel', onUp)
    el.addEventListener('wheel', onWheel, { passive: false }); el.addEventListener('contextmenu', noMenu)

    // ───────── repères et outils de géométrie ─────────
    let k = 1                                               // 1 / échelle du monde : taille d'une unité écran en unités dessinées
    const toLocal = (v: THREE.Vector3, snapIt = true): P3 => {
      const q = content.worldToLocal(v.clone()), p = paramsRef.current
      if (snapIt && p.snap) { const st = p.snapStep; q.set(Math.round(q.x / st) * st, Math.round(q.y / st) * st, Math.round(q.z / st) * st) }
      return [q.x, q.y, q.z]
    }
    const d3 = (a: P3, b: P3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
    const invWorldQ = new THREE.Quaternion()
    /** Normale du plat du ruban, dans le repère dessiné : paume (Leap) ou face à l'écran. */
    const palmNormal = (s: Slot): P3 => { const n = s.leap ? tmp.set(s.leap.normal.x, s.leap.normal.y, s.leap.normal.z) : tmp.set(0, 0, 1); n.applyQuaternion(invWorldQ).normalize(); return [n.x, n.y, n.z] }
    /** Transformation qui amène le segment (a0, b0) sur (a1, b1) : translation + rotation + échelle. */
    const twoHand = (a0: THREE.Vector3, b0: THREE.Vector3, a1: THREE.Vector3, b1: THREE.Vector3) => {
      const e0 = b0.clone().sub(a0), e1 = b1.clone().sub(a1)
      const s = clamp(0.25, 4, e1.length() / Math.max(1e-4, e0.length()))
      const q = new THREE.Quaternion().setFromUnitVectors(e0.normalize(), e1.normalize())
      const m0 = a0.clone().add(b0).multiplyScalar(0.5), m1 = a1.clone().add(b1).multiplyScalar(0.5)
      return new THREE.Matrix4().makeTranslation(m1.x, m1.y, m1.z).multiply(new THREE.Matrix4().makeRotationFromQuaternion(q)).multiply(new THREE.Matrix4().makeScale(s, s, s)).multiply(new THREE.Matrix4().makeTranslation(-m0.x, -m0.y, -m0.z))
    }
    const scrOf = (pt: P3, own: THREE.Matrix4) => { tmp.fromArray(pt).applyMatrix4(own).applyMatrix4(content.matrixWorld).project(camera); return { x: (tmp.x * 0.5 + 0.5) * overlay.width, y: (-tmp.y * 0.5 + 0.5) * overlay.height } }
    /** Objet sous la position écran : rayon d'abord, sinon point de contrôle le plus proche (traits fins). */
    const pick = (s: Slot): Obj | null => {
      ray.setFromCamera(s.ndc, camera)
      for (const hit of ray.intersectObjects([...nodes.values()], true)) { const o = objs.find((x) => x.id === hit.object.userData.id); if (o && usable(o)) return o }
      let best: Obj | null = null, bd = 34
      for (const o of objs) { if (!usable(o)) continue; const own = objMatrix(o); for (const pt of ctrlPts(o)) { const d = dist2(scrOf(pt, own), s.scr); if (d < bd) { bd = d; best = o } } }
      return best
    }

    // ───────── action en cours (de la pince au relâchement) ─────────
    let draft: Obj | null = null, draftNode: THREE.Group | null = null
    const showDraft = () => { if (draftNode) disposeNode(draftNode); draftNode = draft ? buildNode(draft) : null; if (draftNode) content.add(draftNode) }
    interface Act { tool: Tool; slot: number; railB: P3[]; obj?: Obj; start?: P3; pos0?: P3; two?: { a0: THREE.Vector3; b0: THREE.Vector3; m0: THREE.Matrix4 }; handle?: number; pts0?: P3; changed?: boolean }
    let act: Act | null = null
    let pendingRail: P3[] | null = null, railNode: THREE.Group | null = null
    let axisO: P3 = [0, 0, 0]
    const setRail = (pts: P3[] | null) => { pendingRail = pts; if (railNode) { disposeNode(railNode); railNode = null } if (pts) { const g = buildGeometry(newObj('stroke', { pts, size: 0.008 * k, section: 'round', taper: 0, sym: 'none' })); if (g) { railNode = new THREE.Group(); railNode.add(new THREE.Mesh(g, railMat)); content.add(railNode) } } }
    const other = (i: number) => (i === 2 ? null : slots[1 - i])
    const thin = (o: Obj, eps: number) => { const keep = simplify(o.pts, eps); if (o.nrm) o.nrm = keep.map((i) => o.nrm![i]); o.pts = keep.map((i) => o.pts[i]) }

    const begin = (i: number, p: typeof P) => {
      const s = slots[i], cur = toLocal(s.p), r = Math.max(0.002, p.size * 0.004) * k
      const creating = p.tool === 'stroke' || p.tool === 'revolve' || p.tool === 'surface' || p.tool === 'prim'
      const lay = layerOf(p.activeLayer)
      if (creating && (!lay || !lay.visible || lay.locked)) { setStatus('Le calque actif est masqué ou verrouillé : choisis-en un autre pour dessiner.'); return }
      act = { tool: p.tool, slot: i, railB: [] }; if (i < 2) lastHand = i
      if (p.tool === 'stroke') draft = newObj('stroke', { pts: [cur], nrm: [palmNormal(s)], size: r })
      else if (p.tool === 'revolve') { const o2 = other(i); if (o2?.has && !o2.pinch && o2.fist < 2) axisO = toLocal(o2.p); draft = newObj('revolve', { pts: [cur], axisO, axisD: [0, 1, 0], sides: p.sides, sweep: p.sweepDeg }) }
      else if (p.tool === 'surface') draft = newObj('stroke', { pts: [cur], size: 0.008 * k, section: 'round', taper: 0 })
      else if (p.tool === 'prim') draft = newObj('prim', { prim: p.prim, pts: [cur, cur] })
      else if (p.tool === 'grab') {
        let o = pick(s); if (!o) { act = null; setStatus('Rien sous la pince : vise un objet.'); return }
        pushHistory()
        if (p.duplicate) { o = { ...JSON.parse(JSON.stringify(o)), id: `o${(seq++).toString(36)}${Date.now().toString(36)}` } as Obj; objs.push(o); refresh(o); setCount(objs.length) }
        act.obj = o; act.start = toLocal(s.p, false); act.pos0 = [...o.pos] as P3
      } else if (p.tool === 'edit') {
        const sel = objs.find((x) => x.id === selId)
        if (sel) { const own = objMatrix(sel); let bi = -1, bd = 30; ctrlPts(sel).forEach((pt, j) => { const d = dist2(scrOf(pt, own), s.scr); if (d < bd) { bd = d; bi = j } })
          if (bi >= 0) { pushHistory(); act.obj = sel; act.handle = bi; act.start = toLocal(s.p, false); act.pts0 = [...ctrlPts(sel)[bi]] as P3; return } }
        const o = pick(s); select(o ? o.id : null); act = null
        setStatus(o ? 'Objet sélectionné : tire un point jaune, ou « Appliquer les réglages » dans le panneau.' : 'Rien sous la pince.')
      }
      if (draft) showDraft()
    }

    const update = (p: typeof P) => {
      const a = act!, s = slots[a.slot], cur = toLocal(s.p), o2 = other(a.slot)
      if (draft && (a.tool === 'stroke' || a.tool === 'revolve' || a.tool === 'surface')) {
        const last = draft.pts[draft.pts.length - 1], step = Math.max(0.006 * k, draft.size * 0.6)
        if (a.tool === 'stroke' && p.straight) {
          // trait droit ; avec l'aimant, il s'aligne sur l'axe le plus proche (à moins de 12°)
          const a0 = draft.pts[0], v = [cur[0] - a0[0], cur[1] - a0[1], cur[2] - a0[2]], len = Math.hypot(v[0], v[1], v[2])
          let end = cur
          if (p.snap && len > 1e-6) { const ax = v.map((x) => Math.abs(x) / len), m = ax.indexOf(Math.max(...ax)); if (ax[m] > Math.cos(12 * Math.PI / 180)) { end = [...a0] as P3; end[m] = cur[m] } }
          draft.pts = [a0, end]; draft.nrm = [draft.nrm![0], draft.nrm![0]]; showDraft()
        } else if (d3(cur, last) > step) {
          draft.pts.push(cur); draft.nrm?.push(palmNormal(s))
          if (a.tool === 'surface' && o2?.has && o2.pinch) { a.railB.push(toLocal(o2.p)); if (a.railB.length >= 2) { draft.kind = 'surface'; draft.pts2 = a.railB } }
          showDraft()
        }
      } else if (draft && a.tool === 'prim') { draft.pts[1] = cur; showDraft() }
      else if (a.tool === 'grab' && a.obj) {
        const o = a.obj, c = toLocal(s.p, false)
        if (o2?.has && o2.pinch) {
          const A = new THREE.Vector3().fromArray(c), B = new THREE.Vector3().fromArray(toLocal(o2.p, false))
          if (!a.two) a.two = { a0: A, b0: B, m0: objMatrix(o) }
          else { const m = twoHand(a.two.a0, a.two.b0, A, B).multiply(a.two.m0), pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3(); m.decompose(pos, q, sc); o.pos = pos.toArray() as P3; o.quat = q.toArray() as Obj['quat']; o.scale = sc.x }
        } else {
          if (a.two) { a.two = undefined; a.start = c; a.pos0 = [...o.pos] as P3 }   // la 2e main a lâché : repartir de la pose actuelle
          let np: P3 = [a.pos0![0] + c[0] - a.start![0], a.pos0![1] + c[1] - a.start![1], a.pos0![2] + c[2] - a.start![2]]
          if (p.snap) np = np.map((x) => Math.round(x / p.snapStep) * p.snapStep) as P3
          o.pos = np
        }
        setPose(o); if (selId === o.id) showHandles()
      } else if (a.tool === 'edit' && a.obj && a.handle !== undefined) {
        // déplacement du point = déplacement de la main, ramené dans le repère propre de l'objet
        const o = a.obj, c = toLocal(s.p, false)
        const dlt = tmp.set(c[0] - a.start![0], c[1] - a.start![1], c[2] - a.start![2]).applyQuaternion(new THREE.Quaternion().fromArray(o.quat).invert()).divideScalar(o.scale)
        let np: P3 = [a.pts0![0] + dlt.x, a.pts0![1] + dlt.y, a.pts0![2] + dlt.z]
        if (p.snap) np = np.map((x) => Math.round(x / p.snapStep) * p.snapStep) as P3
        if (a.handle < o.pts.length) o.pts[a.handle] = np; else o.pts2![a.handle - o.pts.length] = np
        refresh(o); showHandles()
      } else if (a.tool === 'paint' || a.tool === 'erase') {
        const o = pick(s); if (!o) return
        if (a.tool === 'erase') { if (!a.changed) pushHistory(); a.changed = true; remove(o.id) }
        else if (o.kind !== 'image' && (o.color !== p.color || o.mat !== p.mat)) { if (!a.changed) pushHistory(); a.changed = true; o.color = p.color; o.mat = p.mat; refresh(o) }
      }
    }

    const end = () => {
      const a = act!; act = null
      const d = draft; draft = null; showDraft()
      if (d) {
        if (a.tool === 'stroke') { if (d.pts.length > 2) thin(d, d.size * 0.25); commit(d) }
        else if (a.tool === 'revolve') { thin(d, 0.004 * k); if (d.pts.length >= 2) commit(d); else setStatus('Profil trop court : pince et déplace la main pour tracer le profil.') }
        else if (a.tool === 'prim') { if (d3(d.pts[0], d.pts[1]) > 0.03 * k) commit(d); else setStatus('Volume trop petit : pince, écarte la main, puis relâche.') }
        else if (a.tool === 'surface') {
          const p = paramsRef.current, mk = (A: P3[], B: P3[]) => newObj('surface', { pts: A, pts2: B, section: p.section })
          if (d.kind === 'surface' && d.pts2 && d.pts2.length >= 2) { const kA = simplify(d.pts, 0.004 * k), kB = simplify(d.pts2, 0.004 * k); commit(mk(kA.map((i) => d.pts[i]), kB.map((i) => d.pts2![i]))); setRail(null) }
          else if (d.pts.length >= 2) {
            thin(d, 0.004 * k)
            if (pendingRail) { commit(mk(pendingRail, d.pts)); setRail(null); setStatus('Surface tendue entre les deux bords.') }
            else { setRail(d.pts); setStatus('Premier bord posé : trace maintenant le second bord.') }
          }
        }
      }
      if ((a.tool === 'grab' || a.tool === 'edit' || a.changed) && (a.obj || a.changed)) autosave()
    }

    // ───────── navigation : attraper le monde avec les poings ─────────
    let nav: { key: string; a: THREE.Vector3; b: THREE.Vector3 } | null = null
    let viewGoal: View | null = null
    const navigate = () => {
      const f = [slots[0], slots[1]].filter((s) => s.has && s.fist >= 2)
      if (act || !f.length) { nav = null; return }
      viewGoal = null
      const key = f.map((s) => slots.indexOf(s)).join()
      if (nav && nav.key === key) {
        if (f.length === 1) world.position.add(tmp.subVectors(f[0].p, nav.a))
        else { world.updateMatrix(); const m = twoHand(nav.a, nav.b, f[0].p, f[1].p).multiply(world.matrix); m.decompose(world.position, world.quaternion, world.scale); world.scale.setScalar(clamp(0.1, 20, world.scale.x)) }
      }
      nav = { key, a: f[0].p.clone(), b: (f[1] ?? f[0]).p.clone() }
    }

    // ───────── palette d'outils autour de la paume ouverte ─────────
    let menu: { slot: number; hover: number } | null = null, lastHand = -1   // dernière main qui a agi
    const menuItem = (c: { x: number; y: number }, j: number) => { const a = -Math.PI / 2 + j / TOOLS.length * Math.PI * 2; return { x: c.x + Math.cos(a) * 118, y: c.y + Math.sin(a) * 118 } }
    const palette = () => {
      menu = null
      if (act) return
      const m = [0, 1].find((i) => i !== lastHand && slots[i].has && slots[i].open >= 8 && !slots[i].pinch && slots[1 - i].has)
      if (m === undefined) return
      const h = slots[1 - m]; menu = { slot: m, hover: -1 }
      TOOLS.forEach((_, j) => { if (dist2(menuItem(slots[m].palmScr, j), h.scr) < 38) menu!.hover = j })
      if (menu.hover >= 0 && h.pinch && !h.was) { setTool(TOOLS[menu.hover].id); setStatus(`Outil : ${TOOLS[menu.hover].label}`); suppress[1 - m] = true }
    }

    // ───────── commandes venues du panneau ─────────
    const download = (blob: Blob, name: string) => { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1500) }
    const visibleObjs = () => objs.filter((o) => layerOf(o.layer)?.visible)
    const run = (c: Cmd, p: typeof P) => {
      const restore = (json: string) => { objs = JSON.parse(json); select(null); setRail(null); syncAll(); autosave() }
      switch (c.type) {
        case 'undo': if (past.length) { future.push(JSON.stringify(objs)); restore(past.pop()!); setStatus('↶ Annulé.') } else setStatus('Rien à annuler.'); break
        case 'redo': if (future.length) { past.push(JSON.stringify(objs)); restore(future.pop()!); setStatus('↷ Refait.') } else setStatus('Rien à refaire.'); break
        case 'clear': if (objs.some((o) => o.layer === p.activeLayer)) { pushHistory(); objs.filter((o) => o.layer === p.activeLayer).forEach((o) => remove(o.id)); autosave(); setStatus('Calque actif vidé (Annuler pour le retrouver).') } break
        case 'delete': if (selId) { pushHistory(); remove(selId); autosave() } break
        case 'apply': { const o = objs.find((x) => x.id === selId); if (!o || o.kind === 'image') break
          pushHistory(); const sc = p.size * 0.004 * k
          Object.assign(o, { color: p.color, mat: p.mat, sym: p.sym, symN: p.symN, section: p.section, taper: p.taper })
          if (o.kind === 'stroke') o.size = sc
          if (o.kind === 'revolve') { o.sides = p.sides; o.sweep = p.sweepDeg }
          refresh(o); showHandles(); autosave(); setStatus('Réglages appliqués à la sélection.'); break }
        case 'axis': axisO = [0, 0, 0]; setStatus('Axe de révolution remis au centre.'); break
        case 'recenter': viewGoal = { id: '', pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: 1 }; break
        case 'view:add': setViews((v) => [...v, { id: `v${Date.now()}`, pos: world.position.toArray() as P3, quat: world.quaternion.toArray() as View['quat'], scale: world.scale.x }]); break
        case 'view:go': viewGoal = p.views.find((v) => v.id === c.data) ?? null; break
        case 'image': { const lay = layerOf(p.activeLayer); if (!lay || lay.locked) { setStatus('Calque actif verrouillé.'); break }
          commit(newObj('image', { pts: [toLocal(tmp.set(0, 0, 0), false)], size: 1.2 * k, img: c.data.url, ratio: c.data.ratio, sym: 'none' })); setStatus('Image posée : outil Saisir pour la placer.'); break }
        case 'autosave': autosave(); break
        case 'load': { pushHistory(); const ls: Layer[] = Array.isArray(c.data.layers) && c.data.layers.length ? c.data.layers : p.layers, ids = new Set(ls.map((l) => l.id))
          restore(JSON.stringify((c.data.objs as Obj[]).map((o) => (ids.has(o.layer) ? o : { ...o, layer: ls[0].id })))); if (Array.isArray(c.data.layers) && c.data.layers.length) { setLayers(c.data.layers); setActiveLayer(c.data.layers[0].id) } setStatus(`Projet chargé : ${objs.length} objets.`); break }
        case 'save': download(new Blob([JSON.stringify({ app: 'digiart-esquisse-spatiale', version: 1, objs, layers: p.layers })], { type: 'application/json' }), `esquisse-${Date.now()}.json`); break
        case 'export': {
          const root = bakeForExport(visibleObjs()); if (!root.children.length) { setStatus('Rien à exporter.'); break }
          const done = () => root.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose(); (m.material as THREE.Material | undefined)?.dispose() })
          if (c.data === 'stl') { download(new Blob([new STLExporter().parse(root, { binary: true }) as unknown as BlobPart], { type: 'model/stl' }), `esquisse-${Date.now()}.stl`); done() }
          else if (c.data === 'obj') { download(new Blob([new OBJExporter().parse(root)], { type: 'text/plain' }), `esquisse-${Date.now()}.obj`); done() }
          else new GLTFExporter().parse(root, (res) => { download(new Blob([res as ArrayBuffer], { type: 'model/gltf-binary' }), `esquisse-${Date.now()}.glb`); done() }, (e) => { setStatus(`Export GLB impossible : ${(e as any)?.message ?? e}`); done() }, { binary: true })
          setStatus(`Export .${c.data} : ${root.children.length} maillages.`); break }
      }
    }

    // ───────── boucle ─────────
    let layerSig = ''
    const loop = () => {
      if (!running) return
      const p = paramsRef.current, now = performance.now()
      world.updateMatrixWorld(true); k = 1 / world.scale.x; invWorldQ.copy(world.quaternion).invert()
      for (const c of cmdRef.current.splice(0)) run(c, p)

      // calques : visibilité, et retrait des objets d'un calque supprimé
      const sig = p.layers.map((l) => `${l.id}${l.visible ? 1 : 0}`).join('|')
      if (sig !== layerSig) { layerSig = sig; const dead = objs.filter((o) => !layerOf(o.layer)); dead.forEach((o) => remove(o.id)); if (dead.length) autosave() }
      for (const o of objs) { const n = nodes.get(o.id); if (n) n.visible = !!layerOf(o.layer)?.visible }

      const res = p.handsOn ? pollHands(video, landmarker, clock) : null   // Leap Motion s'il est connecté, sinon caméra
      if (res) readHands(res, p, now)
      for (let i = 0; i < 2; i++) if (slots[i].has && now - slots[i].seen > 350) { slots[i].has = false; slots[i].pinch = false; slots[i].fist = 0; slots[i].open = 0; slots[i].fresh = true; slots[i].lm = [] }
      if (drag === 'draw') pointAt(slots[2].ndc, mouseDepth, slots[2].p)

      if (viewGoal) {   // glisser vers une vue mémorisée
        world.position.lerp(tmp.fromArray(viewGoal.pos), 0.14); world.quaternion.slerp(new THREE.Quaternion().fromArray(viewGoal.quat), 0.14); world.scale.setScalar(world.scale.x + (viewGoal.scale - world.scale.x) * 0.14)
        if (world.position.distanceTo(tmp) < 0.002 && Math.abs(world.scale.x - viewGoal.scale) < 0.002) viewGoal = null
        world.updateMatrixWorld(true)
      }
      navigate()
      palette()

      // de la pince au relâchement
      if (act) { const s = slots[act.slot]; if (s.has && s.pinch) update(p); else end() }
      else for (let i = 0; i < 3; i++) { const s = slots[i]; if (s.has && s.pinch && !s.was && !suppress[i] && !(menu && menu.slot === i)) { begin(i, p); if (act) break } }
      for (let i = 0; i < 3; i++) { const s = slots[i]; if (!s.pinch) suppress[i] = false; s.was = s.pinch }

      // repères
      grid.visible = p.showGrid; mirrorPlane.visible = p.sym === 'mirror'
      axisLine.visible = p.tool === 'revolve' || p.sym === 'radial'
      const ao: P3 = p.tool === 'revolve' ? axisO : [0, 0, 0]
      if (axisLine.visible) setLine(axisLine, tmp.set(ao[0], -1.6, ao[2]).clone(), new THREE.Vector3(ao[0], 2.6, ao[2]))
      const r = Math.max(0.012, p.size * 0.004)
      let lead: Slot | null = null
      slots.forEach((s, i) => {
        const c = cursors[i]; c.visible = s.has && (i < 2 || drag === 'draw')
        if (!c.visible) return
        if (!lead) lead = s
        c.position.copy(s.p); c.scale.setScalar(s.fist >= 2 ? 0.05 : r)
        ;(c.material as THREE.MeshBasicMaterial).color.set(s.fist >= 2 ? '#ffffff' : p.tool === 'erase' ? '#ff5050' : p.color)
        ;(c.material as THREE.MeshBasicMaterial).opacity = s.pinch ? 0.95 : 0.45
      })
      dropLine.visible = !!lead && p.showGrid
      if (lead) { const q = world.worldToLocal((lead as Slot).p.clone()); setLine(dropLine, q, new THREE.Vector3(q.x, -1.6, q.z)) }
      handles.children.forEach((h) => h.scale.setScalar(0.028 * k))

      renderer.render(scene, camera)

      // surimpression 2D : squelettes, curseurs, palette
      octx.clearRect(0, 0, overlay.width, overlay.height)
      for (let i = 0; i < 2; i++) {
        const s = slots[i]; if (!s.has) continue
        if (p.showHands && s.lm.length) {
          octx.lineWidth = 2.5; octx.strokeStyle = act?.slot === i ? 'rgba(255,170,60,0.85)' : 'rgba(255,255,255,0.55)'
          for (const ch of FINGER_CHAINS) { octx.beginPath(); ch.forEach((ci, n) => { const pt = s.lm[ci]; if (n === 0) octx.moveTo(pt.x, pt.y); else octx.lineTo(pt.x, pt.y) }); octx.stroke() }
        }
        octx.beginPath(); octx.arc(s.scr.x, s.scr.y, s.pinch ? 9 : 14, 0, Math.PI * 2); octx.lineWidth = 3
        octx.strokeStyle = s.fist >= 2 ? '#ffffff' : p.color; octx.stroke()
        if (s.pinch) { octx.fillStyle = p.color; octx.fill() }
        if (s.fist >= 2) { octx.font = '600 13px system-ui'; octx.fillStyle = '#fff'; octx.textAlign = 'center'; octx.fillText('monde', s.scr.x, s.scr.y - 22) }
      }
      if (menu) {
        const c = slots[menu.slot].palmScr
        TOOLS.forEach((t, j) => {
          const q = menuItem(c, j), hot = j === menu!.hover, cur = t.id === p.tool
          octx.beginPath(); octx.arc(q.x, q.y, hot ? 36 : 30, 0, Math.PI * 2)
          octx.fillStyle = hot ? 'rgba(0,240,255,0.9)' : cur ? 'rgba(255,210,0,0.85)' : 'rgba(10,12,18,0.82)'; octx.fill()
          octx.lineWidth = 2; octx.strokeStyle = 'rgba(255,255,255,0.7)'; octx.stroke()
          octx.textAlign = 'center'; octx.font = '22px system-ui'; octx.fillStyle = '#fff'; octx.fillText(t.icon, q.x, q.y + 4)
          octx.font = '600 11px system-ui'; octx.fillStyle = hot || cur ? '#000' : '#fff'; octx.fillText(t.label, q.x, q.y + 21)
        })
      }
      rafId = requestAnimationFrame(loop)
    }

    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement; if (t && /INPUT|SELECT|TEXTAREA/.test(t.tagName)) return
      const z = e.key.toLowerCase()
      if ((e.ctrlKey || e.metaKey) && z === 'z') { e.preventDefault(); send(e.shiftKey ? 'redo' : 'undo') }
      else if ((e.ctrlKey || e.metaKey) && z === 'y') { e.preventDefault(); send('redo') }
      else if (e.key === 'Delete' || e.key === 'Backspace') send('delete')
      else if (e.key === 'Escape') { if (act) { act = null; draft = null; showDraft() } setRail(null); select(null) }
      else if (/^[1-8]$/.test(e.key)) setTool(TOOLS[+e.key - 1].id)
      else if (e.key === ' ' && !(t && t.tagName === 'BUTTON')) { e.preventDefault(); setHandsOn((v) => !v) }
    }
    window.addEventListener('keydown', onKey)

    if (import.meta.env.DEV) (window as any).__spatial = { world, slots }   // pour les essais automatisés
    const init = async () => {
      syncAll(); loop()   // la scène tourne tout de suite : souris et Leap Motion n'attendent pas la caméra
      setStatus('Prêt à la souris. Caméra en cours de démarrage…')
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false }).catch(() => navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false }))
        if (!running) { stream.getTracks().forEach((t) => t.stop()); return }
        video.srcObject = stream; await new Promise<void>((res) => { video.onloadedmetadata = () => res() }); await video.play()
        const files = await FilesetResolver.forVisionTasks(WASM_BASE)
        landmarker = await GestureRecognizer.createFromOptions(files, { baseOptions: { modelAssetPath: GESTURE_MODEL_URL, delegate: 'GPU' }, runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.45, minHandPresenceConfidence: 0.3, minTrackingConfidence: 0.3 })
        setStatus('Prêt : pince pour dessiner, ferme le poing pour attraper le monde ✦')
      } catch (e: any) { setError(`Caméra ou modèle indisponible (${e?.message ?? e}). Le Leap Motion et la souris restent utilisables.`) }
    }
    init()

    return () => {
      running = false; if (rafId) cancelAnimationFrame(rafId)
      window.removeEventListener('resize', resize); window.removeEventListener('keydown', onKey)
      el.removeEventListener('pointerdown', onDown); el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerup', onUp); el.removeEventListener('pointercancel', onUp)
      el.removeEventListener('wheel', onWheel); el.removeEventListener('contextmenu', noMenu)
      try { landmarker?.close() } catch { /* noop */ }
      if (stream) stream.getTracks().forEach((t) => t.stop()); video.srcObject = null
      nodes.forEach(disposeNode); if (draftNode) disposeNode(draftNode); if (railNode) disposeNode(railNode)
      cursorGeo.dispose(); handleGeo.dispose(); handleMat.dispose(); railMat.dispose(); envTex.dispose(); pmrem.dispose()
      renderer.dispose(); if (el.parentElement === mount) mount.removeChild(el)
    }
  }, [])

  const exportPng = () => {
    const three = mountRef.current?.querySelector('canvas') as HTMLCanvasElement | null; if (!three) return
    const out = document.createElement('canvas'); out.width = three.width; out.height = three.height; const c = out.getContext('2d')!
    if (bg === 'webcam' && videoRef.current && videoRef.current.readyState >= 2) { c.save(); c.translate(out.width, 0); c.scale(-1, 1); c.drawImage(videoRef.current, 0, 0, out.width, out.height); c.restore() }
    else { c.fillStyle = bg === 'studio' ? '#cfd6dd' : '#07080d'; c.fillRect(0, 0, out.width, out.height) }
    c.drawImage(three, 0, 0, out.width, out.height)
    out.toBlob((b) => { if (!b) return; const url = URL.createObjectURL(b); const a = document.createElement('a'); a.href = url; a.download = `esquisse-${Date.now()}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1500) }, 'image/png')
  }
  const onProject = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; e.target.value = ''; if (!f) return
    f.text().then((t) => { const d = JSON.parse(t); if (!Array.isArray(d.objs)) throw new Error('pas de liste d\'objets'); send('load', d) }).catch((err) => setError(`Fichier de projet illisible : ${err?.message ?? err}`))
  }
  const onImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; e.target.value = ''; if (!f) return
    const img = new Image(), src = URL.createObjectURL(f)
    img.onload = () => {   // réduite à 1024 px : l'image voyage dans la sauvegarde du projet
      const s = Math.min(1, 1024 / Math.max(img.width, img.height)), c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s)
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(src)
      send('image', { url: c.toDataURL('image/jpeg', 0.85), ratio: c.height / c.width })
    }
    img.onerror = () => { URL.revokeObjectURL(src); setError('Image illisible.') }
    img.src = src
  }

  const hint = TOOLS.find((t) => t.id === tool)?.hint ?? ''
  const creating = tool === 'stroke' || tool === 'revolve' || tool === 'surface' || tool === 'prim'
  return (
    <div style={{ position: 'fixed', inset: 0, background: bg === 'studio' ? 'linear-gradient(#e6ebf0, #aab4bf)' : '#07080d', overflow: 'hidden', userSelect: 'none', fontFamily: 'system-ui' }}>
      <video ref={videoRef} autoPlay playsInline muted style={{ position: 'absolute', inset: 0, width: '100vw', height: '100vh', objectFit: 'cover', transform: 'scaleX(-1)', zIndex: 1, opacity: bg === 'webcam' ? 1 : 0 }} />
      <div ref={mountRef} style={{ position: 'absolute', inset: 0, zIndex: 3 }} />
      <canvas ref={overlayRef} style={{ position: 'absolute', inset: 0, width: '100vw', height: '100vh', zIndex: 4, pointerEvents: 'none' }} />

      {/* barre d'outils : toujours visible, atteignable au clavier (1 à 8) */}
      <div role="toolbar" aria-label="Outils" style={{ position: 'absolute', bottom: 14, left: '50%', transform: 'translateX(-50%)', zIndex: 10, display: 'flex', gap: 6, padding: 6, borderRadius: 14, background: 'rgba(10,12,18,0.82)', border: '1px solid rgba(255,255,255,0.15)', backdropFilter: 'blur(10px)', maxWidth: 'calc(100vw - 24px)', overflowX: 'auto' }}>
        {TOOLS.map((t, i) => (
          <button key={t.id} onClick={() => setTool(t.id)} aria-pressed={tool === t.id} title={`${t.label} (${i + 1}) — ${t.hint}`} style={{ minWidth: 58, flexShrink: 0, padding: '6px 4px', borderRadius: 10, cursor: 'pointer', border: `1px solid ${tool === t.id ? '#00f0ff' : 'transparent'}`, background: tool === t.id ? 'rgba(0,240,255,0.22)' : 'transparent', color: '#fff', fontSize: 11, fontWeight: 600 }}>
            <div style={{ fontSize: 20, lineHeight: 1.2 }}>{t.icon}</div>{t.label}
          </button>
        ))}
        <span style={{ width: 1, background: 'rgba(255,255,255,0.2)', margin: '4px 2px' }} />
        <button onClick={() => setHandsOn((v) => !v)} aria-pressed={handsOn} title="Suivi des mains (barre d'espace) : mets-le en pause quand tu utilises le clavier ou la souris" style={{ ...barBtn, fontSize: 11, fontWeight: 600, minWidth: 58, padding: '6px 4px', border: `1px solid ${handsOn ? 'transparent' : '#ffd200'}`, color: handsOn ? '#fff' : '#ffd200' }}><div style={{ fontSize: 20, lineHeight: 1.2 }}>{handsOn ? '✋' : '⏸'}</div>{handsOn ? 'Mains' : 'En pause'}</button>
        <button onClick={() => send('undo')} title="Annuler (Ctrl+Z)" style={barBtn}>↶</button>
        <button onClick={() => send('redo')} title="Refaire (Ctrl+Y)" style={barBtn}>↷</button>
      </div>

      {!panelOpen && <button onClick={() => setPanelOpen(true)} aria-label="Ouvrir le panneau" style={{ position: 'absolute', top: 16, left: 16, zIndex: 11, ...sel, width: 'auto', padding: '8px 12px' }}>☰</button>}
      {panelOpen && (
        <div style={{ position: 'absolute', top: 16, left: 16, zIndex: 10, width: 300, maxWidth: 'calc(100vw - 32px)', boxSizing: 'border-box', background: 'rgba(10,10,15,0.86)', padding: 16, borderRadius: 16, backdropFilter: 'blur(10px)', border: '1px solid rgba(255,255,255,0.15)', boxShadow: '0 10px 30px rgba(0,0,0,0.5)', maxHeight: 'calc(100vh - 110px)', overflowY: 'auto', color: '#ccc' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <strong style={{ color: '#00f0ff', textTransform: 'uppercase', letterSpacing: 1, fontSize: 14 }}>Esquisse spatiale</strong>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Link to="/" style={{ color: '#aaa', fontSize: 12, textDecoration: 'none' }}>← Studio</Link><button onClick={() => setPanelOpen(false)} aria-label="Replier le panneau" style={{ background: 'transparent', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: 16 }}>«</button></div>
          </div>
          <div role="status" style={{ color: error ? '#ff6b6b' : '#8d8d99', fontSize: 11, marginBottom: 8, lineHeight: 1.35 }}>{error ?? status}</div>
          <div style={{ fontSize: 11, color: '#ffd200', marginBottom: 10, lineHeight: 1.4, background: 'rgba(255,210,0,0.08)', padding: 8, borderRadius: 6 }}>
            <b>{TOOLS.find((t) => t.id === tool)?.label}</b> — {hint}<br />
            ✊ <b>Poing</b> : attraper le monde (deux poings : tourner et zoomer). 🖐 <b>Paume ouverte</b> de l'autre main : palette d'outils.<br />
            🖱️ Souris : glisser = pince · clic droit = tourner · molette = zoom · Maj + molette = profondeur.
          </div>

          <LeapToggle />

          {creating && <>
            {tool === 'stroke' && <Field label="Section du trait"><select value={section} onChange={(e) => setSection(e.target.value as Section)} style={sel}><option value="round">Tube rond</option><option value="ribbon">Ruban plat (suit la paume)</option><option value="square">Barre carrée</option></select></Field>}
            {tool === 'stroke' && <Field label={`Épaisseur — ${size}`}><input type="range" min={1} max={40} value={size} onChange={(e) => setSize(+e.target.value)} style={rng} /></Field>}
            {tool === 'stroke' && <Field label={`Effilage des bouts — ${Math.round(taper * 100)} %`}><input type="range" min={0} max={1} step={0.05} value={taper} onChange={(e) => setTaper(+e.target.value)} style={rng} /></Field>}
            {tool === 'stroke' && <label style={chk}><input type="checkbox" checked={straight} onChange={(e) => setStraight(e.target.checked)} /> Trait droit (du départ à l'arrivée)</label>}
            {tool === 'prim' && <Field label="Volume"><select value={prim} onChange={(e) => setPrim(e.target.value as Prim)} style={sel}>{PRIMS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></Field>}
            {tool === 'revolve' && <>
              <Field label={`Côtés — ${sides}${sides <= 8 ? ' (facetté)' : ''}`}><input type="range" min={3} max={96} value={sides} onChange={(e) => setSides(+e.target.value)} style={rng} /></Field>
              <Field label={`Angle balayé — ${sweepDeg}°`}><input type="range" min={30} max={360} step={15} value={sweepDeg} onChange={(e) => setSweepDeg(+e.target.value)} style={rng} /></Field>
              <button onClick={() => send('axis')} style={{ ...sel, marginBottom: 12 }}>Remettre l'axe au centre</button>
            </>}
          </>}
          {tool === 'grab' && <label style={chk}><input type="checkbox" checked={duplicate} onChange={(e) => setDuplicate(e.target.checked)} /> Dupliquer en saisissant</label>}
          {tool === 'edit' && <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
            <button onClick={() => send('apply')} disabled={!selected} style={{ ...sel, flex: 2, opacity: selected ? 1 : 0.4 }}>Appliquer les réglages</button>
            <button onClick={() => send('delete')} disabled={!selected} style={{ ...sel, flex: 1, opacity: selected ? 1 : 0.4, background: 'rgba(255,40,100,0.2)' }}>Supprimer</button>
          </div>}

          <Title>Couleur</Title>
            <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
              {SWATCHES.map((c) => <button key={c} onClick={() => setColor(c)} aria-label={`Couleur ${c}`} aria-pressed={color === c} style={{ width: 24, height: 24, borderRadius: 12, background: c, cursor: 'pointer', border: color === c ? '2px solid #fff' : '1px solid rgba(255,255,255,0.3)' }} />)}
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Autre couleur" style={{ width: 30, height: 26, border: 'none', background: 'none', cursor: 'pointer', padding: 0 }} />
            </div>
          <Field label="Matière"><select value={mat} onChange={(e) => setMat(e.target.value as Mat)} style={sel}>{MATS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select></Field>

          <Field label="Symétrie"><select value={sym} onChange={(e) => setSym(e.target.value as Sym)} style={sel}><option value="none">Aucune</option><option value="mirror">Miroir (plan rose)</option><option value="radial">Radiale autour de l'axe vertical</option></select></Field>
          {sym === 'radial' && <Field label={`Répétitions — ${symN}`}><input type="range" min={2} max={24} value={symN} onChange={(e) => setSymN(+e.target.value)} style={rng} /></Field>}
          <label style={chk}><input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} /> Aimanter à la grille</label>
          {snap && <Field label={`Pas de la grille — ${snapStep}`}><input type="range" min={0.05} max={0.5} step={0.05} value={snapStep} onChange={(e) => setSnapStep(+e.target.value)} style={rng} /></Field>}
          <Field label={`Profondeur de la main — ×${depthGain.toFixed(1)}${depthGain === 0 ? ' (à plat)' : ''}`}><input type="range" min={0} max={2.5} step={0.1} value={depthGain} onChange={(e) => setDepthGain(+e.target.value)} style={rng} /></Field>

          <Title>Calques</Title>
          {layers.map((l) => (
            <div key={l.id} onClick={() => setActiveLayer(l.id)} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 6px', marginBottom: 4, borderRadius: 6, cursor: 'pointer', border: `1px solid ${activeLayer === l.id ? '#00f0ff' : 'rgba(255,255,255,0.15)'}`, background: activeLayer === l.id ? 'rgba(0,240,255,0.12)' : 'transparent' }}>
              <button onClick={(e) => { e.stopPropagation(); setLayers((ls) => ls.map((x) => x.id === l.id ? { ...x, visible: !x.visible } : x)) }} aria-label={l.visible ? 'Masquer le calque' : 'Afficher le calque'} style={ico}>{l.visible ? '👁' : '🚫'}</button>
              <button onClick={(e) => { e.stopPropagation(); setLayers((ls) => ls.map((x) => x.id === l.id ? { ...x, locked: !x.locked } : x)) }} aria-label={l.locked ? 'Déverrouiller le calque' : 'Verrouiller le calque'} style={ico}>{l.locked ? '🔒' : '🔓'}</button>
              <input value={l.name} onChange={(e) => setLayers((ls) => ls.map((x) => x.id === l.id ? { ...x, name: e.target.value } : x))} aria-label="Nom du calque" style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', color: '#ddd', fontSize: 12 }} />
              {layers.length > 1 && <button onClick={(e) => { e.stopPropagation(); if (!window.confirm(`Supprimer « ${l.name} » et tout ce qu'il contient ?`)) return; setLayers((ls) => { const nx = ls.filter((x) => x.id !== l.id); if (activeLayer === l.id) setActiveLayer(nx[0].id); return nx }) }} aria-label="Supprimer le calque" style={{ ...ico, color: '#ff6b6b' }}>🗑</button>}
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
            <button onClick={() => { const id = `L${Date.now()}`; setLayers((ls) => [...ls, { id, name: `Calque ${ls.length + 1}`, visible: true, locked: false }]); setActiveLayer(id) }} style={{ ...sel, flex: 1 }}>+ Calque</button>
            <button onClick={() => send('clear')} style={{ ...sel, flex: 1, background: 'rgba(255,40,100,0.2)' }} title="Efface les objets du calque actif (annulable)">Vider</button>
          </div>

          <Title>Vues</Title>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 12 }}>
            <button onClick={() => send('recenter')} style={{ ...sel, width: 'auto', padding: '5px 9px', fontSize: 12 }}>⊙ Centre</button>
            {views.map((v, i) => <span key={v.id} style={{ display: 'inline-flex' }}><button onClick={() => send('view:go', v.id)} style={{ ...sel, width: 'auto', padding: '5px 9px', fontSize: 12, borderRadius: '6px 0 0 6px' }}>Vue {i + 1}</button><button onClick={() => setViews((vs) => vs.filter((x) => x.id !== v.id))} aria-label={`Oublier la vue ${i + 1}`} style={{ ...sel, width: 'auto', padding: '5px 7px', fontSize: 12, borderRadius: '0 6px 6px 0', color: '#ff6b6b' }}>✕</button></span>)}
            <button onClick={() => send('view:add')} style={{ ...sel, width: 'auto', padding: '5px 9px', fontSize: 12 }}>＋ Mémoriser</button>
          </div>

          <Title>Affichage</Title>
          <Field label="Fond"><select value={bg} onChange={(e) => setBg(e.target.value as Bg)} style={sel}><option value="webcam">Caméra (réalité augmentée)</option><option value="dark">Noir</option><option value="studio">Studio clair</option></select></Field>
          <label style={chk}><input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} /> Sol quadrillé et fil d'aplomb</label>
          <label style={chk}><input type="checkbox" checked={showHands} onChange={(e) => setShowHands(e.target.checked)} /> Squelette des mains</label>
          <button onClick={() => imgRef.current?.click()} style={{ ...sel, margin: '6px 0 12px' }}>Poser une image de référence</button>
          <input ref={imgRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onImage} />

          <Title>Projet ({count} objets)</Title>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}><button onClick={() => send('save')} style={{ ...sel, flex: 1 }}>Enregistrer</button><button onClick={() => fileRef.current?.click()} style={{ ...sel, flex: 1 }}>Ouvrir</button></div>
          <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={onProject} />
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={exportPng} style={{ ...sel, flex: 1 }}>PNG</button>
            <button onClick={() => send('export', 'glb')} style={{ ...sel, flex: 1 }}>.glb</button>
            <button onClick={() => send('export', 'obj')} style={{ ...sel, flex: 1 }}>.obj</button>
            <button onClick={() => send('export', 'stl')} style={{ ...sel, flex: 1 }} title="Pour l'impression 3D">.stl</button>
          </div>
          <p style={{ color: '#777', fontSize: 10, margin: '10px 0 0', lineHeight: 1.4 }}>Le projet se sauvegarde tout seul dans ce navigateur. « Enregistrer » en fait un fichier à rouvrir ailleurs.</p>
        </div>
      )}
    </div>
  )
}

const sel: React.CSSProperties = { width: '100%', boxSizing: 'border-box', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', color: 'white', padding: 8, borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: 13 }
const barBtn: React.CSSProperties = { minWidth: 40, flexShrink: 0, borderRadius: 10, cursor: 'pointer', border: '1px solid transparent', background: 'transparent', color: '#fff', fontSize: 20 }
const ico: React.CSSProperties = { background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 13, padding: 2 }
const rng: React.CSSProperties = { width: '100%', accentColor: '#00f0ff' }
const chk: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: '#ccc', margin: '6px 0 10px', cursor: 'pointer' }
function Title({ children }: { children: React.ReactNode }) { return <div style={{ fontSize: 10, color: '#00f0ff', textTransform: 'uppercase', letterSpacing: 1, margin: '6px 0 6px' }}>{children}</div> }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return (<label style={{ display: 'block', marginBottom: 12 }}><div style={{ fontSize: 11, color: '#00f0ff', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5 }}>{label}</div>{children}</label>) }
