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
import { NODE_DEFS, NODE_CATS, evalGraph, makeNode, uid, type Graph, type GNode } from './graph'
import { analyze, type MeshStats } from './mesh'
import { PRESETS } from './presets'
import { textToGraph, applyCommand, QUICK_COMMANDS, EXAMPLE_PROMPTS, type Built } from './assistant'

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
    case 'translucent': return new THREE.MeshPhysicalMaterial({ color: 0xbcd7e6, metalness: 0, roughness: 0.25, transmission: 0.6, thickness: 0.6, ior: 1.3, side: THREE.DoubleSide })
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
  const [aiInput, setAiInput] = useState('')
  const [aiLog, setAiLog] = useState<{ role: 'you' | 'ai'; text: string }[]>([{ role: 'ai', text: 'Décris une forme et je construis le graphe. Ex : « coquille spiralée translucide à nervures fractales ».' }])

  const graphRef = useRef(graph); graphRef.current = graph
  const applyRef = useRef<((g: THREE.BufferGeometry | null) => void) | null>(null)
  const renderThumbRef = useRef<((g: Graph) => string) | null>(null)
  const matRef = useRef(material); matRef.current = material
  const wireRef = useRef(wireframe); wireRef.current = wireframe
  const exportRef = useRef<null | 'stl' | 'obj' | 'glb' | 'png'>(null)
  const hist = useRef<{ past: Graph[]; future: Graph[] }>({ past: [], future: [] })

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
    mount.appendChild(renderer.domElement); renderer.domElement.style.cssText = 'width:100%;height:100%;display:block'
    scene.add(new THREE.HemisphereLight(0xffffff, 0x202430, 1.0))
    const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(3, 5, 4); scene.add(key)
    const fill = new THREE.DirectionalLight(0x94b8ff, 0.6); fill.position.set(-4, 1, -3); scene.add(fill)
    const grid = new THREE.GridHelper(6, 24, 0x2a3040, 0x1c212c); grid.position.y = -1.6; scene.add(grid)
    let mesh = new THREE.Mesh(new THREE.BufferGeometry(), makeMaterial(matRef.current)); scene.add(mesh)

    let dist = 4.2, az = 0.5, pol = 1.15
    const applyCam = () => { const sp = Math.sin(pol); camera.position.set(dist * sp * Math.sin(az), dist * Math.cos(pol), dist * sp * Math.cos(az)); camera.lookAt(0, 0, 0) }
    const resize = () => { const w = mount.clientWidth, h = mount.clientHeight; renderer.setSize(w, h, false); camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix() }
    const ro = new ResizeObserver(resize); ro.observe(mount); resize(); applyCam()
    let drag = false, lx = 0, ly = 0
    const dn = (e: PointerEvent) => { drag = true; lx = e.clientX; ly = e.clientY }
    const mv = (e: PointerEvent) => { if (!drag) return; az -= (e.clientX - lx) * 0.006; pol = clamp(0.2, 2.9, pol - (e.clientY - ly) * 0.006); lx = e.clientX; ly = e.clientY; applyCam() }
    const up = () => { drag = false }
    const wh = (e: WheelEvent) => { dist = clamp(1.6, 12, dist + e.deltaY * 0.003); applyCam() }
    renderer.domElement.addEventListener('pointerdown', dn); window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); renderer.domElement.addEventListener('wheel', wh, { passive: true })

    const fit = (g: THREE.BufferGeometry) => { g.computeBoundingBox(); const bb = g.boundingBox!; const c = bb.getCenter(new THREE.Vector3()), s = bb.getSize(new THREE.Vector3()); const ext = Math.max(s.x, s.y, s.z, 0.01); const sc = 2.6 / ext; mesh.scale.setScalar(sc); mesh.position.set(-c.x * sc, -c.y * sc, -c.z * sc) }
    applyRef.current = (g) => { mesh.geometry.dispose(); mesh.geometry = g ?? new THREE.BufferGeometry(); if (g) fit(g) }

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
      return url
    }

    let raf = 0; const loop = () => { mesh.material = mesh.material; (mesh.material as THREE.Material).needsUpdate = false; renderer.render(scene, camera); raf = requestAnimationFrame(loop) }; loop()
    // material / wireframe live sync
    const matTimer = setInterval(() => { if ((mesh.material as any).__k !== matRef.current) { mesh.material.dispose(); mesh.material = makeMaterial(matRef.current); (mesh.material as any).__k = matRef.current }; (mesh.material as any).wireframe = wireRef.current }, 120)

    return () => { cancelAnimationFrame(raf); clearInterval(matTimer); ro.disconnect(); window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); renderer.domElement.removeEventListener('pointerdown', dn); renderer.domElement.removeEventListener('wheel', wh); mesh.geometry.dispose(); renderer.dispose(); if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement); applyRef.current = null; renderThumbRef.current = null }
  }, [])

  // ── Recompute the mesh (debounced, proxy) whenever the graph changes ──
  useEffect(() => {
    let cancelled = false
    setComputing(true)
    const t = setTimeout(() => {
      try {
        const g = evalGraph(graphRef.current, 'proxy')
        if (cancelled) return
        applyRef.current?.(g)
        setStats(g ? analyze(g) : null)
        setStatus(g ? 'Aperçu (proxy) ✓' : 'Aucune sortie — connecte un nœud à « Sortie ».')
      } catch (e) { setStatus('Erreur de calcul : ' + (e as Error).message) }
      setComputing(false)
    }, 40)
    return () => { cancelled = true; clearTimeout(t) }
  }, [graph])

  const computeHD = () => { setStatus('Calcul haute résolution…'); setComputing(true); setTimeout(() => { try { const g = evalGraph(graphRef.current, 'hd'); applyRef.current?.(g); setStats(g ? analyze(g) : null); setStatus('Haute résolution ✓') } catch (e) { setStatus('Erreur : ' + (e as Error).message) } setComputing(false) }, 20) }

  // export (needs the current viewport mesh geometry → recompute HD)
  useEffect(() => { if (!exportRef.current) return; const fmt = exportRef.current; exportRef.current = null; const geo = evalGraph(graphRef.current, 'hd'); if (!geo) { setStatus('Rien à exporter.'); return }; const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ side: THREE.DoubleSide })); if (fmt === 'stl') dl(new Blob([new STLExporter().parse(m, { binary: false })], { type: 'model/stl' }), 'morpho.stl'); else if (fmt === 'obj') dl(new Blob([new OBJExporter().parse(m)], { type: 'text/plain' }), 'morpho.obj'); else if (fmt === 'glb') new GLTFExporter().parse(m, (r) => dl(new Blob([r as ArrayBuffer], { type: 'model/gltf-binary' }), 'morpho.glb'), () => setStatus('Échec GLB'), { binary: true }); setStatus(`Export ${fmt.toUpperCase()} ✓`) })

  // ── Morphospace : 8 mutated variants with thumbnails ──
  const mutateGraph = (g: Graph, amount: number): Graph => {
    const ng: Graph = JSON.parse(JSON.stringify(g)); const rnd = () => (Math.random() * 2 - 1) * amount
    for (const n of ng.nodes) { const def = NODE_DEFS[n.type]; for (const pr of def.params) { if (pr.type === 'seed') n.params[pr.key] = Math.floor(Math.random() * 9999) + 1; else if (pr.type === 'num' && pr.min !== undefined && pr.max !== undefined) { const cur = (n.params[pr.key] as number); n.params[pr.key] = clamp(pr.min, pr.max, cur + rnd() * (pr.max - pr.min)) } } }
    return ng
  }
  const genVariants = () => { setStatus('Génération des variantes…'); setTimeout(() => { const vs: { graph: Graph; thumb: string }[] = []; for (let i = 0; i < 8; i++) { const g = i === 0 ? graphRef.current : mutateGraph(graphRef.current, 0.35); vs.push({ graph: g, thumb: renderThumbRef.current?.(g) ?? '' }) } setVariants(vs); setStatus('8 variantes générées.') }, 20) }
  const mutate = () => pushHist(mutateGraph(graphRef.current, 0.3))

  const loadPreset = (i: number) => { pushHist(PRESETS[i].build()); setSelId(null); setVariants([]) }
  const runBuilt = (b: Built, youText: string) => { pushHist(b.graph); setSelId(null); setVariants([]); if (b.material) setMaterial(b.material); setAiLog((l) => [...l, { role: 'you' as const, text: youText }, { role: 'ai' as const, text: b.explain.join(' ') }].slice(-10)) }
  const aiGenerate = (prompt: string) => { const p = prompt.trim(); if (!p) return; runBuilt(textToGraph(p), p); setAiInput('') }
  const aiCommand = (cmd: string) => runBuilt(applyCommand(cmd, graphRef.current), cmd)
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
  const dragRef = useRef<{ mode: 'node' | 'pan' | 'link'; id?: string; ox?: number; oy?: number; from?: { id: string; idx: number } } | null>(null)
  const [tmpLink, setTmpLink] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const nodeH = (n: GNode) => HDRH + Math.max(NODE_DEFS[n.type].inputs.length, NODE_DEFS[n.type].outputs.length, 1) * ROW + 6
  const outPos = (n: GNode, i: number) => ({ x: n.x + NW, y: n.y + HDRH + i * ROW + ROW / 2 })
  const inPos = (n: GNode, i: number) => ({ x: n.x, y: n.y + HDRH + i * ROW + ROW / 2 })
  const toGraph = (cx: number, cy: number) => { const r = wrapRef.current!.getBoundingClientRect(); return { x: (cx - r.left - pan.x) / pan.k, y: (cy - r.top - pan.y) / pan.k } }

  const onDownNode = (e: React.PointerEvent, id: string) => { e.stopPropagation(); setSelId(id); const n = graph.nodes.find((x) => x.id === id)!; const g = toGraph(e.clientX, e.clientY); dragRef.current = { mode: 'node', id, ox: g.x - n.x, oy: g.y - n.y } }
  const onDownOut = (e: React.PointerEvent, id: string, idx: number) => { e.stopPropagation(); const n = graph.nodes.find((x) => x.id === id)!; const p = outPos(n, idx); dragRef.current = { mode: 'link', from: { id, idx } }; setTmpLink({ x1: p.x, y1: p.y, x2: p.x, y2: p.y }) }
  const onUpIn = (id: string, idx: number) => { const d = dragRef.current; if (d?.mode === 'link' && d.from) { if (d.from.id !== id) { const edges = graph.edges.filter((e) => !(e.to === id && e.toIdx === idx)); pushHist({ ...graph, edges: [...edges, { id: uid('e'), from: d.from.id, fromIdx: d.from.idx, to: id, toIdx: idx }] }) } } dragRef.current = null; setTmpLink(null) }
  const onMove = (e: React.PointerEvent) => { const d = dragRef.current; if (!d) return; const g = toGraph(e.clientX, e.clientY); if (d.mode === 'node' && d.id) setGraph((gr) => ({ ...gr, nodes: gr.nodes.map((n) => (n.id === d.id ? { ...n, x: g.x - d.ox!, y: g.y - d.oy! } : n)) })); else if (d.mode === 'pan') setPan((p) => ({ ...p, x: p.x + e.movementX, y: p.y + e.movementY })); else if (d.mode === 'link') setTmpLink((t) => (t ? { ...t, x2: g.x, y2: g.y } : t)) }
  const onUp = () => { if (dragRef.current?.mode === 'node') pushHist(graph); dragRef.current = null; setTmpLink(null) }
  const onDownBg = () => { dragRef.current = { mode: 'pan' }; setSelId(null) }
  const onWheel = (e: React.WheelEvent) => { const k = clamp(0.35, 2.2, pan.k * (e.deltaY < 0 ? 1.1 : 0.9)); setPan((p) => ({ ...p, k })) }
  const bez = (x1: number, y1: number, x2: number, y2: number) => `M${x1},${y1} C${x1 + 60},${y1} ${x2 - 60},${y2} ${x2},${y2}`

  return (
    <div ref={wrapRef} onPointerDown={onDownBg} onPointerMove={onMove} onPointerUp={onUp} onWheel={onWheel} style={{ width: '100%', height: '100%', background: '#0a0c10', overflow: 'hidden', position: 'relative', cursor: 'grab' }}>
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
  const v = node.params[pr.key] ?? pr.def
  if (pr.type === 'select') return <Field l={pr.label}><select value={v as string} onChange={(e) => onChange(e.target.value)} style={sel}>{pr.options!.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select></Field>
  if (pr.type === 'seed') return <Field l={pr.label}><div style={{ display: 'flex', gap: 6 }}><input type="number" value={v as number} onChange={(e) => onChange(+e.target.value)} style={{ ...sel, flex: 1 }} /><button onClick={() => onChange(Math.floor(Math.random() * 9999) + 1)} style={{ ...sel, width: 34, cursor: 'pointer' }}>🎲</button></div></Field>
  return <Field l={`${pr.label} — ${(v as number).toFixed(2)}`}><input type="range" min={pr.min} max={pr.max} step={pr.step} value={v as number} onChange={(e) => onChange(+e.target.value)} style={{ width: '100%', accentColor: '#8b6df0' }} /></Field>
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
