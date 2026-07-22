/**
 * Studio de Sculpture — pâte à modeler virtuelle + métamorphose (webcam + MediaPipe).
 *
 * DEUX TEMPS.
 * 1) SCULPTER : une boule de pâte déformable (icosphère). Les doigts sont des outils qui
 *    déforment directement le maillage — Étirer (tirer la matière), Pousser (creuser),
 *    Pincer (crête/pointe), Gonfler, Lisser. Pince pouce+index = presser ; symétrie
 *    bilatérale optionnelle. C'est du vrai modelage : on tire des pointes, on creuse, on lisse.
 * 2) MÉTAMORPHOSER : la forme sculptée devient le "holon" d'un système de métamorphoses
 *    itérées façon XenoDream — symétrie radiale N, miroir, torsion, réplication fractale —
 *    piloté aux mains (écartement/hauteur/inclinaison/pince) ou aux curseurs.
 *
 * Export .glb/.stl (impression 3D), PNG, vidéo WebM.
 * Studio autonome. Route /sculpt, protégée par FrontGate.
 */
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import * as THREE from 'three'
import { FilesetResolver, GestureRecognizer } from '@mediapipe/tasks-vision'
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { ORG_DEFAULTS, ORG_FORMS, ORG_PORES, ORG_PRESETS, type OrganicParams, type OrgForm, type OrgPore } from './organic'
import { textToOrganic, sanitiseOrganic, organicApiError, ORG_AI_HINTS } from './organicAI'
import { importFile, geomToData, type MeshData } from '../morpho/imports'

const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
const GESTURE_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task'
const TIP_THUMB = 4, TIP_INDEX = 8, MID_MCP = 9, WRIST = 0
const FINGER_CHAINS = [[0, 1, 2, 3, 4], [0, 5, 6, 7, 8], [0, 9, 10, 11, 12], [0, 13, 14, 15, 16], [0, 17, 18, 19, 20]]
const clamp = (a: number, b: number, v: number) => Math.max(a, Math.min(b, v))
const SUBDIV = 14         // icosphere detail → ~2300 welded verts (sculptable)
const MCAP = 800          // metamorphose instance cap

type Tool = 'grab' | 'push' | 'pinch' | 'inflate' | 'smooth' | 'stipple' | 'cells' | 'groove'
const FORM_TOOLS: Tool[] = ['grab', 'push', 'pinch', 'inflate', 'smooth']
const TEX_TOOLS: Tool[] = ['stipple', 'cells', 'groove']
const isTex = (t: Tool) => TEX_TOOLS.includes(t)
const TOOLS: { kind: Tool; label: string; hint: string }[] = [
  { kind: 'grab', label: '✊ Étirer', hint: 'Attrape et tire la matière avec le doigt (fais des pointes, des bras).' },
  { kind: 'push', label: '👇 Pousser', hint: 'Enfonce la surface vers l\'intérieur (creuse, aplatit).' },
  { kind: 'pinch', label: '🤏 Pincer', hint: 'Ramène la matière vers un point (crêtes, pointes fines).' },
  { kind: 'inflate', label: '🎈 Gonfler', hint: 'Repousse la surface vers l\'extérieur (bosses, renflements).' },
  { kind: 'smooth', label: '🧽 Lisser', hint: 'Adoucit et égalise la surface.' },
  { kind: 'stipple', label: '⋮⋮ Pointiller', hint: 'Grave une pluie de petits points dans la surface (texture pointillée).' },
  { kind: 'cells', label: '🪨 Cellules', hint: 'Creuse des alvéoles organiques (comme des galets/cellules).' },
  { kind: 'groove', label: '〰 Strier', hint: 'Grave des rainures/lignes en suivant le doigt.' },
]
type MorphStyle = 'fractal' | 'grid' | 'radial' | 'spiral'
const MORPH_STYLES: { kind: MorphStyle; label: string }[] = [
  { kind: 'fractal', label: '🧬 Fractal (itéré)' }, { kind: 'grid', label: '🧱 Grille / blocs 3D' },
  { kind: 'radial', label: '🌸 Radial (couronne)' }, { kind: 'spiral', label: '🌀 Spirale' },
]
/** Hash → 0..1 for the procedural noises. */
function h01(i: number, j: number, k: number): number { let h = (i * 374761393 + j * 668265263 + k * 1274126177) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967296 }
/** Trilinear 3D value noise → [-1,1]. */
function noise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), xf = x - xi, yf = y - yi, zf = z - zi
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf)
  const lp = (a: number, b: number, t: number) => a + (b - a) * t, c = (dx: number, dy: number, dz: number) => h01(xi + dx, yi + dy, zi + dz) * 2 - 1
  const x00 = lp(c(0, 0, 0), c(1, 0, 0), u), x10 = lp(c(0, 1, 0), c(1, 1, 0), u), x01 = lp(c(0, 0, 1), c(1, 0, 1), u), x11 = lp(c(0, 1, 1), c(1, 1, 1), u)
  return lp(lp(x00, x10, v), lp(x01, x11, v), w)
}
/** Cellular / Worley F1 distance → 0..1 (voronoi bumps). */
function cellular3(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z); let md = 9
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
    const cx = xi + dx, cy = yi + dy, cz = zi + dz
    const fx = cx + h01(cx, cy, cz), fy = cy + h01(cy, cz, cx), fz = cz + h01(cz, cx, cy)
    const ex = fx - x, ey = fy - y, ez = fz - z, d = ex * ex + ey * ey + ez * ez; if (d < md) md = d
  }
  return Math.min(1, Math.sqrt(md))
}
type NoiseType = 'value' | 'fbm' | 'ridged' | 'turbulence' | 'cellular'
const NOISE_TYPES: { kind: NoiseType; label: string }[] = [
  { kind: 'value', label: '🌫 Doux (value)' }, { kind: 'fbm', label: '🏔 Fractal (fBm)' }, { kind: 'ridged', label: '⛰ Crêtes (ridged)' },
  { kind: 'turbulence', label: '🌊 Turbulence' }, { kind: 'cellular', label: '🪨 Cellulaire (voronoï)' },
]
/** Generative noise field → [-1,1], selectable type. */
function noiseField(type: NoiseType, x: number, y: number, z: number): number {
  if (type === 'fbm') { let a = 0.5, f = 1, s = 0; for (let i = 0; i < 4; i++) { s += a * noise3(x * f, y * f, z * f); f *= 2; a *= 0.5 } return Math.max(-1, Math.min(1, s * 1.3)) }
  if (type === 'ridged') { let a = 0.5, f = 1, s = 0; for (let i = 0; i < 4; i++) { s += a * (1 - 2 * Math.abs(noise3(x * f, y * f, z * f))); f *= 2; a *= 0.5 } return Math.max(-1, Math.min(1, s)) }
  if (type === 'turbulence') { let a = 0.5, f = 1, s = 0; for (let i = 0; i < 4; i++) { s += a * Math.abs(noise3(x * f, y * f, z * f)); f *= 2; a *= 0.5 } return Math.max(-1, Math.min(1, s * 2 - 0.6)) }
  if (type === 'cellular') return Math.max(-1, Math.min(1, cellular3(x, y, z) * 2 - 1))
  return noise3(x, y, z)
}
type SurfPattern = 'none' | 'cells' | 'stipple' | 'scales' | 'ridges'
const SURF_PATTERNS: { kind: SurfPattern; label: string }[] = [
  { kind: 'none', label: 'Aucune (lisse)' }, { kind: 'cells', label: '🪨 Cellules (voronoï)' }, { kind: 'stipple', label: '⋮⋮ Pointillé' },
  { kind: 'scales', label: '🐟 Écailles' }, { kind: 'ridges', label: '〰 Stries' },
]
type MatKind = 'clay' | 'chrome' | 'bio' | 'matte'
const MATERIALS: { kind: MatKind; label: string; metal: number; rough: number }[] = [
  { kind: 'clay', label: '🟫 Pâte / terre', metal: 0.0, rough: 0.85 }, { kind: 'chrome', label: '🪞 Chrome', metal: 0.95, rough: 0.15 },
  { kind: 'bio', label: '🫧 Bio-plastique', metal: 0.3, rough: 0.35 }, { kind: 'matte', label: '⚪ Mat', metal: 0.05, rough: 0.6 },
]

/** IFS growth of the metamorph transform tree. */
function grow(maps: THREE.Matrix4[], depth: number, maxNodes: number): { mat: THREE.Matrix4; d: number }[] {
  let cur = [{ mat: new THREE.Matrix4(), d: 0 }]
  const all = [...cur]
  for (let d = 0; d < depth; d++) {
    const next: { mat: THREE.Matrix4; d: number }[] = []
    for (const node of cur) { for (const map of maps) { next.push({ mat: new THREE.Matrix4().multiplyMatrices(node.mat, map), d: d + 1 }); if (all.length + next.length >= maxNodes) break } if (all.length + next.length >= maxNodes) break }
    all.push(...next); cur = next
    if (all.length >= maxNodes || !next.length) break
  }
  return all
}

export function SculptStudio() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const mountRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)

  const [mode, setMode] = useState<'sculpt' | 'morph' | 'organic'>('sculpt')
  const [org, setOrg] = useState<OrganicParams>(ORG_DEFAULTS)
  const [orgSmooth, setOrgSmooth] = useState(1)
  const [orgTris, setOrgTris] = useState(0)
  const [orgBusy, setOrgBusy] = useState(false)
  const [orgProgress, setOrgProgress] = useState(0)
  const [handsPaused, setHandsPaused] = useState(false)   // fige le pilotage/sculpture aux mains
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiNote, setAiNote] = useState('')
  const adoptRef = useRef(false)                          // « Sculpter cette forme » : adopte le maillage généré
  // Corps source pour le mode « Ma forme » : maillage sculpté capturé ou fichier importé.
  const orgSourceRef = useRef<MeshData | null>(null)
  const captureRef = useRef(false)                        // capture la pâte courante comme corps source
  const [orgSourceName, setOrgSourceName] = useState('')
  const [orgSourceVer, setOrgSourceVer] = useState(0)     // change ⇒ régénère

  const onImport = async (f: File | null) => {
    if (!f) return
    setStatus(`Import de ${f.name}…`)
    try {
      const { data, name, tris } = await importFile(f)
      orgSourceRef.current = data
      setOrgSourceName(`${name} · ${tris.toLocaleString('fr-FR')} tri`)
      setOrgSourceVer((v) => v + 1)
      setOrg((o) => ({ ...o, form: 'mesh' })); setMode('organic')
      setStatus(`${name} importé — traité en organique paramétrique.`)
    } catch (e) { setStatus(`Import impossible : ${(e as Error).message}`) }
  }
  const setOrgP = <K extends keyof OrganicParams>(k: K, v: OrganicParams[K]) => setOrg((o) => ({ ...o, [k]: v }))

  /** Décrire → paramètres. Tente le vrai modèle, retombe sur l'interprète local (toujours
   *  disponible : pas de clé, pas de réseau) pour que le bouton ne soit jamais mort. */
  const runAI = async (prompt: string) => {
    setAiBusy(true); setAiNote('')
    const local = textToOrganic(prompt, (Date.now() & 0xffff) || 1)
    let why = 'réseau injoignable'
    try {
      const r = await fetch('/api/organic', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt }) })
      if (!r.ok) {
        const body = await r.json().catch(() => ({})) as { error?: string }
        why = organicApiError(r.status, body.error)
        throw new Error(why)
      }
      const d = await r.json() as { explain?: string; params?: unknown }
      const p = sanitiseOrganic(d.params as Partial<OrganicParams>)
      if (!Object.keys(p).length) { why = 'réponse du modèle inexploitable'; throw new Error(why) }
      setOrg((o) => ({ ...o, ...p }))
      setAiNote(`✨ ${d.explain || 'Forme proposée par l\'IA.'}`)
    } catch {
      setOrg((o) => ({ ...o, ...local.params }))
      // Distinguer « j'ai compris ta description » de « je n'ai rien reconnu, voilà du
      // hasard » : présenter du bruit comme une interprétation serait mensonger.
      setAiNote(local.matched
        ? `⚙ IA distante indisponible (${why}) — interprété localement : ${local.explain}`
        : `⚙ IA distante indisponible (${why}), et aucun mot-clé reconnu localement → variation aléatoire. Mots compris : ${ORG_AI_HINTS}`)
    } finally { setAiBusy(false) }
  }
  const [tool, setTool] = useState<Tool>('grab')
  const [brushSize, setBrushSize] = useState(0.35)
  const [strength, setStrength] = useState(0.6)
  const [symX, setSymX] = useState(true)
  const [surfPattern, setSurfPattern] = useState<SurfPattern>('none')
  const [texScale, setTexScale] = useState(0.5)
  const [texDepth, setTexDepth] = useState(0.5)
  // metamorphose params
  const [morphStyle, setMorphStyle] = useState<MorphStyle>('fractal')
  const [depth, setDepth] = useState(1)
  const [radial, setRadial] = useState(5)
  const [gridN, setGridN] = useState(2)
  const [turns, setTurns] = useState(2)
  const [mirror, setMirror] = useState(true)
  const [twist, setTwist] = useState(0.6)
  const [spread, setSpread] = useState(0.5)
  const [childScale, setChildScale] = useState(0.55)
  // generative deformers (applied to the replicated geometry)
  const [defTwist, setDefTwist] = useState(0)
  const [defTaper, setDefTaper] = useState(0)
  const [defNoise, setDefNoise] = useState(0)
  const [noiseScale, setNoiseScale] = useState(3)
  const [noiseType, setNoiseType] = useState<NoiseType>('value')
  const [handDrive, setHandDrive] = useState(true)
  // render
  const [colorA, setColorA] = useState('#c8794a')
  const [colorB, setColorB] = useState('#7a3f2c')
  const [material, setMaterial] = useState<MatKind>('clay')
  const [showSkeleton, setShowSkeleton] = useState(true)
  const [bgMode, setBgMode] = useState<'webcam' | 'black'>('black')
  const [panelOpen, setPanelOpen] = useState(true)
  const [recording, setRecording] = useState(false)
  const [status, setStatus] = useState('Initialisation de la caméra et du modèle…')
  const [error, setError] = useState<string | null>(null)

  const paramsRef = useRef({ handsPaused, mode, tool, brushSize, strength, symX, surfPattern, texScale, texDepth, morphStyle, depth, radial, gridN, turns, mirror, twist, spread, childScale, defTwist, defTaper, defNoise, noiseScale, noiseType, handDrive, colorA, colorB, material, showSkeleton, bgMode })
  paramsRef.current = { handsPaused, mode, tool, brushSize, strength, symX, surfPattern, texScale, texDepth, morphStyle, depth, radial, gridN, turns, mirror, twist, spread, childScale, defTwist, defTaper, defNoise, noiseScale, noiseType, handDrive, colorA, colorB, material, showSkeleton, bgMode }
  const clearTexRef = useRef(false)
  const resetRef = useRef(false), undoRef = useRef(false), redoRef = useRef(false)
  const exportRef = useRef<null | 'stl' | 'glb'>(null)
  const orgGeoRef = useRef<THREE.BufferGeometry | null>(null)   // dernier maillage organique reçu du worker
  const orgDirtyRef = useRef(false)                              // → à brancher sur le mesh dans la boucle
  const recCtl = useRef<{ start: () => void; stop: () => void } | null>(null)

  // ── Organic module : the field is polygonised in a worker (res 64 ≈ 0.5 s, res 128 ≈ 3.4 s
  //    — inline it would stall the render loop). Jobs are numbered so a superseded result
  //    from a slower, older job can never overwrite a newer mesh. ──
  const orgWorkerRef = useRef<Worker | null>(null)
  const orgJobRef = useRef(0)
  useEffect(() => {
    let w: Worker | null = null
    try { w = new Worker(new URL('./organic.worker.ts', import.meta.url), { type: 'module' }) } catch { w = null }
    orgWorkerRef.current = w
    if (w) w.onmessage = (e: MessageEvent<{ id: number; position?: Float32Array; normal?: Float32Array | null; index?: Uint32Array | null; tris?: number; empty?: boolean; error?: string; progress?: number }>) => {
      const d = e.data
      if (d.id !== orgJobRef.current) return                    // périmé : un job plus récent l'a remplacé
      if (typeof d.progress === 'number') { setOrgProgress(d.progress); return }
      setOrgBusy(false); setOrgProgress(100)
      if (d.error) { setStatus(`Génération organique : ${d.error}`); return }
      if (d.empty || !d.position) { setStatus('Forme vide — réduis les perforations ou l\'épaisseur de coque.'); return }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(d.position, 3))
      if (d.normal) g.setAttribute('normal', new THREE.BufferAttribute(d.normal, 3))
      if (d.index) g.setIndex(new THREE.BufferAttribute(d.index, 1))
      if (!d.normal) g.computeVertexNormals()
      orgGeoRef.current = g; orgDirtyRef.current = true
      setOrgTris(d.tris ?? 0)
      setStatus(`Forme organique générée — ${(d.tris ?? 0).toLocaleString('fr-FR')} triangles.`)
    }
    return () => { w?.terminate(); orgWorkerRef.current = null }
  }, [])
  useEffect(() => {
    if (mode !== 'organic') return
    const w = orgWorkerRef.current
    if (!w) { setStatus('Worker indisponible — génération organique impossible.'); return }
    setOrgBusy(true); setOrgProgress(0)
    const t = setTimeout(() => { const id = ++orgJobRef.current; w.postMessage({ id, params: org, smooth: orgSmooth, source: org.form === 'mesh' ? orgSourceRef.current : null }) }, 200)
    return () => clearTimeout(t)
  }, [org, orgSmooth, mode, orgSourceVer])

  useEffect(() => {
    const video = videoRef.current!, mount = mountRef.current!, overlay = overlayRef.current!
    const octx = overlay.getContext('2d')!
    let landmarker: GestureRecognizer | null = null, stream: MediaStream | null = null
    let rafId = 0, running = true, lastVideoTime = -1

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 100)
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true })
    renderer.setClearColor(0x000000, 0); renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    mount.appendChild(renderer.domElement); renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100vw;height:100vh;'
    scene.add(new THREE.HemisphereLight(0xffffff, 0x223044, 0.85))
    const keyL = new THREE.DirectionalLight(0xffffff, 1.15); keyL.position.set(2, 3, 2.5); scene.add(keyL)
    const rimL = new THREE.DirectionalLight(0x88bbff, 0.5); rimL.position.set(-2, 1, -2); scene.add(rimL)

    // ── Deformable clay blob : icosphere WELDED into an indexed geometry (shared vertices)
    // so deforming a vertex moves the whole surface continuously (no cracks). ──
    // The sculptable geometry is SWAPPABLE : it starts as an icosphere, but a form generated
    // by the organic module can be adopted in its place (« Sculpter cette forme »), so the
    // hand/mouse tools work on generated shapes too. installSculptGeo() rebuilds everything
    // that is indexed by vertex (rest pose, UVs, adjacency) for whatever mesh it is handed.
    let geo!: THREE.BufferGeometry, posAttr!: THREE.BufferAttribute, V = 0
    let rest!: Float32Array, adj: number[][] = []
    const installSculptGeo = (src: THREE.BufferGeometry) => {
      const g = src.getIndex() ? src : mergeVertices(src)
      g.computeVertexNormals()
      geo = g
      posAttr = g.getAttribute('position') as THREE.BufferAttribute
      V = posAttr.count
      rest = new Float32Array(posAttr.array as Float32Array)   // pose de repos (pour « remise à zéro »)
      // Equirectangular UV from the rest directions (fixed → the texture sticks to the
      // surface as it's sculpted). Drives the bump map for carved surface texture.
      const uv = new Float32Array(V * 2)
      for (let i = 0; i < V; i++) { const x = rest[i * 3], y = rest[i * 3 + 1], z = rest[i * 3 + 2], l = Math.max(1e-4, Math.hypot(x, y, z)); uv[i * 2] = Math.atan2(z, x) / (Math.PI * 2) + 0.5; uv[i * 2 + 1] = 1 - Math.acos(clamp(-1, 1, y / l)) / Math.PI }
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
      // adjacency for the smooth tool
      adj = Array.from({ length: V }, () => [] as number[])
      const idx = g.getIndex()
      if (idx) { const a = idx.array as ArrayLike<number>; for (let i = 0; i < a.length; i += 3) { const t = [a[i], a[i + 1], a[i + 2]]; for (let j = 0; j < 3; j++) { const x = t[j], y = t[(j + 1) % 3]; if (!adj[x].includes(y)) adj[x].push(y) } } }
    }
    installSculptGeo(mergeVertices(new THREE.IcosahedronGeometry(1, SUBDIV)))
    // Bump canvas : the carved-relief height map (grey 128 = flat, darker = recessed).
    // Filled procedurally by the global surface finish AND painted locally by the hand tools.
    const BW = 2048, BH = 1024
    const bumpCanvas = document.createElement('canvas'); bumpCanvas.width = BW; bumpCanvas.height = BH
    const bctx = bumpCanvas.getContext('2d')!; bctx.fillStyle = '#808080'; bctx.fillRect(0, 0, BW, BH)
    const bumpTex = new THREE.CanvasTexture(bumpCanvas); bumpTex.wrapS = THREE.RepeatWrapping; bumpTex.wrapT = THREE.ClampToEdgeWrapping
    const clayMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#c8794a'), roughness: 0.85, metalness: 0, flatShading: false, bumpMap: bumpTex, bumpScale: 1, displacementMap: bumpTex, displacementScale: 0, displacementBias: 0 })
    const blob = new THREE.Mesh(geo, clayMat); blob.frustumCulled = false; scene.add(blob)

    // ── Organic-parametric mesh (mode « organique ») : geometry arrives from the worker.
    // Gets its own PMREM environment so glossy glaze / chrome actually reflect something. ──
    const pmrem = new THREE.PMREMGenerator(renderer); let envTex: THREE.Texture | null = null
    try { envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture } catch { envTex = null }
    const orgMat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color('#9fd8d0'), roughness: 0.3, metalness: 0.1, clearcoat: 0.8, clearcoatRoughness: 0.16, side: THREE.DoubleSide, envMap: envTex, envMapIntensity: 1.1 })
    const orgMesh = new THREE.Mesh(new THREE.BufferGeometry(), orgMat); orgMesh.frustumCulled = false; orgMesh.visible = false; scene.add(orgMesh)

    // ── Surface texture painting (bump canvas) ──
    const mkRng = (seed: number) => { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 } }
    const paintGlobal = (pattern: SurfPattern, scaleN: number) => {
      bctx.fillStyle = '#808080'; bctx.fillRect(0, 0, BW, BH)
      if (pattern === 'none') { bumpTex.needsUpdate = true; return }
      const rng = mkRng(1337)
      const density = 0.4 + scaleN * 1.6   // feature frequency
      if (pattern === 'cells') {
        const nx = Math.round(14 * density), ny = Math.round(7 * density)
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
          const cx = (i + 0.5 + (rng() - 0.5) * 0.6) / nx * BW, cy = (j + 0.5 + (rng() - 0.5) * 0.6) / ny * BH
          const rx = BW / nx * (0.34 + rng() * 0.12), ry = BH / ny * (0.34 + rng() * 0.12)
          bctx.save(); bctx.translate(cx, cy); bctx.rotate(rng() * Math.PI)
          const g = bctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(rx, ry)); g.addColorStop(0, '#a8a8a8'); g.addColorStop(0.75, '#8a8a8a'); g.addColorStop(1, '#4a4a4a')
          bctx.fillStyle = g; bctx.beginPath(); bctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2); bctx.fill(); bctx.restore()
        }
      } else if (pattern === 'stipple') {
        const n = Math.round(9000 * density)
        for (let k = 0; k < n; k++) { const x = rng() * BW, y = rng() * BH, r = 1.5 + rng() * 2.5; bctx.fillStyle = 'rgba(40,40,40,0.7)'; bctx.beginPath(); bctx.arc(x, y, r, 0, Math.PI * 2); bctx.fill() }
      } else if (pattern === 'scales') {
        const cols = Math.round(20 * density), rows = Math.round(14 * density), sw = BW / cols, sh = BH / rows
        for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) { const cx = i * sw + (j % 2 ? sw / 2 : 0), cy = j * sh; bctx.strokeStyle = '#5a5a5a'; bctx.lineWidth = 3; bctx.beginPath(); bctx.arc(cx, cy, sw * 0.55, 0.15 * Math.PI, 0.85 * Math.PI); bctx.stroke(); bctx.strokeStyle = '#a0a0a0'; bctx.lineWidth = 2; bctx.beginPath(); bctx.arc(cx, cy - 2, sw * 0.5, 0.2 * Math.PI, 0.8 * Math.PI); bctx.stroke() }
      } else if (pattern === 'ridges') {
        const lines = Math.round(28 * density)
        for (let j = 0; j < lines; j++) { const y0 = (j / lines) * BH; bctx.strokeStyle = j % 2 ? '#5a5a5a' : '#a0a0a0'; bctx.lineWidth = BH / lines * 0.4; bctx.beginPath(); for (let x = 0; x <= BW; x += 12) { const yy = y0 + Math.sin(x / BW * Math.PI * 6 + j) * (BH / lines * 0.3); x === 0 ? bctx.moveTo(x, yy) : bctx.lineTo(x, yy) } bctx.stroke() }
      }
      bumpTex.needsUpdate = true
    }
    // Stamp a hand texture-tool mark at a UV location.
    let stampSeed = 1
    const stampTexture = (u: number, vv: number, tool: Tool, sizeN: number, dir: { x: number; y: number } | null) => {
      const px = ((u % 1) + 1) % 1 * BW, py = clamp(0, 1, 1 - vv) * BH
      const rad = 8 + sizeN * 90
      const rng = mkRng(stampSeed++)
      if (tool === 'stipple') { const n = 6 + Math.floor(sizeN * 40); for (let k = 0; k < n; k++) { const a = rng() * Math.PI * 2, r = rng() * rad, x = px + Math.cos(a) * r, y = py + Math.sin(a) * r, dr = 1.5 + rng() * 2.5; bctx.fillStyle = 'rgba(30,30,30,0.85)'; bctx.beginPath(); bctx.arc(x, y, dr, 0, Math.PI * 2); bctx.fill() } }
      else if (tool === 'cells') { bctx.save(); bctx.translate(px, py); const g = bctx.createRadialGradient(0, 0, 0, 0, 0, rad); g.addColorStop(0, 'rgba(60,60,60,0.9)'); g.addColorStop(0.7, 'rgba(90,90,90,0.6)'); g.addColorStop(1, 'rgba(128,128,128,0)'); bctx.fillStyle = g; bctx.beginPath(); bctx.ellipse(0, 0, rad, rad * (0.7 + rng() * 0.5), rng() * Math.PI, 0, Math.PI * 2); bctx.fill(); bctx.restore() }
      else if (tool === 'groove') { bctx.strokeStyle = 'rgba(40,40,40,0.8)'; bctx.lineWidth = Math.max(3, rad * 0.35); bctx.lineCap = 'round'; const dx = (dir?.x ?? 1), dy = (dir?.y ?? 0), dl = Math.max(1e-3, Math.hypot(dx, dy)); bctx.beginPath(); bctx.moveTo(px - dx / dl * rad, py - dy / dl * rad); bctx.lineTo(px + dx / dl * rad, py + dy / dl * rad); bctx.stroke() }
      bumpTex.needsUpdate = true
    }

    // Metamorphose instances (share the blob geometry so they reflect the sculpt live).
    const instMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.2, side: THREE.DoubleSide, bumpMap: bumpTex, bumpScale: 0.6, displacementMap: bumpTex, displacementScale: 0, displacementBias: 0 })
    // warpGeo : a deformed copy of the sculpted blob (generative deformers applied) used for
    // the metamorphose instances — keeps the editable blob geometry untouched.
    const warpGeo = geo.clone()
    const inst = new THREE.InstancedMesh(warpGeo, instMat, MCAP)
    inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage); inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MCAP * 3), 3)
    inst.count = 0; inst.frustumCulled = false; inst.visible = false; scene.add(inst)

    // Camera orbit
    const target = new THREE.Vector3(0, 0, 0)
    let camDist = 4.0, camAz = 0.3, camPolar = 1.2
    const applyCam = () => { const sp = Math.sin(camPolar), cp = Math.cos(camPolar); camera.position.set(target.x + camDist * sp * Math.sin(camAz), target.y + camDist * cp, target.z + camDist * sp * Math.cos(camAz)); camera.lookAt(target) }
    applyCam()
    const resize = () => { const w = window.innerWidth, h = window.innerHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); overlay.width = w; overlay.height = h }
    resize(); window.addEventListener('resize', resize)
    // Souris + tactile — sculpter SANS webcam. 1 doigt / clic gauche = sculpter (le pointeur
    // est injecté comme « main » d'index 2 dans le loop) ; clic droit / 2 doigts = orbite +
    // pinch-zoom. Molette = zoom.
    let ptrDown = false; const ptrNDC = { x: 0, y: 0 }
    const el = renderer.domElement
    const ptrs = new Map<number, { x: number; y: number }>()
    let orbitDrag = false, lastX = 0, lastY = 0, pinchD = 0
    const toNDC = (e: PointerEvent) => { ptrNDC.x = (e.clientX / window.innerWidth) * 2 - 1; ptrNDC.y = -((e.clientY / window.innerHeight) * 2 - 1) }
    const onDown = (e: PointerEvent) => { el.setPointerCapture?.(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (ptrs.size === 2) { const q = [...ptrs.values()]; pinchD = Math.hypot(q[0].x - q[1].x, q[0].y - q[1].y); lastX = (q[0].x + q[1].x) / 2; lastY = (q[0].y + q[1].y) / 2; ptrDown = false; orbitDrag = false; return }
      if (e.pointerType === 'mouse' && e.button === 2) { orbitDrag = true; lastX = e.clientX; lastY = e.clientY } else { toNDC(e); ptrDown = true } }
    const onMove = (e: PointerEvent) => { if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (ptrs.size >= 2) { const q = [...ptrs.values()]; const d = Math.hypot(q[0].x - q[1].x, q[0].y - q[1].y); const mx = (q[0].x + q[1].x) / 2, my = (q[0].y + q[1].y) / 2; if (pinchD > 0) camDist = clamp(2, 9, camDist * (pinchD / Math.max(1, d))); camAz -= (mx - lastX) * 0.006; camPolar = clamp(0.2, 1.6, camPolar - (my - lastY) * 0.006); pinchD = d; lastX = mx; lastY = my; return }
      if (orbitDrag) { camAz -= (e.clientX - lastX) * 0.006; camPolar = clamp(0.2, 1.6, camPolar - (e.clientY - lastY) * 0.006); lastX = e.clientX; lastY = e.clientY } else if (ptrDown) toNDC(e) }
    const onUp = (e: PointerEvent) => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinchD = 0; if (ptrs.size === 0) { orbitDrag = false; ptrDown = false } }
    const onWheel = (e: WheelEvent) => { camDist = clamp(2, 9, camDist + e.deltaY * 0.003) }
    el.addEventListener('pointerdown', onDown); el.addEventListener('pointermove', onMove); el.addEventListener('pointerup', onUp); el.addEventListener('pointercancel', onUp); el.addEventListener('wheel', onWheel, { passive: true }); el.addEventListener('contextmenu', (ev) => ev.preventDefault())

    const raycaster = new THREE.Raycaster()
    const v2 = new THREE.Vector2(), tmp = new THREE.Vector3(), fwd = new THREE.Vector3()
    const rayToMesh = (nx: number, ny: number) => { v2.set(nx, ny); raycaster.setFromCamera(v2, camera); const h = raycaster.intersectObject(blob, false); return h[0] ?? null }
    const _plane = new THREE.Plane()
    const rayToPlane = (nx: number, ny: number, pl: THREE.Plane) => { v2.set(nx, ny); raycaster.setFromCamera(v2, camera); return raycaster.ray.intersectPlane(pl, new THREE.Vector3()) }

    let skelHands: { x: number; y: number }[][] = []

    // ── Undo / redo (position snapshots) ──
    let past: Float32Array[] = [], future: Float32Array[] = []
    const pushHistory = () => { past.push(new Float32Array(posAttr.array as Float32Array)); if (past.length > 30) past.shift(); future = [] }
    const restore = (s: Float32Array) => { (posAttr.array as Float32Array).set(s); posAttr.needsUpdate = true; geo.computeVertexNormals() }

    // Apply a brush at a world point. `delta` used by grab (drag). Returns nothing.
    const grabSets = new Map<number, { i: number; f: number }[]>()   // per-hand sticky grab set
    const grabPlane = new Map<number, THREE.Plane>(), grabLast = new Map<number, THREE.Vector3>()
    const applyBrush = (center: THREE.Vector3, hand: number, tool: Tool, radius: number, str: number, deltaV: THREE.Vector3 | null, mirrorX: boolean) => {
      const arr = posAttr.array as Float32Array
      const nrm = geo.getAttribute('normal').array as Float32Array
      const doOne = (cx: number, cy: number, cz: number, dx: number, dy: number, dz: number, gset: { i: number; f: number }[] | null) => {
        if (tool === 'grab' && gset) { for (const g of gset) { arr[g.i * 3] += dx * g.f; arr[g.i * 3 + 1] += dy * g.f; arr[g.i * 3 + 2] += dz * g.f }; return }
        const r2 = radius * radius
        for (let i = 0; i < V; i++) {
          const px = arr[i * 3], py = arr[i * 3 + 1], pz = arr[i * 3 + 2]
          const ex = px - cx, ey = py - cy, ez = pz - cz, d2 = ex * ex + ey * ey + ez * ez
          if (d2 > r2) continue
          const t = Math.sqrt(d2) / radius, f = (1 - t) * (1 - t) * str
          if (tool === 'push') { arr[i * 3] -= nrm[i * 3] * radius * 0.6 * f; arr[i * 3 + 1] -= nrm[i * 3 + 1] * radius * 0.6 * f; arr[i * 3 + 2] -= nrm[i * 3 + 2] * radius * 0.6 * f }
          else if (tool === 'inflate') { arr[i * 3] += nrm[i * 3] * radius * 0.6 * f; arr[i * 3 + 1] += nrm[i * 3 + 1] * radius * 0.6 * f; arr[i * 3 + 2] += nrm[i * 3 + 2] * radius * 0.6 * f }
          else if (tool === 'pinch') { arr[i * 3] += (cx - px) * 0.5 * f; arr[i * 3 + 1] += (cy - py) * 0.5 * f; arr[i * 3 + 2] += (cz - pz) * 0.5 * f }
          else if (tool === 'smooth') { const nb = adj[i]; if (nb.length) { let ax = 0, ay = 0, az = 0; for (const j of nb) { ax += arr[j * 3]; ay += arr[j * 3 + 1]; az += arr[j * 3 + 2] } ax /= nb.length; ay /= nb.length; az /= nb.length; arr[i * 3] += (ax - px) * f; arr[i * 3 + 1] += (ay - py) * f; arr[i * 3 + 2] += (az - pz) * f } }
        }
      }
      const gset = tool === 'grab' ? (grabSets.get(hand) ?? null) : null
      const dx = deltaV?.x ?? 0, dy = deltaV?.y ?? 0, dz = deltaV?.z ?? 0
      doOne(center.x, center.y, center.z, dx, dy, dz, gset)
      if (mirrorX) { const gm = tool === 'grab' ? (grabSets.get(hand + 100) ?? null) : null; doOne(-center.x, center.y, center.z, -dx, dy, dz, gm) }
    }

    // ── Metamorphose : replicate + deform the sculpted blob ──
    const cA = new THREE.Color(), cB = new THREE.Color(), cTmp = new THREE.Color()
    const _rk = new THREE.Matrix4(), _mir = new THREE.Matrix4().makeScale(-1, 1, 1)
    let lastSig = ''
    // Generative deformers baked into warpGeo (twist around Y, taper, 3D-noise displacement).
    const buildWarp = (dTwist: number, dTaper: number, dNoise: number, nScale: number, nType: NoiseType) => {
      const src = geo.getAttribute('position').array as Float32Array
      const nrm = geo.getAttribute('normal').array as Float32Array
      const dst = warpGeo.getAttribute('position').array as Float32Array
      for (let i = 0; i < V; i++) {
        let x = src[i * 3], y = src[i * 3 + 1], z = src[i * 3 + 2]
        if (dTwist) { const a = dTwist * y, c = Math.cos(a), s = Math.sin(a), xr = x * c - z * s, zr = x * s + z * c; x = xr; z = zr }
        if (dTaper) { const tf = clamp(0.05, 2, 1 - dTaper * (y * 0.5)); x *= tf; z *= tf }
        if (dNoise) { const n = dNoise * noiseField(nType, x * nScale + 11, y * nScale + 3, z * nScale + 7); x += nrm[i * 3] * n; y += nrm[i * 3 + 1] * n; z += nrm[i * 3 + 2] * n }
        dst[i * 3] = x; dst[i * 3 + 1] = y; dst[i * 3 + 2] = z
      }
      warpGeo.getAttribute('position').needsUpdate = true; warpGeo.computeVertexNormals(); warpGeo.computeBoundingSphere()
    }
    // Placement of the copies : the "style" arranges instances (fractal / grid / radial / spiral).
    const placement = (p: typeof paramsRef.current, tw: number, sp: number, cs: number): { mat: THREE.Matrix4; d: number }[] => {
      const out: { mat: THREE.Matrix4; d: number }[] = []
      if (p.morphStyle === 'grid') {
        const n = clamp(0, 4, Math.round(p.gridN)), step = 1.4 + sp * 1.6
        for (let ix = -n; ix <= n; ix++) for (let iy = -n; iy <= n; iy++) for (let iz = -n; iz <= n; iz++) {
          if (out.length >= MCAP) break
          const jitter = 0.12 * sp
          const mm = new THREE.Matrix4().makeTranslation(ix * step + noise3(ix, iy, iz) * jitter, iy * step, iz * step + noise3(iz, ix, iy) * jitter)
          mm.multiply(new THREE.Matrix4().makeRotationY(tw * (ix + iz))); mm.multiply(new THREE.Matrix4().makeScale(cs + 0.35, cs + 0.35, cs + 0.35))
          out.push({ mat: mm, d: (Math.abs(ix) + Math.abs(iy) + Math.abs(iz)) / (3 * (n + 0.5)) * 4 })
        }
      } else if (p.morphStyle === 'radial') {
        const N = Math.max(1, Math.round(p.radial)), rings = clamp(1, 4, Math.round(p.depth)), rad = 1 + sp * 2
        for (let r = 0; r < rings; r++) for (let k = 0; k < N; k++) {
          if (out.length >= MCAP) break
          const a = (k / N) * Math.PI * 2 + r * 0.4, rr = rad * (1 - r * 0.18)
          const mm = new THREE.Matrix4().makeTranslation(Math.cos(a) * rr, r * (0.6 + sp) - rings * 0.3, Math.sin(a) * rr)
          mm.multiply(new THREE.Matrix4().makeRotationY(-a + tw)); mm.multiply(new THREE.Matrix4().makeScale(cs + 0.3, cs + 0.3, cs + 0.3))
          out.push({ mat: mm, d: r / rings * 4 })
        }
      } else if (p.morphStyle === 'spiral') {
        const total = clamp(6, MCAP, Math.round(p.radial * 12)), tn = clamp(0.5, 6, p.turns), rad = 1 + sp * 1.5
        for (let i = 0; i < total; i++) {
          const t = i / total, a = t * tn * Math.PI * 2, rr = rad * (0.2 + t * 0.8)
          const mm = new THREE.Matrix4().makeTranslation(Math.cos(a) * rr, (t - 0.5) * (2 + sp * 2), Math.sin(a) * rr)
          mm.multiply(new THREE.Matrix4().makeRotationY(-a + tw)); mm.multiply(new THREE.Matrix4().makeScale((cs + 0.3) * (1 - t * 0.4), (cs + 0.3) * (1 - t * 0.4), (cs + 0.3) * (1 - t * 0.4)))
          out.push({ mat: mm, d: t * 4 })
        }
      } else {
        // fractal (IFS)
        const N = Math.max(1, Math.round(p.radial)), symCopies = N * (p.mirror ? 2 : 1), maxNodes = Math.max(2, Math.floor(MCAP / symCopies))
        const maps: THREE.Matrix4[] = []
        for (let m = 0; m < 2; m++) { const a = m * Math.PI + tw; const mm = new THREE.Matrix4(); mm.multiply(new THREE.Matrix4().makeTranslation(Math.cos(a) * sp, sp * 0.6, Math.sin(a) * sp)).multiply(new THREE.Matrix4().makeRotationY(tw + a)).multiply(new THREE.Matrix4().makeScale(cs, cs, cs)); maps.push(mm) }
        const nodes = grow(maps, clamp(1, 4, Math.round(p.depth)), maxNodes)
        for (const node of nodes) for (let k = 0; k < N; k++) { _rk.makeRotationY((k / N) * Math.PI * 2); out.push({ mat: new THREE.Matrix4().multiplyMatrices(_rk, node.mat), d: node.d }); if (out.length >= MCAP) return out }
      }
      return out
    }
    const regenMorph = (p: typeof paramsRef.current, tw: number, sp: number, cs: number) => {
      buildWarp(p.defTwist, p.defTaper, p.defNoise, p.noiseScale, p.noiseType)
      const nodes = placement(p, tw, sp, cs)
      cA.set(p.colorA); cB.set(p.colorB)
      const bb = new THREE.Box3(), pv = new THREE.Vector3(), maxD = Math.max(1, p.morphStyle === 'fractal' ? p.depth : 4)
      let idx = 0
      for (const node of nodes) {
        const variants = p.mirror && p.morphStyle !== 'grid' ? [node.mat, new THREE.Matrix4().multiplyMatrices(_mir, node.mat)] : [node.mat]
        for (const mm of variants) { if (idx >= MCAP) break; inst.setMatrixAt(idx, mm); cTmp.copy(cA).lerp(cB, clamp(0, 1, node.d / maxD)); inst.setColorAt(idx, cTmp); pv.setFromMatrixPosition(mm); bb.expandByPoint(pv); idx++ }
        if (idx >= MCAP) break
      }
      inst.count = idx; inst.instanceMatrix.needsUpdate = true; if (inst.instanceColor) inst.instanceColor.needsUpdate = true
      if (idx > 0) { const c = bb.getCenter(new THREE.Vector3()), sz = bb.getSize(new THREE.Vector3()); const ext = Math.max(sz.x, sz.y, sz.z, 1); const sc = 3.4 / (ext + 1.6); inst.scale.setScalar(sc); inst.position.set(-c.x * sc, -c.y * sc, -c.z * sc) }
    }

    const doExport = (fmt: 'stl' | 'glb') => {
      const p = paramsRef.current
      let merged: THREE.BufferGeometry | null
      if (p.mode === 'organic') { const og = orgMesh.geometry; merged = og.getAttribute('position')?.count ? og.clone() : null; if (!merged) { setStatus('Rien à exporter — génère d\'abord une forme.'); return } }
      else if (p.mode === 'morph' && inst.count > 0) { const geoms: THREE.BufferGeometry[] = []; const m4 = new THREE.Matrix4(); const n = Math.min(inst.count, 400); for (let i = 0; i < n; i++) { inst.getMatrixAt(i, m4); const g = warpGeo.clone().applyMatrix4(m4); geoms.push(g) } merged = mergeGeometries(geoms, false); geoms.forEach((g) => g.dispose()) }
      else merged = geo.clone()
      if (!merged) { setStatus('Export impossible.'); return }
      if (fmt === 'stl') { const stl = new STLExporter().parse(new THREE.Mesh(merged, new THREE.MeshStandardMaterial()), { binary: false }); downloadBlob(new Blob([stl], { type: 'model/stl' }), `sculpt-${Date.now()}.stl`); merged.dispose(); setStatus('Export STL.') }
      else { const g = new THREE.Group(); g.add(new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ color: new THREE.Color(p.colorA), roughness: 0.8, side: THREE.DoubleSide }))); new GLTFExporter().parse(g, (res) => { downloadBlob(new Blob([res as ArrayBuffer], { type: 'model/gltf-binary' }), `sculpt-${Date.now()}.glb`); merged!.dispose() }, () => setStatus('Échec GLB.'), { binary: true }); setStatus('Export GLB.') }
    }

    // ── Recording ──
    let recCanvas: HTMLCanvasElement | null = null, recCtx: CanvasRenderingContext2D | null = null
    let recorder: MediaRecorder | null = null, recChunks: Blob[] = [], recActive = false
    const startRec = () => {
      if (recActive) return
      recCanvas = document.createElement('canvas'); recCanvas.width = overlay.width; recCanvas.height = overlay.height; recCtx = recCanvas.getContext('2d')
      const st = recCanvas.captureStream(30); const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm'
      recChunks = []; recorder = new MediaRecorder(st, { mimeType: mime, videoBitsPerSecond: 12_000_000 })
      recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data) }
      recorder.onstop = () => { downloadBlob(new Blob(recChunks, { type: 'video/webm' }), `sculpt-${Date.now()}.webm`); recChunks = []; setStatus('Vidéo enregistrée (WebM).') }
      recorder.start(); recActive = true; setRecording(true); setStatus('● Enregistrement…')
    }
    const stopRec = () => { if (recActive && recorder) { recorder.stop(); recActive = false; setRecording(false) } }
    recCtl.current = { start: startRec, stop: stopRec }

    // per-hand engagement state (for grab & stroke undo)
    const engaged = [false, false]; const texLast: ({ x: number; y: number } | null)[] = [null, null]; let anySculpt = false, wasSculpt = false
    let lastT = performance.now(), spinT = 0, geoDirty = false, lastTexSig = ''
    const smx = { tw: twist, sp: spread, cs: childScale }
    const loop = () => {
      if (!running) return
      const p = paramsRef.current
      const nowT = performance.now(), dt = clamp(0.001, 0.05, (nowT - lastT) / 1000); lastT = nowT
      if (exportRef.current) { doExport(exportRef.current); exportRef.current = null }
      if (resetRef.current) { pushHistory(); (posAttr.array as Float32Array).set(rest); posAttr.needsUpdate = true; geo.computeVertexNormals(); resetRef.current = false; setStatus('Boule de pâte réinitialisée.') }
      if (undoRef.current) { undoRef.current = false; if (past.length) { future.push(new Float32Array(posAttr.array as Float32Array)); restore(past.pop()!); setStatus('↶ Annulé.') } else setStatus('Rien à annuler.') }
      if (redoRef.current) { redoRef.current = false; if (future.length) { past.push(new Float32Array(posAttr.array as Float32Array)); restore(future.pop()!); setStatus('↷ Refait.') } else setStatus('Rien à refaire.') }
      { const m = MATERIALS.find((x) => x.kind === p.material)!; clayMat.metalness = m.metal; clayMat.roughness = m.rough; clayMat.color.set(p.colorA) }
      // Reinforced texture : stronger bump (fine shading) + real geometry displacement
      // (silhouette relief), both driven by the depth slider. displacementBias centres the
      // grey (128) canvas so flat areas don't inflate.
      const disp = p.surfPattern === 'none' ? 0 : p.texDepth * 0.35
      clayMat.bumpScale = p.texDepth * 3.0; clayMat.displacementScale = disp; clayMat.displacementBias = -disp * 0.5
      instMat.bumpScale = p.texDepth * 1.8; instMat.displacementScale = disp * 0.7; instMat.displacementBias = -disp * 0.35
      if (clearTexRef.current) { clearTexRef.current = false; bctx.fillStyle = '#808080'; bctx.fillRect(0, 0, BW, BH); bumpTex.needsUpdate = true; lastTexSig = 'cleared'; setStatus('Texture effacée.') }
      { const tsig = `${p.surfPattern}|${p.texScale.toFixed(2)}`; if (tsig !== lastTexSig) { paintGlobal(p.surfPattern, p.texScale); lastTexSig = tsig } }
      blob.visible = p.mode === 'sculpt'; inst.visible = p.mode === 'morph'; orgMesh.visible = p.mode === 'organic'
      // Pick up a freshly generated organic mesh (built off-thread) and drive its finish.
      if (orgDirtyRef.current && orgGeoRef.current) {
        orgDirtyRef.current = false
        const old = orgMesh.geometry; orgMesh.geometry = orgGeoRef.current; old.dispose()
      }
      // « Utiliser ma forme sculptée » : snapshot the current clay as the organic body.
      if (captureRef.current) {
        captureRef.current = false
        orgSourceRef.current = geomToData(geo)
        setOrgSourceName(`forme sculptée · ${V.toLocaleString('fr-FR')} sommets`)
        setOrgSourceVer((v) => v + 1)
        setOrg((o) => ({ ...o, form: 'mesh' }))   // sinon le bouton paraît sans effet
        setMode('organic')
        setStatus('Forme sculptée capturée — elle sert maintenant de corps organique.')
      }
      // « Sculpter cette forme » : the generated mesh becomes the sculptable blob. Topology
      // changes completely, so the undo history (indexed by vertex) has to be dropped.
      if (adoptRef.current) {
        adoptRef.current = false
        const src = orgMesh.geometry
        if (src.getAttribute('position')?.count) {
          const old = blob.geometry
          installSculptGeo(src.clone())
          blob.geometry = geo
          if (old !== geo) old.dispose()
          past.length = 0; future = []
          setStatus(`Forme adoptée — ${V.toLocaleString('fr-FR')} sommets sculptables. Travaille-la à la main ou à la souris.`)
        } else setStatus('Génère d\'abord une forme avant de la sculpter.')
      }
      if (p.mode === 'organic') {
        const m = MATERIALS.find((x) => x.kind === p.material)!
        orgMat.metalness = m.metal; orgMat.roughness = m.rough; orgMat.color.set(p.colorA)
        // « bio » = émail irisé façon raku/nacre ; chrome = clearcoat pur, sans irisation.
        orgMat.iridescence = p.material === 'bio' ? 0.85 : 0
        orgMat.iridescenceIOR = 1.5
        orgMat.clearcoat = p.material === 'matte' ? 0 : 0.85
      }

      anySculpt = false
      let hpar = { sp: p.spread, tw: p.twist, cs: p.childScale, driving: false }
      if (p.handsPaused) skelHands = []      // pause : les mains n'agissent plus (souris toujours active)
      if (!p.handsPaused && video.readyState >= 2 && video.currentTime !== lastVideoTime && landmarker) {
        lastVideoTime = video.currentTime
        const res = landmarker.recognizeForVideo(video, performance.now())
        const hands = res.landmarks ?? []
        skelHands = hands.slice(0, 2).map((lm) => lm.map((k: { x: number; y: number }) => ({ x: (1 - k.x) * overlay.width, y: k.y * overlay.height })))
        if (!hands.length) skelHands = []
        blob.updateMatrixWorld()
        for (let i = 0; i < Math.min(2, hands.length); i++) {
          const lm = hands[i]
          const hs = Math.max(0.02, Math.hypot(lm[WRIST].x - lm[MID_MCP].x, lm[WRIST].y - lm[MID_MCP].y))
          const pinch = Math.hypot(lm[TIP_THUMB].x - lm[TIP_INDEX].x, lm[TIP_THUMB].y - lm[TIP_INDEX].y) / hs
          const press = clamp(0, 1, (0.7 - pinch) / 0.45)
          const nx = (1 - lm[TIP_INDEX].x) * 2 - 1, ny = -(lm[TIP_INDEX].y * 2 - 1)
          if (p.mode === 'sculpt') {
            if (press > 0.2) {
              anySculpt = true
              const radius = p.brushSize, str = clamp(0, 1, p.strength) * clamp(0, 1, (press - 0.2) / 0.6) * Math.min(1, dt * 12)
              if (isTex(p.tool)) {
                // TEXTURE tools : carve into the bump canvas at the touched UV (fine detail).
                const hit = rayToMesh(nx, ny)
                if (hit && hit.uv) {
                  engaged[i] = true
                  const lu = texLast[i]; const dir = lu ? { x: hit.uv.x - lu.x, y: -(hit.uv.y - lu.y) } : null
                  stampTexture(hit.uv.x, hit.uv.y, p.tool, radius, dir)
                  if (p.symX) { const mp = hit.point, l = Math.max(1e-4, Math.hypot(-mp.x, mp.y, mp.z)); const mu = Math.atan2(mp.z, -mp.x) / (Math.PI * 2) + 0.5, mv = 1 - Math.acos(clamp(-1, 1, mp.y / l)) / Math.PI; stampTexture(mu, mv, p.tool, radius, dir ? { x: -dir.x, y: dir.y } : null) }
                  texLast[i] = { x: hit.uv.x, y: hit.uv.y }
                }
              } else {
                if (!engaged[i]) {
                  const hit = rayToMesh(nx, ny)
                  if (hit) {
                    engaged[i] = true
                    if (p.tool === 'grab') {
                      const build = (cx: number, cy: number, cz: number, key: number) => { const arr = posAttr.array as Float32Array; const set: { i: number; f: number }[] = []; const r2 = radius * radius; for (let q = 0; q < V; q++) { const ex = arr[q * 3] - cx, ey = arr[q * 3 + 1] - cy, ez = arr[q * 3 + 2] - cz, d2 = ex * ex + ey * ey + ez * ez; if (d2 <= r2) { const t = Math.sqrt(d2) / radius; set.push({ i: q, f: (1 - t) * (1 - t) }) } } grabSets.set(key, set) }
                      build(hit.point.x, hit.point.y, hit.point.z, i); if (p.symX) build(-hit.point.x, hit.point.y, hit.point.z, i + 100)
                      camera.getWorldDirection(fwd); _plane.setFromNormalAndCoplanarPoint(fwd, hit.point); grabPlane.set(i, _plane.clone()); grabLast.set(i, hit.point.clone())
                    }
                  }
                }
                if (engaged[i]) {
                  if (p.tool === 'grab') { const pl = grabPlane.get(i)!; const cur = rayToPlane(nx, ny, pl); if (cur) { const last = grabLast.get(i)!; tmp.subVectors(cur, last).multiplyScalar(clamp(0, 1.2, str * 3)); applyBrush(last, i, 'grab', radius, str, tmp, p.symX); grabLast.set(i, cur) } }
                  else { const hit = rayToMesh(nx, ny); if (hit) applyBrush(hit.point, i, p.tool, radius, str, null, p.symX) }
                  geoDirty = true
                }
              }
            } else { engaged[i] = false; grabSets.delete(i); grabSets.delete(i + 100); texLast[i] = null }
          }
        }
        // Metamorphose driven by hands (écartement/hauteur/inclinaison/pince)
        if (p.mode === 'morph' && p.handDrive && hands.length) {
          hpar.driving = true
          const H = hands.map((lm) => ({ x: lm[MID_MCP].x, y: lm[MID_MCP].y }))
          if (H.length >= 2) { const sep = Math.hypot(H[0].x - H[1].x, H[0].y - H[1].y); hpar.sp = clamp(0.15, 1.4, sep * 2); hpar.tw = clamp(-2.5, 2.5, (0.5 - (H[0].y + H[1].y) / 2) * 5); hpar.cs = clamp(0.35, 0.72, 0.4 + (1 - Math.abs(H[0].y - H[1].y)) * 0.3) }
          else { hpar.sp = clamp(0.15, 1.4, (1 - H[0].y) * 1.4); hpar.tw = clamp(-2.5, 2.5, (0.5 - H[0].y) * 5) }
        }
      }
      // Souris / tactile (index de « main » 2) — même logique de sculpture que les mains,
      // pilotée par le pointeur, sans webcam. Réutilise engaged/grabSets/grabPlane/grabLast.
      if (p.mode === 'sculpt' && ptrDown) {
        const nx = ptrNDC.x, ny = ptrNDC.y
        anySculpt = true
        const radius = p.brushSize, str = clamp(0, 1, p.strength) * Math.min(1, dt * 12)
        if (isTex(p.tool)) {
          const hit = rayToMesh(nx, ny)
          if (hit && hit.uv) { const lu = texLast[2]; const dir = lu ? { x: hit.uv.x - lu.x, y: -(hit.uv.y - lu.y) } : null; stampTexture(hit.uv.x, hit.uv.y, p.tool, radius, dir); if (p.symX) { const mp = hit.point, l = Math.max(1e-4, Math.hypot(-mp.x, mp.y, mp.z)); const mu = Math.atan2(mp.z, -mp.x) / (Math.PI * 2) + 0.5, mv = 1 - Math.acos(clamp(-1, 1, mp.y / l)) / Math.PI; stampTexture(mu, mv, p.tool, radius, dir ? { x: -dir.x, y: dir.y } : null) } texLast[2] = { x: hit.uv.x, y: hit.uv.y } }
        } else {
          if (!engaged[2]) {
            const hit = rayToMesh(nx, ny)
            if (hit) { engaged[2] = true; if (p.tool === 'grab') { const build = (cx: number, cy: number, cz: number, key: number) => { const arr = posAttr.array as Float32Array; const set: { i: number; f: number }[] = []; const r2 = radius * radius; for (let q = 0; q < V; q++) { const ex = arr[q * 3] - cx, ey = arr[q * 3 + 1] - cy, ez = arr[q * 3 + 2] - cz, d2 = ex * ex + ey * ey + ez * ez; if (d2 <= r2) { const t = Math.sqrt(d2) / radius; set.push({ i: q, f: (1 - t) * (1 - t) }) } } grabSets.set(key, set) }; build(hit.point.x, hit.point.y, hit.point.z, 2); if (p.symX) build(-hit.point.x, hit.point.y, hit.point.z, 102); camera.getWorldDirection(fwd); _plane.setFromNormalAndCoplanarPoint(fwd, hit.point); grabPlane.set(2, _plane.clone()); grabLast.set(2, hit.point.clone()) } }
          }
          if (engaged[2]) {
            if (p.tool === 'grab') { const pl = grabPlane.get(2); if (pl) { const cur = rayToPlane(nx, ny, pl); if (cur) { const last = grabLast.get(2)!; tmp.subVectors(cur, last).multiplyScalar(clamp(0, 1.2, str * 3)); applyBrush(last, 2, 'grab', radius, str, tmp, p.symX); grabLast.set(2, cur) } } }
            else { const hit = rayToMesh(nx, ny); if (hit) applyBrush(hit.point, 2, p.tool, radius, str, null, p.symX) }
            geoDirty = true
          }
        }
      } else if (engaged[2]) { engaged[2] = false; grabSets.delete(2); grabSets.delete(102); texLast[2] = null }

      if (p.mode === 'sculpt' && geoDirty) { posAttr.needsUpdate = true; geo.computeVertexNormals(); geo.computeBoundingSphere(); geoDirty = false }
      // stroke-based undo snapshot (before a new stroke)
      if (p.mode === 'sculpt') { if (anySculpt && !wasSculpt) pushHistory(); wasSculpt = anySculpt }

      if (p.mode === 'morph') {
        let tw = hpar.tw, sp = hpar.sp, cs = hpar.cs
        if (hpar.driving) { tw = smx.tw += (tw - smx.tw) * 0.15; sp = smx.sp += (sp - smx.sp) * 0.15; cs = smx.cs += (cs - smx.cs) * 0.15 } else { smx.tw = tw; smx.sp = sp; smx.cs = cs }
        const sig = `${p.morphStyle}|${p.depth}|${p.radial}|${p.gridN}|${p.turns}|${p.mirror}|${p.colorA}|${p.colorB}|${p.defTwist}|${p.defTaper}|${p.defNoise}|${p.noiseScale}|${p.noiseType}|${tw.toFixed(3)}|${sp.toFixed(3)}|${cs.toFixed(3)}|${geo.attributes.position.version}`
        if (sig !== lastSig) { regenMorph(p, tw, sp, cs); lastSig = sig }
      }

      if (p.mode === 'sculpt') { blob.rotation.y = 0 } else { spinT += dt * 0.3; inst.rotation.y = spinT }
      applyCam(); renderer.render(scene, camera)

      // Overlay
      octx.clearRect(0, 0, overlay.width, overlay.height)
      if (p.showSkeleton) { octx.lineWidth = 2; octx.strokeStyle = 'rgba(255,255,255,0.4)'; for (const hnd of skelHands) { for (const chain of FINGER_CHAINS) { octx.beginPath(); chain.forEach((ci, k) => { const pt = hnd[ci]; if (!pt) return; if (k === 0) octx.moveTo(pt.x, pt.y); else octx.lineTo(pt.x, pt.y) }); octx.stroke() } for (const pt of hnd) { octx.beginPath(); octx.arc(pt.x, pt.y, 2.5, 0, Math.PI * 2); octx.fillStyle = 'rgba(255,140,60,0.6)'; octx.fill() } } }
      // fingertip tool markers
      for (let i = 0; i < skelHands.length; i++) { const tip = skelHands[i][TIP_INDEX]; if (!tip) continue; const on = engaged[i]; octx.beginPath(); octx.arc(tip.x, tip.y, on ? 13 : 8, 0, Math.PI * 2); octx.fillStyle = on ? 'rgba(255,140,60,0.6)' : 'rgba(255,255,255,0.35)'; octx.globalAlpha = 0.9; octx.fill(); octx.globalAlpha = 1; octx.lineWidth = 2.5; octx.strokeStyle = '#ff8c3c'; octx.stroke() }
      if (recActive && recCtx && recCanvas) { const w = recCanvas.width, h = recCanvas.height; if (p.bgMode === 'webcam' && video.readyState >= 2) { recCtx.save(); recCtx.translate(w, 0); recCtx.scale(-1, 1); recCtx.drawImage(video, 0, 0, w, h); recCtx.restore() } else { recCtx.fillStyle = '#0a0806'; recCtx.fillRect(0, 0, w, h) } recCtx.drawImage(renderer.domElement, 0, 0, w, h); recCtx.drawImage(overlay, 0, 0, w, h) }
      rafId = requestAnimationFrame(loop)
    }

    const init = async () => {
      loop()
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false }).catch(() => navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false }))
        video.srcObject = stream; await new Promise<void>((res) => { video.onloadedmetadata = () => res() }); await video.play()
        const files = await FilesetResolver.forVisionTasks(WASM_BASE)
        landmarker = await GestureRecognizer.createFromOptions(files, { baseOptions: { modelAssetPath: GESTURE_MODEL_URL, delegate: 'GPU' }, runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.45, minHandPresenceConfidence: 0.3, minTrackingConfidence: 0.3 })
        setStatus('Prêt — pince pour toucher la pâte, tire/pousse avec le doigt ✦')
      } catch (e: any) { setError(`Caméra ou modèle indisponible : ${e?.message ?? e}`) }
    }
    init()

    return () => {
      running = false; if (rafId) cancelAnimationFrame(rafId)
      window.removeEventListener('resize', resize)
      el.removeEventListener('pointerdown', onDown); el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerup', onUp); el.removeEventListener('pointercancel', onUp); el.removeEventListener('wheel', onWheel)
      try { landmarker?.close() } catch { /* noop */ }
      if (stream) stream.getTracks().forEach((t) => t.stop()); video.srcObject = null
      try { if (recActive && recorder) recorder.stop() } catch { /* noop */ }
      geo.dispose(); warpGeo.dispose(); clayMat.dispose(); instMat.dispose(); inst.dispose(); bumpTex.dispose()
      orgMesh.geometry.dispose(); orgMat.dispose(); envTex?.dispose(); pmrem.dispose()
      renderer.dispose(); if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement)
    }
  }, [])

  const exportPng = () => {
    const three = mountRef.current?.querySelector('canvas') as HTMLCanvasElement | null; if (!three) return
    const out = document.createElement('canvas'); out.width = three.width; out.height = three.height; const c = out.getContext('2d')!
    if (bgMode === 'webcam' && videoRef.current && videoRef.current.readyState >= 2) { c.save(); c.translate(out.width, 0); c.scale(-1, 1); c.drawImage(videoRef.current, 0, 0, out.width, out.height); c.restore() } else { c.fillStyle = '#0a0806'; c.fillRect(0, 0, out.width, out.height) }
    c.drawImage(three, 0, 0, out.width, out.height); out.toBlob((b) => { if (b) downloadBlob(b, `sculpt-${Date.now()}.png`) }, 'image/png')
  }

  const toolHint = TOOLS.find((t) => t.kind === tool)?.hint ?? ''

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0a0806', overflow: 'hidden', userSelect: 'none', fontFamily: 'system-ui' }}>
      <video ref={videoRef} autoPlay playsInline muted style={{ position: 'absolute', inset: 0, width: '100vw', height: '100vh', objectFit: 'cover', transform: 'scaleX(-1)', zIndex: 1, opacity: bgMode === 'webcam' ? 1 : 0 }} />
      <div ref={mountRef} style={{ position: 'absolute', inset: 0, zIndex: 3 }} />
      <canvas ref={overlayRef} style={{ position: 'absolute', inset: 0, width: '100vw', height: '100vh', zIndex: 4, pointerEvents: 'none' }} />
      {!panelOpen && <button onClick={() => setPanelOpen(true)} style={{ position: 'absolute', top: 16, left: 16, zIndex: 11, ...selStyle, width: 'auto', padding: '8px 12px' }}>☰</button>}
      {panelOpen && (
        <div style={{ position: 'absolute', top: 16, left: 16, zIndex: 10, width: 300, background: 'rgba(12,9,8,0.9)', padding: 18, borderRadius: 16, backdropFilter: 'blur(10px)', border: '1px solid rgba(255,140,60,0.22)', boxShadow: '0 10px 30px rgba(0,0,0,0.5)', maxHeight: 'calc(100vh - 32px)', overflowY: 'auto', color: '#ece2d8' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <strong style={{ color: '#ff8c3c', textTransform: 'uppercase', letterSpacing: 1, fontSize: 14 }}>🗿 Sculpture · Pâte</strong>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Link to="/" style={{ color: '#aaa', fontSize: 12, textDecoration: 'none' }}>← Studio</Link><button onClick={() => setPanelOpen(false)} style={{ background: 'transparent', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: 16 }}>«</button></div>
          </div>
          <div style={{ color: error ? '#ff6b6b' : '#9a8a78', fontSize: 11, marginBottom: 10, lineHeight: 1.3 }}>{error ?? status}</div>

          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <button onClick={() => setMode('sculpt')} style={{ ...selStyle, flex: 1, background: mode === 'sculpt' ? 'rgba(255,140,60,0.3)' : 'rgba(255,255,255,0.08)', borderColor: mode === 'sculpt' ? 'rgba(255,140,60,0.6)' : 'rgba(255,255,255,0.18)' }}>🖐️ Sculpter</button>
            <button onClick={() => setMode('morph')} style={{ ...selStyle, flex: 1, background: mode === 'morph' ? 'rgba(255,140,60,0.3)' : 'rgba(255,255,255,0.08)', borderColor: mode === 'morph' ? 'rgba(255,140,60,0.6)' : 'rgba(255,255,255,0.18)' }}>🧬 Métamorphoser</button>
          </div>
          <button onClick={() => setMode('organic')} style={{ ...selStyle, marginBottom: 6, background: mode === 'organic' ? 'rgba(120,220,200,0.28)' : 'rgba(255,255,255,0.08)', borderColor: mode === 'organic' ? 'rgba(120,220,200,0.6)' : 'rgba(255,255,255,0.18)' }} title="Génère des formes organiques-paramétriques continues : coques perforées, boucles, lattices — impossibles à obtenir par réplication d'instances.">🪸 Organique paramétrique</button>
          <button onClick={() => setHandsPaused((v) => !v)} style={{ ...selStyle, marginBottom: 10, background: handsPaused ? 'rgba(90,200,255,0.28)' : 'rgba(255,255,255,0.08)', borderColor: handsPaused ? '#5ac8ff' : 'rgba(255,255,255,0.18)' }} title="Fige le suivi des mains : la caméra n'agit plus sur la matière. Orbite, cadrage, souris et curseurs restent actifs.">{handsPaused ? '▶ Reprendre les mains' : '⏸ Pause des mains (figer la sculpture)'}</button>

          {mode === 'sculpt' && <>
            <div style={{ fontSize: 10, color: '#ffcf9a', marginBottom: 10, lineHeight: 1.35, background: 'rgba(255,140,0,0.08)', padding: 7, borderRadius: 6 }}>☝️ <b>Pince</b> pouce+index pour toucher la pâte, puis <b>bouge le doigt</b> pour la travailler. Deux mains = deux outils.<br />🖱️/👆 <b>Sans caméra</b> : 1 doigt / clic gauche = <b>sculpter</b> · clic droit ou 2 doigts = <b>tourner + zoom</b>.</div>
            <Field label="Outil de modelage">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>{TOOLS.map((t) => (<button key={t.kind} onClick={() => setTool(t.kind)} style={{ ...selStyle, fontSize: 12, padding: 7, background: tool === t.kind ? 'rgba(255,140,60,0.28)' : 'rgba(255,255,255,0.08)', borderColor: tool === t.kind ? 'rgba(255,140,60,0.6)' : 'rgba(255,255,255,0.18)' }}>{t.label}</button>))}</div>
              <p style={{ color: '#9a8a78', fontSize: 10, margin: '6px 0 0', lineHeight: 1.35 }}>{toolHint}</p>
            </Field>
            <Field label={`Taille de l'outil — ${Math.round(brushSize * 100)}`}><input type="range" min={0.12} max={0.8} step={0.02} value={brushSize} onChange={(e) => setBrushSize(+e.target.value)} style={rngStyle} /></Field>
            <Field label={`Force — ${Math.round(strength * 100)}%`}><input type="range" min={0.1} max={1} step={0.05} value={strength} onChange={(e) => setStrength(+e.target.value)} style={rngStyle} /></Field>
            <label style={chkRow}><input type="checkbox" checked={symX} onChange={(e) => setSymX(e.target.checked)} style={{ accentColor: '#ff8c3c' }} /> 🦋 Symétrie gauche/droite</label>
            <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <button onClick={() => { undoRef.current = true }} style={{ ...selStyle, flex: 1, fontSize: 12 }}>↶ Annuler</button>
              <button onClick={() => { redoRef.current = true }} style={{ ...selStyle, flex: 1, fontSize: 12 }}>↷ Refaire</button>
              <button onClick={() => { resetRef.current = true }} style={{ ...selStyle, flex: 1, fontSize: 12, background: 'rgba(255,80,80,0.2)', borderColor: 'rgba(255,80,80,0.45)' }}>⟲ Boule</button>
            </div>
          </>}

          {mode === 'morph' && <>
            <div style={{ fontSize: 10, color: '#ffcf9a', marginBottom: 10, lineHeight: 1.35, background: 'rgba(255,140,0,0.08)', padding: 7, borderRadius: 6 }}>✋ Ta forme sculptée est répliquée + déformée. <b>Écarte</b> les mains = déploie · <b>hauteur</b> = torsion. Ou règle aux curseurs.</div>
            <Field label="Style de placement"><select value={morphStyle} onChange={(e) => setMorphStyle(e.target.value as MorphStyle)} style={selStyle}>{MORPH_STYLES.map((s) => <option key={s.kind} value={s.kind}>{s.label}</option>)}</select></Field>
            <label style={chkRow}><input type="checkbox" checked={handDrive} onChange={(e) => setHandDrive(e.target.checked)} style={{ accentColor: '#ff8c3c' }} /> ✋ Piloter aux mains</label>
            {morphStyle === 'grid' && <Field label={`Taille de la grille — ${gridN * 2 + 1}³`}><input type="range" min={0} max={4} step={1} value={gridN} onChange={(e) => setGridN(+e.target.value)} style={rngStyle} /></Field>}
            {(morphStyle === 'fractal' || morphStyle === 'radial') && <Field label={`${morphStyle === 'radial' ? 'Anneaux' : 'Itérations'} — ${depth}`}><input type="range" min={1} max={4} step={1} value={depth} onChange={(e) => setDepth(+e.target.value)} style={rngStyle} /></Field>}
            {(morphStyle === 'fractal' || morphStyle === 'radial' || morphStyle === 'spiral') && <Field label={`${morphStyle === 'spiral' ? 'Densité' : 'Symétrie radiale'} — ${radial}`}><input type="range" min={1} max={8} step={1} value={radial} onChange={(e) => setRadial(+e.target.value)} style={rngStyle} /></Field>}
            {morphStyle === 'spiral' && <Field label={`Tours — ${turns}`}><input type="range" min={0.5} max={6} step={0.5} value={turns} onChange={(e) => setTurns(+e.target.value)} style={rngStyle} /></Field>}
            {morphStyle !== 'grid' && <label style={chkRow}><input type="checkbox" checked={mirror} onChange={(e) => setMirror(e.target.checked)} style={{ accentColor: '#ff8c3c' }} /> 🦋 Miroir bilatéral</label>}
            <Field label={`Rotation — ${twist.toFixed(2)}`}><input type="range" min={-2.5} max={2.5} step={0.02} value={twist} onChange={(e) => setTwist(+e.target.value)} style={rngStyle} /></Field>
            <Field label={`Déploiement — ${spread.toFixed(2)}`}><input type="range" min={0.15} max={1.4} step={0.02} value={spread} onChange={(e) => setSpread(+e.target.value)} style={rngStyle} /></Field>
            <Field label={`Échelle des copies — ${childScale.toFixed(2)}`}><input type="range" min={0.35} max={0.72} step={0.01} value={childScale} onChange={(e) => setChildScale(+e.target.value)} style={rngStyle} /></Field>
            <div style={{ fontSize: 10, color: '#ff8c3c', textTransform: 'uppercase', letterSpacing: 1, margin: '10px 0 6px' }}>Déformateurs génératifs</div>
            <Field label={`Torsion — ${defTwist.toFixed(2)}`}><input type="range" min={-3} max={3} step={0.05} value={defTwist} onChange={(e) => setDefTwist(+e.target.value)} style={rngStyle} /></Field>
            <Field label={`Effilé — ${defTaper.toFixed(2)}`}><input type="range" min={-1} max={1} step={0.02} value={defTaper} onChange={(e) => setDefTaper(+e.target.value)} style={rngStyle} /></Field>
            <Field label={`Bruit organique — ${defNoise.toFixed(2)}`}><input type="range" min={0} max={0.6} step={0.01} value={defNoise} onChange={(e) => setDefNoise(+e.target.value)} style={rngStyle} /></Field>
            {defNoise > 0 && <>
              <Field label="Type de bruit"><select value={noiseType} onChange={(e) => setNoiseType(e.target.value as NoiseType)} style={selStyle}>{NOISE_TYPES.map((n) => <option key={n.kind} value={n.kind}>{n.label}</option>)}</select></Field>
              <Field label={`Grain du bruit — ${noiseScale.toFixed(1)}`}><input type="range" min={0.5} max={10} step={0.5} value={noiseScale} onChange={(e) => setNoiseScale(+e.target.value)} style={rngStyle} /></Field>
            </>}
          </>}

          {mode === 'organic' && <>
            <div style={{ fontSize: 10, color: '#a8f0e0', marginBottom: 10, lineHeight: 1.35, background: 'rgba(60,200,180,0.1)', padding: 7, borderRadius: 6 }}>🪸 Forme <b>continue</b> générée par champ de distance : un corps est <b>évidé</b> en coque puis <b>perforé</b> avec un booléen adouci — c'est ce fondu qui donne les entretoises rondes « poussées » plutôt que percées.<br />Tout est recalculé hors du thread d'affichage : l'aperçu reste fluide.</div>

            <Field label="✨ Générer par l'IA (décris la sculpture)">
              <textarea value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} rows={2} placeholder="ex. « une urne en dentelle d'os, ajourée et torsadée »"
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!aiBusy) runAI(aiPrompt) } }}
                style={{ width: '100%', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.2)', color: 'white', padding: 8, borderRadius: 6, fontSize: 12, resize: 'vertical', fontFamily: 'inherit' }} />
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <button disabled={aiBusy} onClick={() => runAI(aiPrompt)} style={{ ...selStyle, flex: 2, fontSize: 12, opacity: aiBusy ? 0.6 : 1, background: 'rgba(160,120,255,0.24)', borderColor: 'rgba(160,120,255,0.55)' }}>{aiBusy ? '⏳ Génération…' : '✨ Générer'}</button>
                <button disabled={aiBusy} onClick={() => { setAiPrompt(''); runAI('') }} style={{ ...selStyle, flex: 1, fontSize: 12, opacity: aiBusy ? 0.6 : 1 }} title="Variation aléatoire cohérente">🎲 Surprends-moi</button>
              </div>
              {aiNote && <p style={{ color: aiNote.startsWith('✨') ? '#c9b6ff' : '#ffcf9a', fontSize: 10, margin: '6px 0 0', lineHeight: 1.35 }}>{aiNote}</p>}
              {aiNote.includes('/admin') && <p style={{ fontSize: 10, margin: '4px 0 0' }}><Link to="/admin" style={{ color: '#8fd0ff' }}>→ Ouvrir /admin pour se connecter</Link></p>}
              <p style={{ color: '#7a6a58', fontSize: 10, margin: '6px 0 0', lineHeight: 1.35 }}>L'IA distante est réservée à l'admin connecté (les endpoints IA sont payants). Sans elle, l'interprète local prend le relais.</p>
            </Field>

            <Field label="Départ rapide">
              <div style={{ display: 'grid', gap: 5 }}>{ORG_PRESETS.map((pr) => (
                <button key={pr.name} onClick={() => setOrg((o) => ({ ...o, ...pr.params }))} style={{ ...selStyle, fontSize: 11, padding: 7, textAlign: 'left' }} title={pr.desc}>{pr.name}</button>
              ))}</div>
            </Field>

            <Field label="Corps"><select value={org.form} onChange={(e) => setOrgP('form', e.target.value as OrgForm)} style={selStyle}>{ORG_FORMS.map((f) => <option key={f.kind} value={f.kind}>{f.label}</option>)}</select></Field>

            {/* Toujours visibles : ces deux actions étaient auparavant cachées derrière le
                choix « Ma forme » dans le sélecteur ci-dessus — donc invisibles par défaut.
                Elles basculent le corps sur « Ma forme » elles-mêmes. */}
            <Field label="Appliquer à MA forme (sculptée ou importée)">
              <div style={{ display: 'grid', gap: 5 }}>
                <button onClick={() => { captureRef.current = true }} style={{ ...selStyle, fontSize: 11, padding: 7, background: 'rgba(255,140,60,0.18)', borderColor: 'rgba(255,140,60,0.45)' }} title="Prend la pâte actuellement sculptée comme corps : elle sera évidée, perforée et déformée par les réglages ci-dessous.">🖐️ Utiliser ma forme sculptée</button>
                <label style={{ ...selStyle, fontSize: 11, padding: 7, display: 'block', textAlign: 'center', background: 'rgba(120,220,200,0.18)', borderColor: 'rgba(120,220,200,0.45)' }} title="STL, OBJ ou SVG. Le modèle est recentré, mis à l'échelle, puis converti en champ de distance signée.">
                  📥 Importer un objet (STL / OBJ / SVG)
                  <input type="file" accept=".stl,.obj,.svg" onChange={(e) => { onImport(e.target.files?.[0] ?? null); e.currentTarget.value = '' }} style={{ display: 'none' }} />
                </label>
              </div>
              <p style={{ color: orgSourceName ? '#a8f0e0' : '#9a8a78', fontSize: 10, margin: '6px 0 0', lineHeight: 1.35 }}>
                {orgSourceName
                  ? `✓ Source : ${orgSourceName}${org.form === 'mesh' ? '' : ' (choisis « Ma forme » comme corps pour l\'utiliser)'}`
                  : 'Sinon, le corps est une des formes intégrées choisies ci-dessus.'}
              </p>
              {org.form === 'mesh' && !orgSourceName && <p style={{ color: '#ffcf9a', fontSize: 10, margin: '4px 0 0', lineHeight: 1.35 }}>⚠ Corps « Ma forme » sélectionné mais aucune source — capture ta pâte ou importe un fichier.</p>}
              <p style={{ color: '#7a6a58', fontSize: 10, margin: '4px 0 0', lineHeight: 1.35 }}>Le maillage est cuit en champ de distance signée (grille 56³), puis traité comme les formes intégrées : coque, perforations, torsion.</p>
            </Field>
            <Field label="Perforation"><select value={org.pore} onChange={(e) => setOrgP('pore', e.target.value as OrgPore)} style={selStyle}>{ORG_PORES.map((f) => <option key={f.kind} value={f.kind}>{f.label}</option>)}</select></Field>

            {(org.pore === 'pores' || org.pore === 'boucles') && <>
              <Field label={`Symétrie radiale (par anneau) — ${org.poreCount}`}><input type="range" min={2} max={12} step={1} value={org.poreCount} onChange={(e) => setOrgP('poreCount', +e.target.value)} style={rngStyle} /></Field>
              <Field label={`Anneaux (hauteur) — ${org.poreRows}`}><input type="range" min={1} max={8} step={1} value={org.poreRows} onChange={(e) => setOrgP('poreRows', +e.target.value)} style={rngStyle} /></Field>
              <Field label={`Taille des ouvertures — ${org.poreSize.toFixed(2)}`}><input type="range" min={0.04} max={0.32} step={0.01} value={org.poreSize} onChange={(e) => setOrgP('poreSize', +e.target.value)} style={rngStyle} /></Field>
              <Field label={`Écartement à l'axe — ${org.poreRadius.toFixed(2)}`}><input type="range" min={0.1} max={0.8} step={0.02} value={org.poreRadius} onChange={(e) => setOrgP('poreRadius', +e.target.value)} style={rngStyle} /></Field>
            </>}
            {(org.pore === 'lattice' || org.pore === 'cellules') && <Field label={`Densité du réseau — ${org.latticeFreq.toFixed(1)}`}><input type="range" min={2} max={14} step={0.5} value={org.latticeFreq} onChange={(e) => setOrgP('latticeFreq', +e.target.value)} style={rngStyle} /></Field>}

            <Field label={`Fondu des jonctions — ${org.blend.toFixed(3)}`}><input type="range" min={0} max={0.22} step={0.005} value={org.blend} onChange={(e) => setOrgP('blend', +e.target.value)} style={rngStyle} /></Field>
            <Field label={`Épaisseur de coque — ${org.shell === 0 ? 'plein' : org.shell.toFixed(3)}`}><input type="range" min={0} max={0.16} step={0.005} value={org.shell} onChange={(e) => setOrgP('shell', +e.target.value)} style={rngStyle} /></Field>
            <label style={chkRow}><input type="checkbox" checked={org.mirror} onChange={(e) => setOrgP('mirror', e.target.checked)} style={{ accentColor: '#6fe0c8' }} /> 🦋 Miroir bilatéral</label>

            <div style={{ fontSize: 10, color: '#ff8c3c', textTransform: 'uppercase', letterSpacing: 1, margin: '10px 0 6px' }}>Déformateurs</div>
            <Field label={`Torsion — ${org.twist.toFixed(2)}`}><input type="range" min={-3.5} max={3.5} step={0.05} value={org.twist} onChange={(e) => setOrgP('twist', +e.target.value)} style={rngStyle} /></Field>
            <Field label={`Effilé — ${org.taper.toFixed(2)}`}><input type="range" min={-0.8} max={0.8} step={0.02} value={org.taper} onChange={(e) => setOrgP('taper', +e.target.value)} style={rngStyle} /></Field>
            <Field label={`Courbure — ${org.bend.toFixed(2)}`}><input type="range" min={-1.2} max={1.2} step={0.02} value={org.bend} onChange={(e) => setOrgP('bend', +e.target.value)} style={rngStyle} /></Field>
            <Field label={`Bruit organique — ${org.noiseAmp.toFixed(3)}`}><input type="range" min={0} max={0.09} step={0.003} value={org.noiseAmp} onChange={(e) => setOrgP('noiseAmp', +e.target.value)} style={rngStyle} /></Field>
            {org.noiseAmp > 0 && <>
              <Field label="Type de bruit"><select value={org.noiseType} onChange={(e) => setOrgP('noiseType', e.target.value as OrganicParams['noiseType'])} style={selStyle}>{[['fbm', '🌫 Fractal'], ['ridged', '⛰ Crêtes'], ['turbulence', '🌀 Turbulence'], ['worley', '🫧 Cellulaire'], ['value', '▫ Simple']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
              <Field label={`Grain — ${org.noiseFreq.toFixed(1)}`}><input type="range" min={0.5} max={8} step={0.5} value={org.noiseFreq} onChange={(e) => setOrgP('noiseFreq', +e.target.value)} style={rngStyle} /></Field>
            </>}

            <div style={{ fontSize: 10, color: '#ff8c3c', textTransform: 'uppercase', letterSpacing: 1, margin: '10px 0 6px' }}>Définition</div>
            <Field label={`Résolution — ${org.res}${org.res >= 110 ? ' (lent)' : ''}`}><input type="range" min={40} max={140} step={4} value={org.res} onChange={(e) => setOrgP('res', +e.target.value)} style={rngStyle} /></Field>
            <Field label={`Lissage — ${orgSmooth}`}><input type="range" min={0} max={4} step={1} value={orgSmooth} onChange={(e) => setOrgSmooth(+e.target.value)} style={rngStyle} /></Field>
            {/* Progression réelle : le worker remonte l'avancement de l'échantillonnage
                du champ puis de la polygonisation (pas une animation décorative). */}
            <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.1)', overflow: 'hidden', margin: '6px 0 4px' }}>
              <div style={{ height: '100%', width: `${orgBusy ? orgProgress : 100}%`, background: orgBusy ? 'linear-gradient(90deg,#6fe0c8,#a078ff)' : 'rgba(120,220,200,0.5)', transition: 'width 120ms linear' }} />
            </div>
            <p style={{ color: orgBusy ? '#ffcf9a' : '#7a6a58', fontSize: 10, margin: '0 0 6px', lineHeight: 1.35 }}>{orgBusy ? `⏳ Génération — ${orgProgress} %` : `✓ ${orgTris.toLocaleString('fr-FR')} triangles · exportable en STL/GLB`}</p>
            <button onClick={() => { adoptRef.current = true; setMode('sculpt') }} disabled={orgBusy || orgTris === 0} style={{ ...selStyle, marginBottom: 4, fontSize: 12, opacity: orgBusy || orgTris === 0 ? 0.5 : 1, background: 'rgba(255,140,60,0.22)', borderColor: 'rgba(255,140,60,0.55)' }} title="Bascule cette forme générée dans le mode Sculpter : tu peux ensuite l'étirer, la pincer, la lisser à la main ou à la souris.">🖐️ Sculpter cette forme</button>
            <p style={{ color: '#7a6a58', fontSize: 10, margin: 0, lineHeight: 1.35 }}>La forme générée devient de la pâte : tous les outils de modelage s'y appliquent. L'historique repart à zéro (la topologie change).</p>
          </>}

          {mode !== 'organic' && <>
          <div style={{ fontSize: 10, color: '#ff8c3c', textTransform: 'uppercase', letterSpacing: 1, margin: '12px 0 6px' }}>Texture de surface</div>
          <Field label="Finition globale (tout d'un coup)"><select value={surfPattern} onChange={(e) => setSurfPattern(e.target.value as SurfPattern)} style={selStyle}>{SURF_PATTERNS.map((s) => <option key={s.kind} value={s.kind}>{s.label}</option>)}</select></Field>
          <Field label={`Échelle du motif — ${Math.round(texScale * 100)}%`}><input type="range" min={0.1} max={1} step={0.05} value={texScale} onChange={(e) => setTexScale(+e.target.value)} style={rngStyle} /></Field>
          <Field label={`Profondeur du relief — ${Math.round(texDepth * 100)}%`}><input type="range" min={0} max={1} step={0.05} value={texDepth} onChange={(e) => setTexDepth(+e.target.value)} style={rngStyle} /></Field>
          <button onClick={() => { clearTexRef.current = true }} style={{ ...selStyle, marginBottom: 4, fontSize: 12 }}>🧽 Effacer la texture</button>
          <p style={{ color: '#7a6a58', fontSize: 10, margin: '4px 0 0', lineHeight: 1.35 }}>Astuce : choisis un outil ⋮⋮/🪨/〰 ci-dessus pour graver le motif <b>à la main</b> localement.</p>
          </>}

          <div style={{ fontSize: 10, color: '#ff8c3c', textTransform: 'uppercase', letterSpacing: 1, margin: '12px 0 6px' }}>Matière</div>
          <Field label="Matériau"><select value={material} onChange={(e) => setMaterial(e.target.value as MatKind)} style={selStyle}>{MATERIALS.map((m) => <option key={m.kind} value={m.kind}>{m.label}</option>)}</select></Field>
          <Field label={mode === 'morph' ? 'Couleurs (dégradé par profondeur)' : 'Couleur'}><div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><input type="color" value={colorA} onChange={(e) => setColorA(e.target.value)} style={{ width: 40, height: 30, border: 'none', background: 'none', cursor: 'pointer' }} />{mode === 'morph' && <input type="color" value={colorB} onChange={(e) => setColorB(e.target.value)} style={{ width: 40, height: 30, border: 'none', background: 'none', cursor: 'pointer' }} />}</div></Field>
          <label style={chkRow}><input type="checkbox" checked={showSkeleton} onChange={(e) => setShowSkeleton(e.target.checked)} style={{ accentColor: '#ff8c3c' }} /> ✋ Squelette des mains</label>
          <Field label="Fond"><select value={bgMode} onChange={(e) => setBgMode(e.target.value as 'webcam' | 'black')} style={selStyle}><option value="black">⬛ Noir</option><option value="webcam">📷 Webcam</option></select></Field>

          <div style={{ fontSize: 10, color: '#ff8c3c', textTransform: 'uppercase', letterSpacing: 1, margin: '12px 0 6px' }}>Export</div>
          <button onClick={() => { recording ? recCtl.current?.stop() : recCtl.current?.start() }} style={{ ...selStyle, marginBottom: 8, background: recording ? 'rgba(255,40,60,0.35)' : 'rgba(255,255,255,0.1)', borderColor: recording ? '#ff2840' : 'rgba(255,255,255,0.2)' }}>{recording ? '⏹ Arrêter l\'enregistrement' : '🔴 Enregistrer une vidéo'}</button>
          <div style={{ display: 'flex', gap: 8 }}><button onClick={exportPng} style={{ ...selStyle, flex: 1 }}>📸 PNG</button><button onClick={() => { exportRef.current = 'glb' }} style={{ ...selStyle, flex: 1 }}>🗿 .glb</button><button onClick={() => { exportRef.current = 'stl' }} style={{ ...selStyle, flex: 1 }} title="Maillage pour impression 3D">🖨️ .stl</button></div>
          <p style={{ color: '#7a6a58', fontSize: 10, marginTop: 10, marginBottom: 0, lineHeight: 1.4 }}>Souris : glisser = orbiter · molette = zoom.</p>
        </div>
      )}
    </div>
  )
}

function downloadBlob(blob: Blob, name: string) { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1500) }
const selStyle: React.CSSProperties = { width: '100%', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', color: 'white', padding: 8, borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: 13 }
const rngStyle: React.CSSProperties = { width: '100%', accentColor: '#ff8c3c' }
const chkRow: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: '#ece2d8', marginTop: 8, marginBottom: 8, cursor: 'pointer' }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return (<div style={{ marginBottom: 12 }}><div style={{ fontSize: 11, color: '#ff8c3c', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5 }}>{label}</div>{children}</div>) }
