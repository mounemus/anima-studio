import { useState } from 'react'
import { useSceneStore } from '../store/sceneStore'
import type { OrganismKind } from '../types/scene'

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  format?: (v: number) => string
}

function Slider({ label, value, min, max, step = 0.01, onChange, format }: SliderProps) {
  return (
    <div className="field">
      <label>{label}</label>
      <span className="val">{(format ?? ((v: number) => v.toFixed(2)))(value)}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </div>
  )
}

const ORGANISM_PRESETS: Record<OrganismKind, Record<string, number>> = {
  boids: { count: 1500, cohesion: 0.5, separation: 0.5, alignment: 0.5, speed: 0.7, vision: 0.4, size: 0.015, trail: 0.92 },
  particles: { count: 3000, speed: 0.6, size: 1.0, spread: 1.0, trail: 0.88, gravity: 0, turbulence: 0.5 },
  tendrils: { count: 30, length: 48, speed: 0.5, twist: 1.5, thickness: 0.01, trail: 0.95 },
  cells: { count: 50, pulse: 1.0, size: 1.2, attraction: 0.5, repulsion: 0.5, trail: 0.85 },
}

export function ParamPanel() {
  const current = useSceneStore((s) => s.scenes.find((x) => x.id === s.currentId))
  const patchValues = useSceneStore((s) => s.patchOrganismValues)
  const updateOrganism = useSceneStore((s) => s.updateOrganism)
  const updateVisual = useSceneStore((s) => s.updateVisual)
  const updatePalette = useSceneStore((s) => s.updatePalette)
  const rename = useSceneStore((s) => s.rename)
  const setNotes = useSceneStore((s) => s.setNotes)
  const [tab, setTab] = useState<'organism' | 'visual' | 'senses' | 'mapping' | 'notes'>('organism')

  if (!current) return <div className="right-panel"><div className="ai-empty">Aucune scène sélectionnée</div></div>

  const changeKind = (k: OrganismKind) => {
    updateOrganism({ kind: k, values: ORGANISM_PRESETS[k] } as any)
  }

  const v = current.organism.values as unknown as Record<string, number>

  return (
    <div className="right-panel">
      <div className="section" style={{ borderBottom: 'none', paddingBottom: 0 }}>
        <input
          value={current.name}
          onChange={(e) => rename(e.target.value)}
          style={{ width: '100%', fontWeight: 600, fontSize: 13, background: 'transparent', border: 'none', padding: '4px 0' }}
        />
      </div>

      <div className="tabs">
        <button className={`tab ${tab === 'organism' ? 'active' : ''}`} onClick={() => setTab('organism')}>Organisme</button>
        <button className={`tab ${tab === 'visual' ? 'active' : ''}`} onClick={() => setTab('visual')}>Visuel</button>
        <button className={`tab ${tab === 'senses' ? 'active' : ''}`} onClick={() => setTab('senses')}>Sens</button>
        <button className={`tab ${tab === 'mapping' ? 'active' : ''}`} onClick={() => setTab('mapping')}>Map</button>
        <button className={`tab ${tab === 'notes' ? 'active' : ''}`} onClick={() => setTab('notes')}>Notes</button>
      </div>

      <div className="tab-content">
        {tab === 'organism' && (
          <div className="section">
            <h3>Espèce</h3>
            <select
              value={current.organism.kind}
              onChange={(e) => changeKind(e.target.value as OrganismKind)}
              style={{ width: '100%', marginBottom: 14 }}
            >
              <option value="boids">🐦 Boids — bancs</option>
              <option value="particles">✨ Particules — poussière</option>
              <option value="tendrils">🌿 Tendrils — filaments</option>
              <option value="cells">🧫 Cellules — colonie</option>
            </select>

            <h3>Paramètres</h3>
            {current.organism.kind === 'boids' && (
              <>
                <Slider label="Population" value={v.count} min={100} max={5000} step={50} onChange={(x) => patchValues({ count: Math.round(x) })} format={(x) => Math.round(x).toString()} />
                <Slider label="Cohésion" value={v.cohesion} min={0} max={2} onChange={(x) => patchValues({ cohesion: x })} />
                <Slider label="Séparation" value={v.separation} min={0} max={2} onChange={(x) => patchValues({ separation: x })} />
                <Slider label="Alignement" value={v.alignment} min={0} max={2} onChange={(x) => patchValues({ alignment: x })} />
                <Slider label="Vitesse" value={v.speed} min={0.1} max={3} onChange={(x) => patchValues({ speed: x })} />
                <Slider label="Vision" value={v.vision} min={0.1} max={1} onChange={(x) => patchValues({ vision: x })} />
                <Slider label="Taille" value={v.size} min={0.005} max={0.05} step={0.001} onChange={(x) => patchValues({ size: x })} format={(x) => x.toFixed(3)} />
              </>
            )}
            {current.organism.kind === 'particles' && (
              <>
                <Slider label="Population" value={v.count} min={500} max={8000} step={100} onChange={(x) => patchValues({ count: Math.round(x) })} format={(x) => Math.round(x).toString()} />
                <Slider label="Vitesse" value={v.speed} min={0.1} max={3} onChange={(x) => patchValues({ speed: x })} />
                <Slider label="Taille" value={v.size} min={0.3} max={3} onChange={(x) => patchValues({ size: x })} />
                <Slider label="Dispersion" value={v.spread} min={0.2} max={2} onChange={(x) => patchValues({ spread: x })} />
                <Slider label="Gravité" value={v.gravity} min={-1} max={1} onChange={(x) => patchValues({ gravity: x })} />
                <Slider label="Turbulence" value={v.turbulence} min={0} max={2} onChange={(x) => patchValues({ turbulence: x })} />
              </>
            )}
            {current.organism.kind === 'tendrils' && (
              <>
                <Slider label="Nombre" value={v.count} min={4} max={80} step={1} onChange={(x) => patchValues({ count: Math.round(x) })} format={(x) => Math.round(x).toString()} />
                <Slider label="Longueur" value={v.length} min={8} max={64} step={1} onChange={(x) => patchValues({ length: Math.round(x) })} format={(x) => Math.round(x).toString()} />
                <Slider label="Vitesse" value={v.speed} min={0.1} max={2} onChange={(x) => patchValues({ speed: x })} />
                <Slider label="Torsion" value={v.twist} min={0} max={4} onChange={(x) => patchValues({ twist: x })} />
              </>
            )}
            {current.organism.kind === 'cells' && (
              <>
                <Slider label="Population" value={v.count} min={4} max={200} step={1} onChange={(x) => patchValues({ count: Math.round(x) })} format={(x) => Math.round(x).toString()} />
                <Slider label="Pulsation" value={v.pulse} min={0} max={3} onChange={(x) => patchValues({ pulse: x })} />
                <Slider label="Taille" value={v.size} min={0.4} max={3} onChange={(x) => patchValues({ size: x })} />
                <Slider label="Attraction" value={v.attraction} min={0} max={2} onChange={(x) => patchValues({ attraction: x })} />
                <Slider label="Répulsion" value={v.repulsion} min={0} max={2} onChange={(x) => patchValues({ repulsion: x })} />
              </>
            )}
          </div>
        )}

        {tab === 'visual' && (
          <div className="section">
            <h3>Palette</h3>
            <div className="palette-row">
              <label>Fond</label>
              <input type="color" value={current.visual.palette.bg} onChange={(e) => updatePalette({ bg: e.target.value })} />
            </div>
            <div className="palette-row">
              <label>Primaire</label>
              <input type="color" value={current.visual.palette.primary} onChange={(e) => updatePalette({ primary: e.target.value })} />
            </div>
            <div className="palette-row">
              <label>Secondaire</label>
              <input type="color" value={current.visual.palette.secondary} onChange={(e) => updatePalette({ secondary: e.target.value })} />
            </div>
            <div className="palette-row">
              <label>Glow</label>
              <input type="color" value={current.visual.palette.glow} onChange={(e) => updatePalette({ glow: e.target.value })} />
            </div>

            <h3 style={{ marginTop: 14 }}>Rendu</h3>
            <Slider label="Trainée (feedback)" value={current.visual.feedback} min={0.6} max={0.99} step={0.005} onChange={(x) => updateVisual({ feedback: x })} format={(x) => x.toFixed(3)} />
            <div className="palette-row">
              <label>Mélange</label>
              <select value={current.visual.blendMode} onChange={(e) => updateVisual({ blendMode: e.target.value as any })}>
                <option value="add">Additif</option>
                <option value="normal">Normal</option>
              </select>
            </div>
          </div>
        )}

        {tab === 'senses' && <SensesTab />}

        {tab === 'mapping' && <MappingTab />}

        {tab === 'notes' && (
          <div className="section">
            <h3>Notes</h3>
            <textarea
              value={current.notes ?? ''}
              onChange={(e) => setNotes(e.target.value)}
              rows={12}
              placeholder="Intention artistique, contexte, conditions de lumière, prompts IA..."
              style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
            />
          </div>
        )}
      </div>
    </div>
  )
}

function SensesTab() {
  const current = useSceneStore((s) => s.scenes.find((x) => x.id === s.currentId))!
  const setScenes = useSceneStore((s) => s.persistCurrent)

  const toggle = (key: 'hands' | 'audio' | 'light') => {
    current.senses[key] = !current.senses[key]
    setScenes()
    // trigger react
    useSceneStore.setState({ scenes: [...useSceneStore.getState().scenes] })
  }

  return (
    <div className="section">
      <h3>Capteurs actifs</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label style={{ display: 'flex', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
          <input type="checkbox" checked={current.senses.hands} onChange={() => toggle('hands')} />
          <span>🖐️ Webcam + tracking main</span>
        </label>
        <label style={{ display: 'flex', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
          <input type="checkbox" checked={current.senses.audio} onChange={() => toggle('audio')} />
          <span>🎵 Microphone (FFT)</span>
        </label>
        <label style={{ display: 'flex', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
          <input type="checkbox" checked={current.senses.light} onChange={() => toggle('light')} />
          <span>💡 Lumière ambiante</span>
        </label>
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 16, lineHeight: 1.5 }}>
        Les capteurs autorisés démarreront via la barre supérieure. La main attire les organismes ;
        le pinch (pouce-index) intensifie l'effet ; les graves font respirer la taille ;
        les médiums/aigus modulent vitesse et chaleur.
      </p>
    </div>
  )
}

function MappingTab() {
  const current = useSceneStore((s) => s.scenes.find((x) => x.id === s.currentId))!
  const update = useSceneStore((s) => s.updateMapping)
  const m = current.mapping

  return (
    <div className="section">
      <h3>Projection mapping</h3>
      <label style={{ display: 'flex', gap: 8, cursor: 'pointer', userSelect: 'none', marginBottom: 12 }}>
        <input
          type="checkbox"
          checked={m.enabled}
          onChange={(e) => update({ enabled: e.target.checked })}
        />
        <span>Activer la calibration 4 coins</span>
      </label>
      <p style={{ fontSize: 11, color: 'var(--text-mute)', marginBottom: 12 }}>
        Active la calibration, puis glisse les 4 coins sur la scène pour ajuster aux contours de la surface projetée.
      </p>
      <h3>Edge blend (multi-projecteurs)</h3>
      <Slider label="Gauche" value={m.edgeBlend.left} min={0} max={0.4} step={0.01} onChange={(x) => update({ edgeBlend: { ...m.edgeBlend, left: x } })} />
      <Slider label="Droite" value={m.edgeBlend.right} min={0} max={0.4} step={0.01} onChange={(x) => update({ edgeBlend: { ...m.edgeBlend, right: x } })} />
      <Slider label="Haut" value={m.edgeBlend.top} min={0} max={0.4} step={0.01} onChange={(x) => update({ edgeBlend: { ...m.edgeBlend, top: x } })} />
      <Slider label="Bas" value={m.edgeBlend.bottom} min={0} max={0.4} step={0.01} onChange={(x) => update({ edgeBlend: { ...m.edgeBlend, bottom: x } })} />
      <Slider label="Gamma" value={m.edgeBlend.gamma} min={1} max={4} step={0.1} onChange={(x) => update({ edgeBlend: { ...m.edgeBlend, gamma: x } })} />
      <button onClick={() => update({ corners: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] })}>
        Réinitialiser les coins
      </button>
    </div>
  )
}
