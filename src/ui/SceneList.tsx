import { Plus, Copy, Trash2, Download, Upload } from 'lucide-react'
import { useSceneStore } from '../store/sceneStore'
import { exportSceneJSON, importSceneJSON } from '../lib/persistence'
import { defaultMapping, type Scene } from '../types/scene'
import { useRef } from 'react'

export function SceneList() {
  const scenes = useSceneStore((s) => s.scenes)
  const currentId = useSceneStore((s) => s.currentId)
  const select = useSceneStore((s) => s.select)
  const duplicate = useSceneStore((s) => s.duplicate)
  const remove = useSceneStore((s) => s.remove)
  const add = useSceneStore((s) => s.add)
  const fileRef = useRef<HTMLInputElement>(null)

  const current = scenes.find((s) => s.id === currentId)

  const createNew = async () => {
    const blank: Scene = {
      id: `scene-${Date.now().toString(36)}`,
      name: '✨ Nouvelle scène',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      organism: {
        kind: 'boids',
        values: { count: 1000, cohesion: 0.5, separation: 0.5, alignment: 0.5, speed: 0.6, vision: 0.4, size: 0.015, trail: 0.92 },
      },
      visual: {
        palette: { bg: '#06070d', primary: '#00ffa3', secondary: '#00d4ff', glow: '#7c3aed' },
        bloom: 0.5, feedback: 0.92, blendMode: 'add',
        texture: null,
      },
      senses: { hands: true, audio: true, light: false, bindings: [] },
      evolution: { enabled: false, driftSpeed: 0.05, amplitude: 0.15 },
      mapping: defaultMapping(),
      obstacles: [],
      notes: '',
    }
    await add(blank)
  }

  const onImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    try {
      const s = await importSceneJSON(f)
      // Guard against silently overwriting an existing scene that happens to
      // share the imported id : mint a fresh id + copy label instead.
      const collision = scenes.some((x) => x.id === s.id)
      const safe = collision
        ? { ...s, id: `${s.id}-import-${Date.now().toString(36)}`, name: `${s.name} (importé)` }
        : s
      await add(safe)
    } catch (err) { alert('Fichier invalide: ' + err) }
    e.target.value = ''
  }

  return (
    <div className="left-panel">
      <h3>Scènes</h3>
      <div className="scene-list">
        {scenes.map((s) => {
          const p = s.visual?.palette
          const gradient = p
            ? `linear-gradient(135deg, ${p.primary} 0%, ${p.secondary} 50%, ${p.glow} 100%)`
            : 'linear-gradient(135deg, var(--accent), var(--accent-3))'
          return (
            <div
              key={s.id}
              className={`scene-item ${s.id === currentId ? 'active' : ''}`}
              onClick={() => select(s.id)}
            >
              <span className="scene-color-swatch" style={{ background: gradient }} />
              <span className="scene-name">{s.name}</span>
              <span className="kind">{s.organism.kind}</span>
            </div>
          )
        })}
      </div>
      <div className="scene-actions">
        <button onClick={createNew} title="Nouvelle scène"><Plus size={14} /> Nouvelle</button>
        <button onClick={() => currentId && duplicate(currentId)} disabled={!currentId} title="Dupliquer">
          <Copy size={14} />
        </button>
        <button
          className="danger"
          onClick={() => currentId && confirm('Supprimer cette scène ?') && remove(currentId)}
          disabled={!currentId}
          title="Supprimer"
        >
          <Trash2 size={14} />
        </button>
      </div>
      <div className="scene-actions" style={{ paddingTop: 0 }}>
        <button onClick={() => current && exportSceneJSON(current)} disabled={!current} title="Exporter JSON">
          <Download size={14} /> Exporter
        </button>
        <button onClick={() => fileRef.current?.click()} title="Importer JSON">
          <Upload size={14} /> Importer
        </button>
        <input ref={fileRef} type="file" accept=".json" style={{ display: 'none' }} onChange={onImport} />
      </div>
    </div>
  )
}
