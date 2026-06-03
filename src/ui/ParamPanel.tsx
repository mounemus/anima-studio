import { useState, useEffect, useRef } from 'react'
import { Sparkles, X, Loader, Plus, Trash2, Eye, EyeOff, Video, VideoOff, Crop, Save, Download, FolderOpen, Hand, User, Circle, Pentagon, Shapes, Music2, Volume2, VolumeX } from 'lucide-react'
import { useSceneStore } from '../store/sceneStore'
import type { OrganismKind, TestPattern, ObstacleInteraction, Waveform, SoundConfig } from '../types/scene'
import { LiveImg2Img } from '../lib/liveImg2Img'
import { soundEngine } from '../engine/SoundEngine'
import { saveCalibration, listCalibrations, deleteCalibration, exportCalibration, type CalibrationProfile } from '../lib/calibrations'

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
  const [tab, setTab] = useState<'organism' | 'visual' | 'senses' | 'obstacles' | 'mapping' | 'notes'>('organism')

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
        <button className={`tab ${tab === 'obstacles' ? 'active' : ''}`} onClick={() => setTab('obstacles')}>Obstacles</button>
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

            <h3 style={{ marginTop: 14 }}><Sparkles size={11} style={{ verticalAlign: 'middle', color: 'var(--accent)' }} /> Texture IA</h3>
            <TextureGen />
          </div>
        )}

        {tab === 'senses' && <SensesTab />}

        {tab === 'obstacles' && <ObstaclesTab />}

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
  const updateEvolution = useSceneStore((s) => s.updateEvolution)

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
        La main attire les organismes ; le pinch intensifie l'effet ;
        les graves font respirer la taille ; médiums/aigus modulent vitesse.
      </p>

      <h3 style={{ marginTop: 18 }}>🧬 Évolution générative</h3>
      <label style={{ display: 'flex', gap: 8, cursor: 'pointer', userSelect: 'none', marginBottom: 10 }}>
        <input
          type="checkbox"
          checked={current.evolution.enabled}
          onChange={(e) => updateEvolution({ enabled: e.target.checked })}
        />
        <span>Activer la dérive organique</span>
      </label>
      <Slider
        label="Vitesse de dérive"
        value={current.evolution.driftSpeed}
        min={0.01} max={0.3} step={0.005}
        onChange={(x) => updateEvolution({ driftSpeed: x })}
        format={(x) => x.toFixed(3)}
      />
      <Slider
        label="Amplitude"
        value={current.evolution.amplitude}
        min={0.05} max={0.6} step={0.01}
        onChange={(x) => updateEvolution({ amplitude: x })}
        format={(x) => `±${(x * 100).toFixed(0)}%`}
      />
      <p style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 6, lineHeight: 1.5 }}>
        Les paramètres dérivent en continu par bruit Perlin. L'organisme paraît vivant et respire de lui-même.
      </p>
    </div>
  )
}

const TEXTURE_PROMPTS = [
  'Iridescent organic membrane, microscopic, glowing',
  'Bioluminescent jellyfish scales, dark sea',
  'Mycelium network, fluorescent, dark background',
  'Coral reef macro, electric colors, abstract',
  'Lava cells, molten gold, organic',
  'Crystal cellular structure, holographic',
]

function TextureGen() {
  const current = useSceneStore((s) => s.scenes.find((x) => x.id === s.currentId))!
  const setTexture = useSceneStore((s) => s.setTexture)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [liveOn, setLiveOn] = useState(false)
  const [liveStrength, setLiveStrength] = useState(0.55)
  const [liveStatus, setLiveStatus] = useState<'idle' | 'capturing' | 'pending' | 'error'>('idle')
  const liveRef = useRef<LiveImg2Img | null>(null)

  // Stop live loop on unmount or when scene changes
  useEffect(() => {
    return () => { liveRef.current?.stop(); liveRef.current = null }
  }, [current?.id])

  const toggleLive = () => {
    if (liveOn) {
      liveRef.current?.stop()
      liveRef.current = null
      setLiveOn(false)
      setLiveStatus('idle')
      return
    }
    const video = document.querySelector('video') as HTMLVideoElement | null
    if (!video || !video.srcObject) {
      setErr('Active la caméra dans la barre du haut d\'abord.')
      return
    }
    const p = prompt.trim() || 'bioluminescent organism, glowing, dark background, abstract'
    liveRef.current = new LiveImg2Img({
      video,
      prompt: p,
      strength: liveStrength,
      intervalMs: 1500,
      onResult: (url) => setTexture({ url, prompt: p, model: 'img2img-live', generatedAt: Date.now() }),
      onError: (e) => setErr(e),
      onStatus: setLiveStatus,
    })
    liveRef.current.start()
    setLiveOn(true)
    setErr(null)
  }

  // sync prompt/strength changes to running loop
  useEffect(() => {
    if (liveRef.current) {
      if (prompt.trim()) liveRef.current.setPrompt(prompt.trim())
      liveRef.current.setStrength(liveStrength)
    }
  }, [prompt, liveStrength])

  const generate = async (promptOverride?: string) => {
    const finalPrompt = (promptOverride ?? prompt).trim()
    if (!finalPrompt || busy) return
    setBusy(true); setErr(null)
    try {
      const r = await fetch('/api/fal/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: finalPrompt, size: 'square' }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'erreur')
      setTexture({
        url: d.url,
        prompt: d.prompt,
        model: d.model,
        seed: d.seed,
        generatedAt: Date.now(),
      })
      setPrompt('')
    } catch (e: any) { setErr(e.message) }
    finally { setBusy(false) }
  }

  const tex = current.visual.texture
  return (
    <div>
      {tex && (
        <div style={{ position: 'relative', marginBottom: 10 }}>
          <img src={tex.url} alt="" style={{ width: '100%', borderRadius: 'var(--radius-sm)', display: 'block' }} crossOrigin="anonymous" />
          <button
            className="ghost icon"
            onClick={() => setTexture(null)}
            style={{ position: 'absolute', top: 6, right: 6, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
            title="Retirer la texture"
          >
            <X size={14} />
          </button>
          <div style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 6, fontStyle: 'italic' }}>"{tex.prompt}"</div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && generate()}
          placeholder="Prompt (anglais conseillé)..."
          disabled={busy}
          style={{ flex: 1, fontSize: 12 }}
        />
        <button className="primary" onClick={() => generate()} disabled={busy || !prompt.trim()}>
          {busy ? <Loader size={12} className="spin" /> : <Sparkles size={12} />}
          {busy ? '...' : 'Générer'}
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {TEXTURE_PROMPTS.map((p) => (
          <button
            key={p}
            className="ghost"
            onClick={() => generate(p)}
            disabled={busy}
            style={{ fontSize: 10, padding: '3px 7px' }}
            title={p}
          >
            {p.split(',')[0].slice(0, 24)}
          </button>
        ))}
      </div>

      <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>🎥 Live img2img webcam</h3>
          {liveOn && (
            <span style={{
              fontSize: 10, padding: '2px 6px', borderRadius: 999,
              background: liveStatus === 'pending' ? 'rgba(255,181,71,0.2)' : liveStatus === 'error' ? 'rgba(255,90,122,0.2)' : 'rgba(0,255,163,0.2)',
              color: liveStatus === 'pending' ? 'var(--warn)' : liveStatus === 'error' ? 'var(--danger)' : 'var(--accent)',
              fontFamily: 'var(--mono)',
            }}>
              {liveStatus}
            </span>
          )}
        </div>
        <p style={{ fontSize: 11, color: 'var(--text-mute)', marginBottom: 8 }}>
          Ta webcam devient la matière de l'oeuvre — chaque frame est ré-imaginée par SDXL Lightning (~1s).
        </p>
        <button
          className={liveOn ? 'primary' : ''}
          onClick={toggleLive}
          style={{ width: '100%', justifyContent: 'center' }}
        >
          {liveOn ? <VideoOff size={12} /> : <Video size={12} />}
          {liveOn ? 'Arrêter le live img2img' : 'Démarrer le live img2img'}
        </button>
        {liveOn && (
          <div style={{ marginTop: 8 }}>
            <Slider
              label="Strength (transformation)"
              value={liveStrength}
              min={0.3} max={0.9} step={0.05}
              onChange={setLiveStrength}
              format={(x) => x.toFixed(2)}
            />
          </div>
        )}
      </div>

      {err && <div className="form-error" style={{ marginTop: 8 }}>{err}</div>}
    </div>
  )
}

const INTERACTIONS: { v: ObstacleInteraction; label: string; help: string }[] = [
  { v: 'avoid', label: '↻ Éviter', help: 'Les organismes contournent l\'obstacle.' },
  { v: 'attract', label: '⇢ Attirer', help: 'Les organismes sont attirés vers l\'obstacle.' },
  { v: 'bounce', label: '↺ Rebondir', help: 'Les organismes rebondissent sur le bord.' },
  { v: 'kill', label: '✕ Tuer/Respawn', help: 'Les organismes touchés réapparaissent ailleurs.' },
]

function ObstaclesTab() {
  const current = useSceneStore((s) => s.scenes.find((x) => x.id === s.currentId))!
  const add = useSceneStore((s) => s.addObstacle)
  const remove = useSceneStore((s) => s.removeObstacle)
  const update = useSceneStore((s) => s.updateObstacle)
  const obs = current.obstacles ?? []
  const [selectedId, setSelectedId] = useState<string | null>(null)
  useEffect(() => {
    // expose selection to overlay via a custom event so Stage knows about edit selection
    window.dispatchEvent(new CustomEvent('anima:obstacle-select', { detail: selectedId }))
  }, [selectedId])

  const sel = obs.find((o) => o.id === selectedId) ?? obs[obs.length - 1]
  useEffect(() => { if (!sel && obs.length) setSelectedId(obs[obs.length - 1].id) }, [obs.length])

  return (
    <div className="section">
      <h3><Shapes size={11} style={{ verticalAlign: 'middle', color: 'var(--accent)' }} /> Obstacles physiques</h3>
      <p style={{ fontSize: 11, color: 'var(--text-mute)', marginBottom: 10 }}>
        Les organismes interagissent physiquement avec ces zones : éviter, être attirés, rebondir ou disparaître.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 12 }}>
        <button onClick={() => add('circle')} style={{ fontSize: 12, justifyContent: 'center' }}><Circle size={12} /> Cercle</button>
        <button onClick={() => add('polygon')} style={{ fontSize: 12, justifyContent: 'center' }}><Pentagon size={12} /> Polygone</button>
        <button onClick={() => add('hand')} style={{ fontSize: 12, justifyContent: 'center' }}><Hand size={12} /> Main</button>
        <button onClick={() => add('silhouette')} style={{ fontSize: 12, justifyContent: 'center' }}><User size={12} /> Silhouette</button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
        {obs.length === 0 && (
          <p style={{ fontSize: 11, color: 'var(--text-mute)', fontStyle: 'italic' }}>
            Aucun obstacle. Ajoute-en un pour que les organismes commencent à réagir.
          </p>
        )}
        {obs.map((o) => (
          <div
            key={o.id}
            onClick={() => setSelectedId(o.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 8px',
              border: `1px solid ${o.id === selectedId ? 'var(--accent)' : 'var(--line)'}`,
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
              opacity: o.enabled ? 1 : 0.5,
              background: o.id === selectedId ? 'var(--bg-elev-2)' : 'transparent',
            }}
          >
            <button
              className="ghost icon"
              onClick={(e) => { e.stopPropagation(); update(o.id, { enabled: !o.enabled }) }}
              title={o.enabled ? 'Désactiver' : 'Activer'}
              style={{ padding: 2 }}
            >
              {o.enabled ? <Eye size={12} /> : <EyeOff size={12} />}
            </button>
            <span style={{ fontSize: 10, color: 'var(--text-mute)', fontFamily: 'var(--mono)', minWidth: 18 }}>
              {o.kind === 'circle' ? '○' : o.kind === 'polygon' ? '⬠' : o.kind === 'hand' ? '✋' : '👤'}
            </span>
            <input
              value={o.name}
              onChange={(e) => update(o.id, { name: e.target.value })}
              onClick={(e) => e.stopPropagation()}
              style={{ flex: 1, background: 'transparent', border: 'none', padding: 2, fontSize: 12 }}
            />
            <span style={{ fontSize: 10, color: 'var(--text-mute)' }}>{o.interaction}</span>
            <button
              className="ghost icon danger"
              onClick={(e) => { e.stopPropagation(); if (confirm(`Supprimer ${o.name} ?`)) remove(o.id) }}
              style={{ padding: 2 }}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>

      {sel && (
        <div style={{ padding: 10, background: 'var(--bg)', borderRadius: 'var(--radius-sm)' }}>
          <h3 style={{ marginTop: 0 }}>Configuration : {sel.name}</h3>

          <div className="palette-row">
            <label>Interaction</label>
            <select value={sel.interaction} onChange={(e) => update(sel.id, { interaction: e.target.value as ObstacleInteraction })}>
              {INTERACTIONS.map((it) => <option key={it.v} value={it.v}>{it.label}</option>)}
            </select>
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-mute)', marginBottom: 10 }}>
            {INTERACTIONS.find((i) => i.v === sel.interaction)?.help}
          </p>

          <Slider label="Force" value={sel.strength} min={0} max={2} step={0.05} onChange={(x) => update(sel.id, { strength: x })} />
          <Slider label="Marge (douceur)" value={sel.margin} min={0.02} max={0.4} step={0.01} onChange={(x) => update(sel.id, { margin: x })} format={(x) => `${Math.round(x * 100)}%`} />

          {sel.kind === 'circle' && sel.circle && (
            <>
              <h3 style={{ marginTop: 10 }}>Cercle</h3>
              <Slider label="Centre X" value={sel.circle.cx} min={0} max={1} step={0.01} onChange={(x) => update(sel.id, { circle: { ...sel.circle!, cx: x } })} format={(x) => `${Math.round(x * 100)}%`} />
              <Slider label="Centre Y" value={sel.circle.cy} min={0} max={1} step={0.01} onChange={(y) => update(sel.id, { circle: { ...sel.circle!, cy: y } })} format={(y) => `${Math.round(y * 100)}%`} />
              <Slider label="Rayon" value={sel.circle.r} min={0.02} max={0.6} step={0.01} onChange={(r) => update(sel.id, { circle: { ...sel.circle!, r } })} format={(r) => `${Math.round(r * 100)}%`} />
            </>
          )}

          {sel.kind === 'polygon' && sel.polygon && (
            <>
              <h3 style={{ marginTop: 10 }}>Polygone ({sel.polygon.points.length} sommets)</h3>
              <p style={{ fontSize: 11, color: 'var(--text-mute)', marginBottom: 8 }}>
                Glisse les sommets sur la scène pour ajuster la forme.
              </p>
              <button onClick={() => update(sel.id, { polygon: { points: [...sel.polygon!.points, { x: 0.5, y: 0.5 }] } })} style={{ width: '100%', justifyContent: 'center', fontSize: 12 }}>
                <Plus size={12} /> Ajouter un sommet
              </button>
              {sel.polygon.points.length > 3 && (
                <button onClick={() => update(sel.id, { polygon: { points: sel.polygon!.points.slice(0, -1) } })} style={{ width: '100%', justifyContent: 'center', fontSize: 12, marginTop: 4 }}>
                  <Trash2 size={12} /> Retirer le dernier sommet
                </button>
              )}
            </>
          )}

          {sel.kind === 'hand' && sel.hand && (
            <>
              <h3 style={{ marginTop: 10 }}>Main</h3>
              <div className="palette-row">
                <label>Source</label>
                <select value={sel.hand.source} onChange={(e) => update(sel.id, { hand: { ...sel.hand!, source: e.target.value as any } })}>
                  <option value="palm">Paume</option>
                  <option value="index">Index</option>
                </select>
              </div>
              <Slider label="Rayon" value={sel.hand.radius} min={0.03} max={0.4} step={0.01} onChange={(r) => update(sel.id, { hand: { ...sel.hand!, radius: r } })} format={(r) => `${Math.round(r * 100)}%`} />
              <p style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 8 }}>
                ⚠️ Active la caméra dans la TopBar pour activer le tracking de la main.
              </p>
            </>
          )}

          {sel.kind === 'silhouette' && sel.silhouette && (
            <>
              <h3 style={{ marginTop: 10 }}>Silhouette corporelle</h3>
              <label style={{ display: 'flex', gap: 8, cursor: 'pointer', userSelect: 'none', marginBottom: 8 }}>
                <input
                  type="checkbox"
                  checked={sel.silhouette.invert}
                  onChange={(e) => update(sel.id, { silhouette: { invert: e.target.checked } })}
                />
                <span>Inverser (l'organisme reste DANS la silhouette)</span>
              </label>
              <p style={{ fontSize: 11, color: 'var(--text-mute)' }}>
                Segmentation MediaPipe SelfieSegmenter à 10 fps. Active la caméra pour démarrer.
                Combinez avec <strong>kill</strong> : les organismes "disparaissent" derrière toi.
              </p>
            </>
          )}

          <SoundSection obstacleId={sel.id} sound={sel.sound} onChange={(s) => update(sel.id, { sound: s })} />
        </div>
      )}

      <MasterSoundControl />
    </div>
  )
}

const NOTES = [
  { v: 'auto', label: 'Auto (penta)' },
  { v: 48, label: 'C3 (do)' }, { v: 50, label: 'D3 (ré)' }, { v: 52, label: 'E3 (mi)' },
  { v: 55, label: 'G3 (sol)' }, { v: 57, label: 'A3 (la)' },
  { v: 60, label: 'C4 (do)' }, { v: 62, label: 'D4 (ré)' }, { v: 64, label: 'E4 (mi)' },
  { v: 67, label: 'G4 (sol)' }, { v: 69, label: 'A4 (la)' },
  { v: 72, label: 'C5 (do)' }, { v: 76, label: 'E5 (mi)' }, { v: 79, label: 'G5 (sol)' },
]
const WAVEFORMS: { v: Waveform; label: string }[] = [
  { v: 'sine', label: 'Sinus (doux)' },
  { v: 'triangle', label: 'Triangle' },
  { v: 'sawtooth', label: 'Dent (riche)' },
  { v: 'square', label: 'Carré (8-bit)' },
]

function SoundSection({ obstacleId, sound, onChange }: {
  obstacleId: string
  sound: SoundConfig | undefined
  onChange: (s: SoundConfig) => void
}) {
  const [density, setDensity] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setDensity(soundEngine.density(obstacleId)), 100)
    return () => clearInterval(id)
  }, [obstacleId])

  const s = sound ?? { enabled: false, note: 'auto' as const, waveform: 'sine' as Waveform, volume: 0.5, density: true, cutoff: 2000 }

  const toggle = () => {
    if (!s.enabled) soundEngine.ensure()
    onChange({ ...s, enabled: !s.enabled })
  }

  return (
    <>
      <h3 style={{ marginTop: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span><Music2 size={11} style={{ verticalAlign: 'middle', color: 'var(--accent)' }} /> Son</span>
        {s.enabled && (
          <span style={{ fontSize: 10, color: 'var(--text-mute)', fontFamily: 'var(--mono)' }}>
            densité: {(density * 100).toFixed(0)}%
          </span>
        )}
      </h3>
      <label style={{ display: 'flex', gap: 8, cursor: 'pointer', userSelect: 'none', marginBottom: 10 }}>
        <input type="checkbox" checked={s.enabled} onChange={toggle} />
        <span>Sonifier cet obstacle</span>
      </label>
      {s.enabled && (
        <>
          <div className="palette-row">
            <label>Note</label>
            <select value={String(s.note)} onChange={(e) => onChange({ ...s, note: e.target.value === 'auto' ? 'auto' : parseInt(e.target.value) })}>
              {NOTES.map((n) => <option key={String(n.v)} value={String(n.v)}>{n.label}</option>)}
            </select>
          </div>
          <div className="palette-row">
            <label>Waveform</label>
            <select value={s.waveform} onChange={(e) => onChange({ ...s, waveform: e.target.value as Waveform })}>
              {WAVEFORMS.map((w) => <option key={w.v} value={w.v}>{w.label}</option>)}
            </select>
          </div>
          <Slider label="Volume" value={s.volume} min={0} max={1} step={0.01} onChange={(v) => onChange({ ...s, volume: v })} format={(v) => `${Math.round(v * 100)}%`} />
          <Slider label="Cutoff filtre" value={s.cutoff} min={200} max={8000} step={50} onChange={(v) => onChange({ ...s, cutoff: v })} format={(v) => `${Math.round(v)}Hz`} />
          <div style={{ background: 'var(--bg-elev-2)', height: 4, borderRadius: 2, overflow: 'hidden', marginTop: 8 }}>
            <div style={{ width: `${density * 100}%`, height: '100%', background: 'linear-gradient(90deg, var(--accent), var(--accent-3))', transition: 'width 80ms linear' }} />
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 8, lineHeight: 1.4 }}>
            Le volume varie avec la densité d'organismes dans l'obstacle. Plus l'écosystème est dense → plus la note est forte.
          </p>
        </>
      )}
    </>
  )
}

function MasterSoundControl() {
  const [muted, setMuted] = useState(soundEngine.isMuted())
  const [vol, setVol] = useState(0.6)
  const ready = soundEngine.isReady()

  if (!ready) return null

  const toggleMute = () => {
    const m = !muted
    soundEngine.setMuted(m)
    setMuted(m)
  }
  const onVol = (v: number) => {
    setVol(v)
    soundEngine.setMasterVolume(v)
  }

  return (
    <div style={{ marginTop: 16, padding: 10, background: 'var(--bg)', borderRadius: 'var(--radius-sm)', border: '1px dashed var(--line)' }}>
      <h3 style={{ marginTop: 0 }}>🎚️ Mixer global</h3>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <button onClick={toggleMute} className={muted ? 'danger' : 'primary'} style={{ flexShrink: 0 }}>
          {muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
          {muted ? 'Muet' : 'Audio ON'}
        </button>
      </div>
      <Slider label="Volume master" value={vol} min={0} max={1} step={0.01} onChange={onVol} format={(v) => `${Math.round(v * 100)}%`} />
    </div>
  )
}

const PATTERNS: { value: TestPattern; label: string }[] = [
  { value: 'none', label: 'Aucun' },
  { value: 'grid', label: 'Grille' },
  { value: 'white', label: 'Blanc' },
  { value: 'black', label: 'Noir' },
  { value: 'colorbars', label: 'Color bars' },
  { value: 'crosshair', label: 'Mire' },
  { value: 'gradient', label: 'Gradient' },
]

function MappingTab() {
  const current = useSceneStore((s) => s.scenes.find((x) => x.id === s.currentId))!
  const update = useSceneStore((s) => s.updateMapping)
  const addShape = useSceneStore((s) => s.addMappingShape)
  const removeShape = useSceneStore((s) => s.removeMappingShape)
  const updateShape = useSceneStore((s) => s.updateMappingShape)
  const selectShape = useSceneStore((s) => s.selectMappingShape)
  const setTestPattern = useSceneStore((s) => s.setTestPattern)
  const m = current.mapping
  const shapes = m.shapes ?? []
  const selectedIdx = m.selectedShape ?? 0
  const selectedShape = shapes[selectedIdx]

  return (
    <div className="section">
      <h3>Projection mapping</h3>
      <label style={{ display: 'flex', gap: 8, cursor: 'pointer', userSelect: 'none', marginBottom: 12 }}>
        <input
          type="checkbox"
          checked={m.enabled}
          onChange={(e) => update({ enabled: e.target.checked })}
        />
        <span>Activer le mapping</span>
      </label>

      <h3 style={{ marginTop: 10 }}>Zones (Kantan-style)</h3>
      <p style={{ fontSize: 11, color: 'var(--text-mute)', marginBottom: 8 }}>
        Chaque zone projette une portion du rendu sur un quadrilatère de la sortie.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
        {shapes.length === 0 && (
          <p style={{ fontSize: 11, color: 'var(--text-mute)', fontStyle: 'italic' }}>
            Aucune zone — comportement par défaut : plein cadre identique.
          </p>
        )}
        {shapes.map((sh, i) => (
          <div
            key={sh.id}
            onClick={() => selectShape(i)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 8px',
              border: `1px solid ${i === selectedIdx ? 'var(--accent)' : 'var(--line)'}`,
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
              opacity: sh.enabled ? 1 : 0.5,
              background: i === selectedIdx ? 'var(--bg-elev-2)' : 'transparent',
            }}
          >
            <button
              className="ghost icon"
              onClick={(e) => { e.stopPropagation(); updateShape(sh.id, { enabled: !sh.enabled }) }}
              title={sh.enabled ? 'Masquer' : 'Afficher'}
              style={{ padding: 2 }}
            >
              {sh.enabled ? <Eye size={12} /> : <EyeOff size={12} />}
            </button>
            <input
              value={sh.name}
              onChange={(e) => updateShape(sh.id, { name: e.target.value })}
              onClick={(e) => e.stopPropagation()}
              style={{ flex: 1, background: 'transparent', border: 'none', padding: 2, fontSize: 12 }}
            />
            <button
              className="ghost icon danger"
              onClick={(e) => { e.stopPropagation(); if (confirm(`Supprimer ${sh.name} ?`)) removeShape(sh.id) }}
              style={{ padding: 2 }}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
      <button onClick={addShape} style={{ width: '100%', justifyContent: 'center' }}>
        <Plus size={12} /> Ajouter une zone
      </button>

      {selectedShape && (
        <div style={{ marginTop: 12, padding: 10, background: 'var(--bg)', borderRadius: 'var(--radius-sm)' }}>
          <h3 style={{ marginTop: 0 }}><Crop size={11} style={{ verticalAlign: 'middle' }} /> Source de {selectedShape.name}</h3>
          <p style={{ fontSize: 11, color: 'var(--text-mute)', marginBottom: 8 }}>
            Quelle partie du rendu cette zone affiche (en %).
          </p>
          <Slider label="X" value={selectedShape.source.x} min={0} max={1} step={0.01} onChange={(x) => updateShape(selectedShape.id, { source: { ...selectedShape.source, x } })} format={(x) => `${Math.round(x * 100)}%`} />
          <Slider label="Y" value={selectedShape.source.y} min={0} max={1} step={0.01} onChange={(y) => updateShape(selectedShape.id, { source: { ...selectedShape.source, y } })} format={(y) => `${Math.round(y * 100)}%`} />
          <Slider label="Largeur" value={selectedShape.source.w} min={0.05} max={1} step={0.01} onChange={(w) => updateShape(selectedShape.id, { source: { ...selectedShape.source, w } })} format={(w) => `${Math.round(w * 100)}%`} />
          <Slider label="Hauteur" value={selectedShape.source.h} min={0.05} max={1} step={0.01} onChange={(h) => updateShape(selectedShape.id, { source: { ...selectedShape.source, h } })} format={(h) => `${Math.round(h * 100)}%`} />
          <button onClick={() => updateShape(selectedShape.id, { corners: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 }] })} style={{ width: '100%', justifyContent: 'center', fontSize: 12 }}>
            Réinitialiser les coins
          </button>
        </div>
      )}

      <h3 style={{ marginTop: 14 }}>🎯 Test pattern (calibration)</h3>
      <p style={{ fontSize: 11, color: 'var(--text-mute)', marginBottom: 8 }}>
        Affiche une mire à la place du rendu — aligne ton projecteur sur la surface.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4 }}>
        {PATTERNS.map((p) => (
          <button
            key={p.value}
            className={(m.testPattern ?? 'none') === p.value ? 'primary' : ''}
            onClick={() => setTestPattern(p.value)}
            style={{ fontSize: 11, padding: '5px 4px', justifyContent: 'center' }}
          >
            {p.label}
          </button>
        ))}
      </div>

      <h3 style={{ marginTop: 14 }}>Edge blend (multi-projecteurs)</h3>
      <Slider label="Gauche" value={m.edgeBlend.left} min={0} max={0.4} step={0.01} onChange={(x) => update({ edgeBlend: { ...m.edgeBlend, left: x } })} />
      <Slider label="Droite" value={m.edgeBlend.right} min={0} max={0.4} step={0.01} onChange={(x) => update({ edgeBlend: { ...m.edgeBlend, right: x } })} />
      <Slider label="Haut" value={m.edgeBlend.top} min={0} max={0.4} step={0.01} onChange={(x) => update({ edgeBlend: { ...m.edgeBlend, top: x } })} />
      <Slider label="Bas" value={m.edgeBlend.bottom} min={0} max={0.4} step={0.01} onChange={(x) => update({ edgeBlend: { ...m.edgeBlend, bottom: x } })} />
      <Slider label="Gamma" value={m.edgeBlend.gamma} min={1} max={4} step={0.1} onChange={(x) => update({ edgeBlend: { ...m.edgeBlend, gamma: x } })} />

      <h3 style={{ marginTop: 14 }}>📍 Profils de calibration (sites)</h3>
      <CalibrationProfiles />
    </div>
  )
}

function CalibrationProfiles() {
  const current = useSceneStore((s) => s.scenes.find((x) => x.id === s.currentId))!
  const update = useSceneStore((s) => s.updateMapping)
  const [profiles, setProfiles] = useState<CalibrationProfile[]>([])
  const [name, setName] = useState('')
  const [site, setSite] = useState('')

  const refresh = async () => setProfiles(await listCalibrations())
  useEffect(() => { refresh() }, [])

  const save = async () => {
    if (!name.trim()) return
    const id = `cal-${Date.now().toString(36)}`
    await saveCalibration({
      id, name: name.trim(), site: site.trim() || undefined,
      mapping: current.mapping,
      createdAt: Date.now(), updatedAt: Date.now(),
    })
    setName(''); setSite('')
    await refresh()
  }

  const apply = (p: CalibrationProfile) => {
    update({
      enabled: p.mapping.enabled,
      corners: p.mapping.corners,
      shapes: p.mapping.shapes,
      selectedShape: p.mapping.selectedShape,
      edgeBlend: p.mapping.edgeBlend,
    })
  }

  const remove = async (id: string) => {
    if (!confirm('Supprimer ce profil ?')) return
    await deleteCalibration(id)
    await refresh()
  }

  return (
    <>
      <p style={{ fontSize: 11, color: 'var(--text-mute)', marginBottom: 8 }}>
        Sauvegarde la calibration courante pour la rappeler sur une autre scène ou un autre jour.
      </p>
      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom du profil" style={{ flex: 1, fontSize: 12 }} />
        <button className="primary" disabled={!name.trim()} onClick={save}><Save size={12} /></button>
      </div>
      <input value={site} onChange={(e) => setSite(e.target.value)} placeholder="Site / lieu (optionnel)" style={{ width: '100%', fontSize: 12, marginBottom: 10 }} />
      {profiles.length === 0 && <p style={{ fontSize: 11, color: 'var(--text-mute)', fontStyle: 'italic' }}>Aucun profil sauvegardé.</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {profiles.map((p) => (
          <div key={p.id} style={{
            display: 'flex', alignItems: 'center', gap: 4,
            padding: '6px 8px',
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--bg)',
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</div>
              {p.site && <div style={{ fontSize: 10, color: 'var(--text-mute)' }}>{p.site}</div>}
            </div>
            <button className="ghost icon" onClick={() => apply(p)} title="Appliquer"><FolderOpen size={12} /></button>
            <button className="ghost icon" onClick={() => exportCalibration(p)} title="Exporter"><Download size={12} /></button>
            <button className="ghost icon danger" onClick={() => remove(p.id)} title="Supprimer"><Trash2 size={12} /></button>
          </div>
        ))}
      </div>
    </>
  )
}
