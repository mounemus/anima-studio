/**
 * MORPHOGENESIS STUDIO — atelier de création 3D générative nodale (MVP fonctionnel).
 *
 * Pipeline RÉEL : un graphe de nœuds produit un champ scalaire (SDF / TPMS / voronoï /
 * metaballs + bruit + booléens + transformations) → marching cubes → maillage → lissage
 * → sortie. Modes Simple (presets + curseurs + variantes) et Expert (graphe nodal complet).
 * Export STL / OBJ / GLB, analyse de fabrication, historique annuler/rétablir, sauvegarde locale.
 *
 * Route /morpho, protégée par FrontGate.
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import * as THREE from 'three'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { NODE_DEFS, NODE_CATS, evalGraph, makeNode, uid, type Graph, type GNode } from './graph'
import { analyze, repair, type MeshStats } from './mesh'
import { PRESETS } from './presets'
import { textToGraph, llmToGraph, applyCommand, QUICK_COMMANDS, EXAMPLE_PROMPTS, type Built } from './assistant'
import { importFile } from './imports'

const clamp = (a: number, b: number, v: number) => Math.max(a, Math.min(b, v))
type MatKind = 'clay' | 'matte' | 'chrome' | 'gloss' | 'translucent'
const MATERIALS: { kind: MatKind; label: string }[] = [
  { kind: 'clay', label: '🟫 Argile' }, { kind: 'matte', label: '⚪ Mat' }, { kind: 'chrome', label: '🪞 Chrome' }, { kind: 'gloss', label: '⚫ Noir brillant' }, { kind: 'translucent', label: '🧊 Translucide' },
]
const SOCK_COL: Record<string, string> = { field: '#8b6df0', mesh: '#f2c14e', points: '#4fd1a5', number: '#5aa9e6' }

function makeMaterial(kind: MatKind): THREE.Material {
  switch (kind) {
    case 'chrome': return new THREE.MeshStandardMaterial({ color: 0xdfe6ee, metalness: 1, roughness: 0.12, side: THREE.DoubleSide })
    case 'gloss': return new THREE.MeshStandardMaterial({ color: 0x0a0a0c, metalness: 0.4, roughness: 0.12, side: THREE.DoubleSide })
    case 'matte': return new THREE.MeshStandardMaterial({ color: 0xc9ccd2, metalness: 0.02, roughness: 0.85, side: THREE.DoubleSide })
    case 'translucent': return new THREE.MeshPhysicalMaterial({ color: 0x9fd4ec, metalness: 0, roughness: 0.22, transmission: 0.55, thickness: 1.2, ior: 1.33, attenuationColor: new THREE.Color(0x5fa8d8), attenuationDistance: 1.4, clearcoat: 0.6, clearcoatRoughness: 0.25, envMapIntensity: 1.2, transparent: true, opacity: 0.72, side: THREE.FrontSide })
    case 'clay': default: return new THREE.MeshStandardMaterial({ color: 0xc8946a, metalness: 0, roughness: 0.8, side: THREE.DoubleSide })
  }
}

export function MorphogenesisStudio() {
  const mountRef = useRef<HTMLDivElement>(null)
  const [graph, setGraph] = useState<Graph>(() => PRESETS[0].build())
  const [mode, setMode] = useState<'simple' | 'expert'>('simple')
  const [selId, setSelId] = useState<string | null>(null)
  const [material, setMaterial] = useState<MatKind>('clay')
  const [wireframe, setWireframe] = useState(false)
  const [stats, setStats] = useState<MeshStats | null>(null)
  const [computing, setComputing] = useState(false)
  const [status, setStatus] = useState('Prêt.')
  const [variants, setVariants] = useState<{ graph: Graph; thumb: string }[]>([])
  const [addMenu, setAddMenu] = useState(false)
  const [repairExport, setRepairExport] = useState(true)
  const [aiInput, setAiInput] = useState('')
  const [aiLog, setAiLog] = useState<{ role: 'you' | 'ai'; text: string }[]>([{ role: 'ai', text: 'Décris une forme et je construis le graphe. Ex : « coquille spiralée translucide à nervures fractales ».' }])

  const graphRef = useRef(graph); graphRef.current = graph
  const applyRef = useRef<((g: THREE.BufferGeometry | null) => void) | null>(null)
  const renderThumbRef = useRef<((g: Graph) => string) | null>(null)
  const matRef = useRef(material); matRef.current = material
  const wireRef = useRef(wireframe); wireRef.current = wireframe
  const exportRef = useRef<null | 'stl' | 'obj' | 'glb' | 'png'>(null)
  const hist = useRef<{ past: Graph[]; future: Graph[] }>({ past: [], future: [] })
  const workerRef = useRef<Worker | null>(null)
  const reqCounter = useRef(0), proxyReqId = useRef(0)

  const pushHist = useCallback((g: Graph) => { hist.current.past.push(JSON.parse(JSON.stringify(graphRef.current))); if (hist.current.past.length > 40) hist.current.past.shift(); hist.current.future = []; setGraph(g) }, [])
  const undo = () => { const h = hist.current; if (!h.past.length) return; h.future.push(JSON.parse(JSON.stringify(graphRef.current))); setGraph(h.past.pop()!) }
  const redo = () => { const h = hist.current; if (!h.future.length) return; h.past.push(JSON.parse(JSON.stringify(graphRef.current))); setGraph(h.future.pop()!) }

  // ── Three viewport ──
  useEffect(() => {
    const mount = mountRef.current!
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x111318)
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100)
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.5
    mount.appendChild(renderer.domElement); renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;touch-action:none;user-select:none'
    // Environment (IBL) — REQUIRED for translucent glass & metallic materials to be visible
    // (transmission/reflection sample the environment ; without it they render black/invisible).
    const pmrem = new THREE.PMREMGenerator(renderer); pmrem.compileEquirectangularShader()
    let envTex: THREE.Texture | null = null
    try { const roomEnv = new RoomEnvironment(); envTex = pmrem.fromScene(roomEnv, 0.04).texture; scene.environment = envTex } catch { /* noop */ }
    scene.add(new THREE.HemisphereLight(0xffffff, 0x2a3040, 1.3))
    const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(3, 5, 4); scene.add(key)
    const fill = new THREE.DirectionalLight(0xbcd6ff, 1.0); fill.position.set(-4, 1, -3); scene.add(fill)
    const back = new THREE.DirectionalLight(0xffffff, 0.8); back.position.set(0, -3, -4); scene.add(back)
    const grid = new THREE.GridHelper(6, 24, 0x2a3040, 0x1c212c); grid.position.y = -1.6; scene.add(grid)
    let mesh = new THREE.Mesh(new THREE.BufferGeometry(), makeMaterial(matRef.current)); scene.add(mesh)

    let dist = 4.2, az = 0.5, pol = 1.15
    const target = new THREE.Vector3(0, 0, 0)
    // Render-on-demand : only repaint when something actually changed (camera, geometry,
    // material, resize, gesture). Idle GPU cost → ~0 (big win on tablets / long installs).
    let dirty = true
    const invalidate = () => { dirty = true }
    const applyCam = () => { const sp = Math.sin(pol); camera.position.set(target.x + dist * sp * Math.sin(az), target.y + dist * Math.cos(pol), target.z + dist * sp * Math.cos(az)); camera.lookAt(target); invalidate() }
    const resize = () => { const w = mount.clientWidth, h = mount.clientHeight; renderer.setSize(w, h, false); camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix(); invalidate() }
    const ro = new ResizeObserver(resize); ro.observe(mount); resize(); applyCam()
    // Pan the look-at target across the camera's screen plane (two-finger drag).
    const panScreen = (dx: number, dy: number) => { camera.updateMatrixWorld(); const h = mount.clientHeight || 1; const wpp = (2 * dist * Math.tan((camera.fov * Math.PI / 180) / 2)) / h; const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0); const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1); target.addScaledVector(right, -dx * wpp); target.addScaledVector(up, dy * wpp) }
    // Unified mouse + touch : 1 pointer = orbit, 2 pointers = pinch-zoom + pan.
    const ptrs = new Map<number, { x: number; y: number }>()
    let pinchD = 0, midX = 0, midY = 0
    const dn = (e: PointerEvent) => { (e.target as Element).setPointerCapture?.(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (ptrs.size === 2) { const p = [...ptrs.values()]; pinchD = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); midX = (p[0].x + p[1].x) / 2; midY = (p[0].y + p[1].y) / 2 } }
    const mv = (e: PointerEvent) => { const prev = ptrs.get(e.pointerId); if (!prev) return; ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (ptrs.size >= 2) { const p = [...ptrs.values()]; const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); const mx = (p[0].x + p[1].x) / 2, my = (p[0].y + p[1].y) / 2; if (pinchD > 0) dist = clamp(1.6, 12, dist * (pinchD / Math.max(1, d))); panScreen(mx - midX, my - midY); pinchD = d; midX = mx; midY = my; applyCam() }
      else { az -= (e.clientX - prev.x) * 0.006; pol = clamp(0.2, 2.9, pol - (e.clientY - prev.y) * 0.006); applyCam() } }
    const up = (e: PointerEvent) => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinchD = 0 }
    const wh = (e: WheelEvent) => { dist = clamp(1.6, 12, dist + e.deltaY * 0.003); applyCam() }
    const el = renderer.domElement
    el.addEventListener('pointerdown', dn); el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up); el.addEventListener('wheel', wh, { passive: true })

    const fit = (g: THREE.BufferGeometry) => { g.computeBoundingBox(); const bb = g.boundingBox!; const c = bb.getCenter(new THREE.Vector3()), s = bb.getSize(new THREE.Vector3()); const ext = Math.max(s.x, s.y, s.z, 0.01); const sc = 2.6 / ext; mesh.scale.setScalar(sc); mesh.position.set(-c.x * sc, -c.y * sc, -c.z * sc) }
    applyRef.current = (g) => { mesh.geometry.dispose(); mesh.geometry = g ?? new THREE.BufferGeometry(); if (g) fit(g); invalidate() }

    // offscreen thumbnail renderer (reuses this renderer)
    renderThumbRef.current = (gr: Graph) => {
      const geo = evalGraph(gr, 'proxy'); if (!geo) return ''
      const tScene = new THREE.Scene(); tScene.background = new THREE.Color(0x14171d)
      tScene.add(new THREE.HemisphereLight(0xffffff, 0x202430, 1.1)); const l = new THREE.DirectionalLight(0xffffff, 1.4); l.position.set(3, 5, 4); tScene.add(l)
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xc8946a, roughness: 0.8, side: THREE.DoubleSide }))
      geo.computeBoundingBox(); const bb = geo.boundingBox!; const c = bb.getCenter(new THREE.Vector3()), s = bb.getSize(new THREE.Vector3()); const sc = 2.6 / Math.max(s.x, s.y, s.z, 0.01); m.scale.setScalar(sc); m.position.set(-c.x * sc, -c.y * sc, -c.z * sc); tScene.add(m)
      const tCam = new THREE.PerspectiveCamera(45, 1, 0.01, 100); tCam.position.set(2.4, 2, 3); tCam.lookAt(0, 0, 0)
      const prevSize = new THREE.Vector2(); renderer.getSize(prevSize)
      renderer.setSize(120, 120, false); renderer.render(tScene, tCam)
      const url = renderer.domElement.toDataURL('image/png')
      renderer.setSize(prevSize.x, prevSize.y, false); geo.dispose(); m.material.dispose()
      invalidate()   // the shared canvas showed the thumbnail scene → repaint the main view
      return url
    }

    // Render-on-demand loop : the rAF tick is nearly free when idle; it only issues a GPU
    // draw when `dirty`. Material / wireframe changes (driven by React refs) are detected
    // here each tick and flip `dirty` — replaces the old 120 ms polling interval.
    let raf = 0
    const loop = () => {
      if ((mesh.material as any).__k !== matRef.current) { mesh.material.dispose(); mesh.material = makeMaterial(matRef.current); (mesh.material as any).__k = matRef.current; dirty = true }
      if ((mesh.material as any).wireframe !== wireRef.current) { (mesh.material as any).wireframe = wireRef.current; dirty = true }
      if (dirty) { dirty = false; renderer.render(scene, camera) }
      raf = requestAnimationFrame(loop)
    }
    loop()

    return () => { cancelAnimationFrame(raf); ro.disconnect(); el.removeEventListener('pointerdown', dn); el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); el.removeEventListener('wheel', wh); mesh.geometry.dispose(); envTex?.dispose(); pmrem.dispose(); renderer.dispose(); if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement); applyRef.current = null; renderThumbRef.current = null }
  }, [])

  // ── Worker : evaluate the graph off the main thread (HD never freezes the UI) ──
  useEffect(() => {
    let w: Worker | null = null
    try { w = new Worker(new URL('./graph.worker.ts', import.meta.url), { type: 'module' }) } catch { w = null }
    workerRef.current = w
    if (w) w.onmessage = (e: MessageEvent) => {
      const d = e.data
      if (d.kind === 'proxy' && d.id !== proxyReqId.current) return   // ignore stale proxy results
      setComputing(false)
      if (d.error) { setStatus('Erreur de calcul : ' + d.error); return }
      if (d.empty) { applyRef.current?.(null); setStats(null); setStatus('Aucune sortie — connecte un nœud à « Sortie ».'); return }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(d.position as Float32Array, 3))
      if (d.index) g.setIndex(new THREE.BufferAttribute(d.index as Uint32Array, 1))
      if (d.normal) g.setAttribute('normal', new THREE.BufferAttribute(d.normal as Float32Array, 3)); else g.computeVertexNormals()
      applyRef.current?.(g); setStats(d.stats); setStatus(d.kind === 'hd' ? 'Haute résolution ✓' : 'Aperçu (proxy) ✓')
    }
    return () => { w?.terminate(); workerRef.current = null }
  }, [])

  const requestEval = (kind: 'proxy' | 'hd') => {
    const id = ++reqCounter.current; if (kind === 'proxy') proxyReqId.current = id
    setComputing(true)
    const w = workerRef.current
    if (w) { w.postMessage({ id, kind, graph: graphRef.current, quality: kind }) }
    else setTimeout(() => { try { const g = evalGraph(graphRef.current, kind); if (kind === 'proxy' && id !== proxyReqId.current) return; applyRef.current?.(g); setStats(g ? analyze(g) : null); setStatus(g ? (kind === 'hd' ? 'Haute résolution ✓' : 'Aperçu (proxy) ✓') : 'Aucune sortie.') } catch (e) { setStatus('Erreur : ' + (e as Error).message) } setComputing(false) }, 10)
  }

  // Recompute (debounced proxy) whenever the graph changes.
  useEffect(() => { const t = setTimeout(() => requestEval('proxy'), 45); return () => clearTimeout(t) }, [graph])
  const computeHD = () => { setStatus('Calcul haute résolution…'); requestEval('hd') }

  // export (needs the current viewport mesh geometry → recompute HD)
  useEffect(() => { if (!exportRef.current) return; const fmt = exportRef.current; exportRef.current = null; let geo = evalGraph(graphRef.current, 'hd'); if (!geo) { setStatus('Rien à exporter.'); return }; let fixNote = ''; if (repairExport) { const before = analyze(geo).openEdges; geo = repair(geo, { smooth: 1 }); const after = analyze(geo).openEdges; fixNote = ` · maillage réparé (${before}→${after} bords ouverts)` }; const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ side: THREE.DoubleSide })); if (fmt === 'stl') dl(new Blob([new STLExporter().parse(m, { binary: false })], { type: 'model/stl' }), 'morpho.stl'); else if (fmt === 'obj') dl(new Blob([new OBJExporter().parse(m)], { type: 'text/plain' }), 'morpho.obj'); else if (fmt === 'glb') new GLTFExporter().parse(m, (r) => dl(new Blob([r as ArrayBuffer], { type: 'model/gltf-binary' }), 'morpho.glb'), () => setStatus('Échec GLB'), { binary: true }); setStatus(`Export ${fmt.toUpperCase()} ✓${fixNote}`) })

  // ── Morphospace : 8 mutated variants with thumbnails ──
  const mutateGraph = (g: Graph, amount: number): Graph => {
    const ng: Graph = JSON.parse(JSON.stringify(g)); const rnd = () => (Math.random() * 2 - 1) * amount
    for (const n of ng.nodes) { const def = NODE_DEFS[n.type]; for (const pr of def.params) { if (pr.type === 'seed') n.params[pr.key] = Math.floor(Math.random() * 9999) + 1; else if (pr.type === 'num' && pr.min !== undefined && pr.max !== undefined) { const cur = (n.params[pr.key] as number); n.params[pr.key] = clamp(pr.min, pr.max, cur + rnd() * (pr.max - pr.min)) } } }
    return ng
  }
  const genVariants = () => { setStatus('Génération des variantes…'); setTimeout(() => { const vs: { graph: Graph; thumb: string }[] = []; for (let i = 0; i < 8; i++) { const g = i === 0 ? graphRef.current : mutateGraph(graphRef.current, 0.35); vs.push({ graph: g, thumb: renderThumbRef.current?.(g) ?? '' }) } setVariants(vs); setStatus('8 variantes générées.') }, 20) }
  const mutate = () => pushHist(mutateGraph(graphRef.current, 0.3))

  const loadPreset = (i: number) => { pushHist(PRESETS[i].build()); setSelId(null); setVariants([]) }
  const importInputRef = useRef<HTMLInputElement>(null)
  const onImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return; e.target.value = ''
    setStatus(`Import de ${f.name}…`)
    try {
      const { data, name, tris } = await importFile(f)
      const mi = makeNode('meshimport', 60, 120); mi.data = data
      const out = makeNode('output', 280, 120)
      pushHist({ nodes: [mi, out], edges: [{ id: uid('e'), from: mi.id, fromIdx: 0, to: out.id, toIdx: 0 }] })
      setSelId(mi.id); setVariants([]); setStatus(`Importé : ${name} (${tris.toLocaleString()} tris). Ajoute « Maillage → champ » pour le rendre organique.`)
    } catch (err) { setStatus('Import échoué : ' + (err as Error).message) }
  }
  const applyBuilt = (b: Built) => { pushHist(b.graph); setSelId(null); setVariants([]); if (b.material) setMaterial(b.material) }
  const aiGenerate = async (prompt: string) => {
    const p = prompt.trim(); if (!p) return; setAiInput('')
    setAiLog((l) => [...l, { role: 'you' as const, text: p }, { role: 'ai' as const, text: '✦ L’IA construit le graphe…' }].slice(-12))
    let b: Built, note = ''
    try { b = await llmToGraph(p) } catch { const lb = textToGraph(p); b = lb; note = '(local) ' }   // fallback déterministe hors-ligne / sans clé
    applyBuilt(b)
    setAiLog((l) => { const c = [...l]; c[c.length - 1] = { role: 'ai', text: note + b.explain.join(' ') }; return c })
  }
  const aiCommand = (cmd: string) => { const b = applyCommand(cmd, graphRef.current); applyBuilt(b); setAiLog((l) => [...l, { role: 'you' as const, text: cmd }, { role: 'ai' as const, text: b.explain.join(' ') }].slice(-12)) }
  const selNode = graph.nodes.find((n) => n.id === selId) ?? null
  const setNodeParam = (id: string, key: string, val: number | string) => { setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === id ? { ...n, params: { ...n.params, [key]: val } } : n)) })) }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0c0e12', color: '#dfe3ea', fontFamily: 'system-ui', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Top bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 14px', borderBottom: '1px solid #20252f', background: '#0f1218' }}>
        <strong style={{ color: '#9fb4d6', letterSpacing: 1 }}>◇ MORPHOGENESIS</strong>
        <span style={{ fontSize: 11, color: '#6b7385' }}>Studio génératif</span>
        <div style={{ display: 'flex', gap: 4, marginLeft: 8 }}>
          <button onClick={() => setMode('simple')} style={{ ...tab, ...(mode === 'simple' ? tabOn : {}) }}>Simple</button>
          <button onClick={() => setMode('expert')} style={{ ...tab, ...(mode === 'expert' ? tabOn : {}) }}>Expert</button>
        </div>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: computing ? '#f2c14e' : '#6b7385' }}>{computing ? '⏳ calcul…' : status}</span>
        <button onClick={undo} style={btn} title="Annuler">↶</button>
        <button onClick={redo} style={btn} title="Rétablir">↷</button>
        <button onClick={mutate} style={{ ...btn, borderColor: '#8b6df0' }}>🧬 Muter</button>
        <button onClick={computeHD} style={{ ...btn, borderColor: '#4fd1a5' }}>⬆ HD</button>
        <input ref={importInputRef} type="file" accept=".stl,.obj,.svg" onChange={onImport} style={{ display: 'none' }} />
        <button onClick={() => importInputRef.current?.click()} style={{ ...btn, borderColor: '#e6e05a' }} title="Importer un maillage STL/OBJ ou un contour SVG">⬇ Import</button>
        <button onClick={() => setRepairExport((v) => !v)} title="Avant export : souder les sommets, boucher les trous (maillage étanche imprimable) et lisser la surface" style={{ ...btn, borderColor: repairExport ? '#4fd1a5' : '#2a3140', background: repairExport ? '#16241f' : '#161a22', color: repairExport ? '#7ee7c0' : '#8a93a5' }}>{repairExport ? '🔧 Réparer & lisser ✓' : '🔧 Réparer & lisser'}</button>
        <button onClick={() => { exportRef.current = 'stl'; setGraph((g) => ({ ...g })) }} style={btn}>STL</button>
        <button onClick={() => { exportRef.current = 'glb'; setGraph((g) => ({ ...g })) }} style={btn}>GLB</button>
        <button onClick={() => { exportRef.current = 'obj'; setGraph((g) => ({ ...g })) }} style={btn}>OBJ</button>
        <Link to="/" style={{ color: '#7a8296', fontSize: 12, textDecoration: 'none', marginLeft: 4 }}>← Studio</Link>
      </div>

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* Left panel */}
        <div style={{ width: 262, borderRight: '1px solid #20252f', padding: 12, overflowY: 'auto', background: '#0f1218' }}>
          {/* Assistant IA texte → graphe */}
          <div style={{ background: 'linear-gradient(180deg,#171b26,#12151c)', border: '1px solid #2a2f52', borderRadius: 10, padding: 10, marginBottom: 14 }}>
            <div style={{ ...hdr, marginBottom: 6, color: '#a99cff' }}>✦ Assistant IA</div>
            <div style={{ maxHeight: 118, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 7 }}>
              {aiLog.map((m, i) => (<div key={i} style={{ fontSize: 10.5, lineHeight: 1.35, alignSelf: m.role === 'you' ? 'flex-end' : 'flex-start', maxWidth: '92%', background: m.role === 'you' ? '#2a2f52' : '#1a1f28', color: m.role === 'you' ? '#dfe3ff' : '#c3cad6', padding: '4px 7px', borderRadius: 7 }}>{m.text}</div>))}
            </div>
            <textarea value={aiInput} onChange={(e) => setAiInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); aiGenerate(aiInput) } }} placeholder="Décris une forme…" rows={2} style={{ width: '100%', resize: 'none', background: '#0c0e14', border: '1px solid #2a3140', color: '#dfe3ea', borderRadius: 6, padding: 6, fontSize: 11, fontFamily: 'inherit' }} />
            <button onClick={() => aiGenerate(aiInput)} style={{ ...card, width: '100%', margin: '6px 0 4px', borderColor: '#8b6df0', background: '#241f3a' }}>✦ Générer le graphe</button>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>{EXAMPLE_PROMPTS.slice(0, 3).map((p) => <button key={p} onClick={() => aiGenerate(p)} style={ex}>{p.length > 26 ? p.slice(0, 24) + '…' : p}</button>)}</div>
            <div style={{ fontSize: 9, color: '#6b7385', textTransform: 'uppercase', letterSpacing: 1, margin: '2px 0 3px' }}>Commandes</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>{QUICK_COMMANDS.map((c) => <button key={c} onClick={() => aiCommand(c)} style={ex}>{c}</button>)}</div>
          </div>
          {mode === 'simple' ? <>
            <div style={hdr}>Systèmes génératifs</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 6 }}>{PRESETS.map((pr, i) => (<button key={pr.name} onClick={() => loadPreset(i)} title={pr.desc} style={{ ...card, textAlign: 'left' }}><b>{pr.name}</b><div style={{ fontSize: 10, color: '#78808f', marginTop: 2, lineHeight: 1.3 }}>{pr.desc}</div></button>))}</div>
            <div style={{ ...hdr, marginTop: 16 }}>Réglages</div>
            {graph.nodes.filter((n) => n.type !== 'output' && NODE_DEFS[n.type].params.length).map((n) => (
              <div key={n.id} style={{ marginBottom: 10, borderLeft: `2px solid ${NODE_DEFS[n.type].color}`, paddingLeft: 8 }}>
                <div style={{ fontSize: 11, color: '#aeb6c6', marginBottom: 3 }}>{NODE_DEFS[n.type].title}</div>
                {NODE_DEFS[n.type].params.map((pr) => <ParamCtl key={pr.key} node={n} pr={pr} onChange={(v) => setNodeParam(n.id, pr.key, v)} />)}
              </div>
            ))}
          </> : <>
            <div style={hdr}>Ajouter un nœud</div>
            <button onClick={() => setAddMenu((v) => !v)} style={{ ...card, width: '100%' }}>＋ Palette de nœuds</button>
            {addMenu && <div style={{ marginTop: 6 }}>{NODE_CATS.map((cat) => (<div key={cat} style={{ marginBottom: 6 }}><div style={{ fontSize: 10, color: '#6b7385', textTransform: 'uppercase', margin: '4px 0' }}>{cat}</div>{Object.values(NODE_DEFS).filter((d) => d.cat === cat).map((d) => (<button key={d.type} onClick={() => { const nn = makeNode(d.type, 120 + Math.random() * 60, 120 + Math.random() * 60); pushHist({ ...graph, nodes: [...graph.nodes, nn] }); setSelId(nn.id) }} style={{ ...chip, borderColor: d.color }}>{d.title}</button>))}</div>))}</div>}
            <div style={{ ...hdr, marginTop: 14 }}>Graphe</div>
            <button onClick={() => { const json = JSON.stringify(graph); dl(new Blob([json], { type: 'application/json' }), 'graph.json') }} style={{ ...card, width: '100%' }}>⬇ Exporter le graphe (JSON)</button>
            <p style={{ fontSize: 10, color: '#6b7385', marginTop: 8, lineHeight: 1.4 }}>Glisse les nœuds, tire d'une sortie vers une entrée pour connecter. Clique un nœud pour ses paramètres.</p>
          </>}
        </div>

        {/* Center : viewport + node editor */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div ref={mountRef} style={{ flex: mode === 'expert' ? '1 1 55%' : 1, minHeight: 0, position: 'relative' }}>
            <div style={{ position: 'absolute', left: 10, bottom: 8, display: 'flex', gap: 6, zIndex: 2 }}>
              {MATERIALS.map((m) => <button key={m.kind} onClick={() => setMaterial(m.kind)} style={{ ...pill, ...(material === m.kind ? pillOn : {}) }}>{m.label}</button>)}
              <button onClick={() => setWireframe((v) => !v)} style={{ ...pill, ...(wireframe ? pillOn : {}) }}>▦ Fil</button>
            </div>
          </div>
          {mode === 'expert' && <div style={{ flex: '1 1 45%', borderTop: '1px solid #20252f', minHeight: 160 }}><NodeCanvas graph={graph} setGraph={setGraph} pushHist={pushHist} selId={selId} setSelId={setSelId} /></div>}
        </div>

        {/* Right panel */}
        <div style={{ width: 250, borderLeft: '1px solid #20252f', padding: 12, overflowY: 'auto', background: '#0f1218' }}>
          {selNode ? <>
            <div style={hdr}>{NODE_DEFS[selNode.type].title}</div>
            {NODE_DEFS[selNode.type].params.map((pr) => <ParamCtl key={pr.key} node={selNode} pr={pr} onChange={(v) => setNodeParam(selNode.id, pr.key, v)} />)}
            {selNode.type !== 'output' && <button onClick={() => pushHist({ nodes: graph.nodes.filter((n) => n.id !== selNode.id), edges: graph.edges.filter((e) => e.from !== selNode.id && e.to !== selNode.id) })} style={{ ...card, width: '100%', borderColor: '#e0576b', marginTop: 8 }}>🗑 Supprimer</button>}
          </> : <div style={{ fontSize: 11, color: '#6b7385' }}>Sélectionne un nœud (mode Expert) pour ses paramètres.</div>}

          <div style={{ ...hdr, marginTop: 16 }}>Rendu</div>
          <Field l="Matériau"><select value={material} onChange={(e) => setMaterial(e.target.value as MatKind)} style={sel}>{MATERIALS.map((m) => <option key={m.kind} value={m.kind}>{m.label}</option>)}</select></Field>

          <div style={{ ...hdr, marginTop: 16 }}>Analyse (fabrication)</div>
          {stats ? <div style={{ fontSize: 11, lineHeight: 1.7, color: '#aeb6c6' }}>
            <Row k="Triangles" v={stats.tris.toLocaleString()} />
            <Row k="Sommets" v={stats.verts.toLocaleString()} />
            <Row k="Étanche" v={stats.watertight ? '✅ oui' : `⚠ ${stats.openEdges} arêtes`} />
            <Row k="Volume" v={stats.volume.toFixed(3)} />
            <Row k="Surface" v={stats.area.toFixed(2)} />
            <Row k="Dim." v={stats.size.map((s) => s.toFixed(2)).join(' × ')} />
          </div> : <div style={{ fontSize: 11, color: '#6b7385' }}>—</div>}

          <div style={{ ...hdr, marginTop: 16 }}>Morphospace</div>
          <button onClick={genVariants} style={{ ...card, width: '100%', borderColor: '#8b6df0' }}>🎲 Générer 8 variantes</button>
          {variants.length > 0 && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 8 }}>{variants.map((v, i) => (<button key={i} onClick={() => { pushHist(v.graph); setSelId(null) }} title="Adopter cette variante" style={{ padding: 0, border: '1px solid #2a3140', borderRadius: 6, overflow: 'hidden', cursor: 'pointer', background: '#14171d' }}>{v.thumb ? <img src={v.thumb} alt="" style={{ width: '100%', display: 'block' }} /> : <div style={{ height: 96 }} />}</button>))}</div>}
        </div>
      </div>
    </div>
  )
}

// ── Node editor canvas (SVG edges + draggable node boxes, typed connections) ──
function NodeCanvas({ graph, setGraph, pushHist, selId, setSelId }: { graph: Graph; setGraph: (u: (g: Graph) => Graph) => void; pushHist: (g: Graph) => void; selId: string | null; setSelId: (id: string | null) => void }) {
  const NW = 150, HDRH = 26, ROW = 18
  const wrapRef = useRef<HTMLDivElement>(null)
  const [pan, setPan] = useState({ x: 0, y: 0, k: 1 })
  const dragRef = useRef<{ mode: 'node' | 'pan' | 'link' | 'pinch'; id?: string; ox?: number; oy?: number; from?: { id: string; idx: number } } | null>(null)
  const ptrs = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ d: number; mx: number; my: number } | null>(null)
  const [tmpLink, setTmpLink] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const nodeH = (n: GNode) => HDRH + Math.max(NODE_DEFS[n.type].inputs.length, NODE_DEFS[n.type].outputs.length, 1) * ROW + 6
  const outPos = (n: GNode, i: number) => ({ x: n.x + NW, y: n.y + HDRH + i * ROW + ROW / 2 })
  const inPos = (n: GNode, i: number) => ({ x: n.x, y: n.y + HDRH + i * ROW + ROW / 2 })
  const toGraph = (cx: number, cy: number) => { const r = wrapRef.current!.getBoundingClientRect(); return { x: (cx - r.left - pan.x) / pan.k, y: (cy - r.top - pan.y) / pan.k } }

  const onDownNode = (e: React.PointerEvent, id: string) => { e.stopPropagation(); wrapRef.current?.setPointerCapture(e.pointerId); setSelId(id); const n = graph.nodes.find((x) => x.id === id)!; const g = toGraph(e.clientX, e.clientY); dragRef.current = { mode: 'node', id, ox: g.x - n.x, oy: g.y - n.y } }
  const onDownOut = (e: React.PointerEvent, id: string, idx: number) => { e.stopPropagation(); const n = graph.nodes.find((x) => x.id === id)!; const p = outPos(n, idx); dragRef.current = { mode: 'link', from: { id, idx } }; setTmpLink({ x1: p.x, y1: p.y, x2: p.x, y2: p.y }) }
  const onUpIn = (id: string, idx: number) => { const d = dragRef.current; if (d?.mode === 'link' && d.from) { if (d.from.id !== id) { const edges = graph.edges.filter((e) => !(e.to === id && e.toIdx === idx)); pushHist({ ...graph, edges: [...edges, { id: uid('e'), from: d.from.id, fromIdx: d.from.idx, to: id, toIdx: idx }] }) } } dragRef.current = null; setTmpLink(null) }
  const onMove = (e: React.PointerEvent) => {
    if (ptrs.current.has(e.pointerId)) ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const d = dragRef.current; if (!d) return
    // Two-finger pinch : zoom toward the pinch midpoint + pan by its motion.
    if (d.mode === 'pinch' && ptrs.current.size >= 2) { const p = [...ptrs.current.values()]; const dd = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); const mx = (p[0].x + p[1].x) / 2, my = (p[0].y + p[1].y) / 2; const pv = pinch.current; if (pv) { const r = wrapRef.current!.getBoundingClientRect(); const lx = mx - r.left, ly = my - r.top; setPan((pp) => { const k2 = clamp(0.35, 2.2, pp.k * (dd / Math.max(1, pv.d))); const gx = (lx - pp.x) / pp.k, gy = (ly - pp.y) / pp.k; return { k: k2, x: lx - gx * k2 + (mx - pv.mx), y: ly - gy * k2 + (my - pv.my) } }) } pinch.current = { d: dd, mx, my }; return }
    const g = toGraph(e.clientX, e.clientY)
    if (d.mode === 'node' && d.id) setGraph((gr) => ({ ...gr, nodes: gr.nodes.map((n) => (n.id === d.id ? { ...n, x: g.x - d.ox!, y: g.y - d.oy! } : n)) }))
    else if (d.mode === 'pan') { const dx = e.clientX - (d.ox ?? e.clientX), dy = e.clientY - (d.oy ?? e.clientY); d.ox = e.clientX; d.oy = e.clientY; setPan((p) => ({ ...p, x: p.x + dx, y: p.y + dy })) }
    else if (d.mode === 'link') setTmpLink((t) => (t ? { ...t, x2: g.x, y2: g.y } : t))
  }
  const onUp = (e: React.PointerEvent) => { ptrs.current.delete(e.pointerId); const d = dragRef.current; if (d?.mode === 'node') pushHist(graph); if (ptrs.current.size === 1 && d?.mode === 'pinch') { pinch.current = null; const [rem] = [...ptrs.current.values()]; dragRef.current = { mode: 'pan', ox: rem.x, oy: rem.y }; return } if (ptrs.current.size < 2) pinch.current = null; dragRef.current = null; setTmpLink(null) }
  const onDownBg = (e: React.PointerEvent) => { ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY }); wrapRef.current?.setPointerCapture(e.pointerId); if (ptrs.current.size >= 2) { const p = [...ptrs.current.values()]; pinch.current = { d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y), mx: (p[0].x + p[1].x) / 2, my: (p[0].y + p[1].y) / 2 }; dragRef.current = { mode: 'pinch' } } else { dragRef.current = { mode: 'pan', ox: e.clientX, oy: e.clientY }; setSelId(null) } }
  const onWheel = (e: React.WheelEvent) => { const r = wrapRef.current!.getBoundingClientRect(); const lx = e.clientX - r.left, ly = e.clientY - r.top; setPan((p) => { const k2 = clamp(0.35, 2.2, p.k * (e.deltaY < 0 ? 1.1 : 0.9)); const gx = (lx - p.x) / p.k, gy = (ly - p.y) / p.k; return { k: k2, x: lx - gx * k2, y: ly - gy * k2 } }) }
  const bez = (x1: number, y1: number, x2: number, y2: number) => `M${x1},${y1} C${x1 + 60},${y1} ${x2 - 60},${y2} ${x2},${y2}`

  return (
    <div ref={wrapRef} onPointerDown={onDownBg} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onWheel={onWheel} style={{ width: '100%', height: '100%', background: '#0a0c10', overflow: 'hidden', position: 'relative', cursor: 'grab', touchAction: 'none', userSelect: 'none' }}>
      <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
        <g transform={`translate(${pan.x},${pan.y}) scale(${pan.k})`}>
          {graph.edges.map((e) => { const a = graph.nodes.find((n) => n.id === e.from), b = graph.nodes.find((n) => n.id === e.to); if (!a || !b) return null; const p1 = outPos(a, e.fromIdx), p2 = inPos(b, e.toIdx); return <path key={e.id} d={bez(p1.x, p1.y, p2.x, p2.y)} stroke="#4b566b" strokeWidth={2} fill="none" /> })}
          {tmpLink && <path d={bez(tmpLink.x1, tmpLink.y1, tmpLink.x2, tmpLink.y2)} stroke="#8b6df0" strokeWidth={2} fill="none" strokeDasharray="4 3" />}
        </g>
      </svg>
      <div style={{ position: 'absolute', inset: 0, transform: `translate(${pan.x}px,${pan.y}px) scale(${pan.k})`, transformOrigin: '0 0' }}>
        {graph.nodes.map((n) => { const def = NODE_DEFS[n.type]; const sel = n.id === selId; return (
          <div key={n.id} style={{ position: 'absolute', left: n.x, top: n.y, width: NW, height: nodeH(n), background: '#161a22', border: `1.5px solid ${sel ? def.color : '#252b36'}`, borderRadius: 8, boxShadow: sel ? `0 0 0 2px ${def.color}44` : 'none', fontSize: 11 }}>
            <div onPointerDown={(e) => onDownNode(e, n.id)} style={{ height: HDRH, lineHeight: `${HDRH}px`, padding: '0 8px', background: def.color + '22', borderBottom: '1px solid #252b36', borderRadius: '7px 7px 0 0', color: '#e6eaf2', cursor: 'move', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{def.title}</div>
            {def.inputs.map((inp, i) => (<div key={i} style={{ position: 'absolute', left: 0, top: HDRH + i * ROW, height: ROW, display: 'flex', alignItems: 'center' }}><span onPointerUp={() => onUpIn(n.id, i)} style={{ width: 10, height: 10, borderRadius: 5, background: SOCK_COL[inp.type], border: '2px solid #0a0c10', marginLeft: -6, cursor: 'crosshair' }} /><span style={{ marginLeft: 6, color: '#8b94a6' }}>{inp.name}</span></div>))}
            {def.outputs.map((o, i) => (<div key={i} style={{ position: 'absolute', right: 0, top: HDRH + i * ROW, height: ROW, display: 'flex', alignItems: 'center', flexDirection: 'row-reverse' }}><span onPointerDown={(e) => onDownOut(e, n.id, i)} style={{ width: 10, height: 10, borderRadius: 5, background: SOCK_COL[o.type], border: '2px solid #0a0c10', marginRight: -6, cursor: 'crosshair' }} /><span style={{ marginRight: 6, color: '#8b94a6' }}>{o.name}</span></div>))}
          </div>
        ) })}
      </div>
    </div>
  )
}

function ParamCtl({ node, pr, onChange }: { node: GNode; pr: (typeof NODE_DEFS)[string]['params'][number]; onChange: (v: number | string) => void }) {
  const raw = node.params[pr.key] ?? pr.def
  if (pr.type === 'select') return <Field l={pr.label}><select value={String(raw)} onChange={(e) => onChange(e.target.value)} style={sel}>{pr.options!.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select></Field>
  const v = typeof raw === 'number' && Number.isFinite(raw) ? raw : (pr.def as number)
  if (pr.type === 'seed') return <Field l={pr.label}><div style={{ display: 'flex', gap: 6 }}><input type="number" value={v} onChange={(e) => onChange(+e.target.value)} style={{ ...sel, flex: 1 }} /><button onClick={() => onChange(Math.floor(Math.random() * 9999) + 1)} style={{ ...sel, width: 34, cursor: 'pointer' }}>🎲</button></div></Field>
  return <Field l={`${pr.label} — ${v.toFixed(2)}`}><input type="range" min={pr.min} max={pr.max} step={pr.step} value={v} onChange={(e) => onChange(+e.target.value)} style={{ width: '100%', accentColor: '#8b6df0' }} /></Field>
}

function dl(blob: Blob, name: string) { const u = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = u; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(u), 1500) }
function Field({ l, children }: { l: string; children: React.ReactNode }) { return <div style={{ marginBottom: 8 }}><div style={{ fontSize: 10, color: '#7a8296', marginBottom: 3 }}>{l}</div>{children}</div> }
function Row({ k, v }: { k: string; v: string }) { return <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#6b7385' }}>{k}</span><span>{v}</span></div> }
const hdr: React.CSSProperties = { fontSize: 10, color: '#8b6df0', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8, fontWeight: 700 }
const btn: React.CSSProperties = { background: '#1a1f28', borderWidth: 1, borderStyle: 'solid', borderColor: '#2a3140', color: '#dfe3ea', padding: '5px 9px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }
const tab: React.CSSProperties = { background: 'transparent', borderWidth: 1, borderStyle: 'solid', borderColor: '#2a3140', color: '#9aa3b4', padding: '4px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12 }
const tabOn: React.CSSProperties = { background: '#8b6df0', borderColor: '#8b6df0', color: '#fff' }
const card: React.CSSProperties = { background: '#161a22', borderWidth: 1, borderStyle: 'solid', borderColor: '#2a3140', color: '#dfe3ea', padding: 8, borderRadius: 8, cursor: 'pointer', fontSize: 12, marginBottom: 4 }
const chip: React.CSSProperties = { display: 'block', width: '100%', textAlign: 'left', background: '#12151c', borderWidth: 1, borderStyle: 'solid', borderColor: '#2a3140', borderLeftWidth: 3, color: '#cfd5e0', padding: '5px 8px', borderRadius: 5, cursor: 'pointer', fontSize: 11, marginBottom: 3 }
const sel: React.CSSProperties = { width: '100%', background: '#12151c', border: '1px solid #2a3140', color: '#dfe3ea', padding: 6, borderRadius: 6, fontSize: 12 }
const ex: React.CSSProperties = { background: '#1a1f2e', borderWidth: 1, borderStyle: 'solid', borderColor: '#33385a', color: '#b9c0d6', padding: '3px 7px', borderRadius: 999, cursor: 'pointer', fontSize: 10 }
const pill: React.CSSProperties = { background: 'rgba(20,24,32,0.85)', borderWidth: 1, borderStyle: 'solid', borderColor: '#2a3140', color: '#cfd5e0', padding: '4px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 11, backdropFilter: 'blur(6px)' }
const pillOn: React.CSSProperties = { background: '#8b6df0', borderColor: '#8b6df0', color: '#fff' }
