import { useState, useEffect, useRef } from 'react'
import { Sparkles, X, Loader, Plus, Trash2, Eye, EyeOff, Video, VideoOff, Crop, Save, Download, FolderOpen, Hand, User, Circle, Pentagon, Shapes, Music2, Volume2, VolumeX, Wand2, Bone, Pipette, Wind, Navigation, Bug, Palette, Activity, Map as MapIcon, StickyNote, Film, Image as ImageIcon, Camera as CameraIcon } from 'lucide-react'
import { useSceneStore } from '../store/sceneStore'
import type { OrganismKind, TestPattern, ObstacleInteraction, Waveform, SoundConfig } from '../types/scene'
import { LiveImg2Img } from '../lib/liveImg2Img'
import { soundEngine } from '../engine/SoundEngine'
import { SOUND_PRESETS, applyPreset } from '../lib/soundPresets'
import { JOINT_LABELS } from '../senses/SenseBus'
import { importSVG } from '../lib/svgImport'
import { defaultShape } from '../types/scene'
import { SHAPE_TEMPLATES } from '../lib/shapeTemplates'
import { MidiMonitor } from './MidiMonitor'
import { VirtualMidi } from './VirtualMidi'

function hsvToCss(h: number, s: number, v: number): string {
  // HSV → HSL: l = v - vs/2, s_hsl = (v - l) / min(l, 1 - l)
  const l = v - v * s / 2
  const sHsl = (l === 0 || l === 1) ? 0 : (v - l) / Math.min(l, 1 - l)
  return `hsl(${Math.round(h * 360)} ${Math.round(sHsl * 100)}% ${Math.round(l * 100)}%)`
}
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
  worms: { count: 18, segments: 36, speed: 0.7, twist: 1.3, thickness: 0.01, trail: 0.93, segLen: 0.025 },
  spores: { count: 800, speed: 0.5, size: 0.012, bloomGain: 0.7, bloomDecay: 1.2, reactToObstacles: 1, trail: 0.9 },
  psychedelic: { count: 4000, speed: 1.0, freq: 5.0, scale: 1.0, trail: 0.94, size: 2.5 },
  mandala: { arms: 8, pointsPerArm: 64, outerRadius: 0.85, innerRadius: 0.05, waves: 3, freq: 1.0, rotation: 0.3, thickness: 0.008, layers: 2, connectors: 2, connectorOpacity: 0.4 },
  fractal: { iterations: 120, zoom: 1.0, cx: -0.7, cy: 0.27, followHand: 0.6, bailout: 4, brightness: 1.0, orbitSpeed: 0.3, orbitRadius: 0.12, rotation: 0.15, zoomBreath: 0.08 },
  mathcurve: { formula: 'lissajous', samples: 800, cycles: 1, a: 3, b: 5, c: 1, d: 0, scale: 0.8, speed: 0.5, thickness: 0.005, lineOpacity: 0.6 } as any,
  reactiondiffusion: { preset: 'coral', F: 0.029, k: 0.057, du: 1.0, dv: 0.5, resolution: 512, stepsPerFrame: 8, splatSize: 0.04, splatStrength: 0.9, contrast: 1.5 } as any,
  cellularautomata: { rule: 'conway', resolution: 256, ticksPerSec: 12, ageDecay: 0.92, brushSize: 0.03, brushStrength: 0.6, autoReseed: 0.5 } as any,
  hilbert: { order: 5, scale: 1, progress: 1, autoProgress: 0.15, rotation: 0.1, thickness: 0.005, handPull: 0.5, showPoints: 1, hueAlongCurve: 0.5 } as any,
  menger: { depth: 3, autoOrbitSpeed: 0.4, fov: 55, twistAmount: 0.3, cubeSize: 0.95, ambient: 0.3, bloom: 0.3 } as any,
  supershape3d: { m1: 6, n1: 0.6, n2: 0.5, n3: 1.5, m2: 8, n4: 0.6, n5: 0.5, n6: 1.5, resolution: 64, scale: 1, autoOrbitSpeed: 0.3, fov: 55, morphSpeed: 0.3, pointSize: 2, wireframe: 1 } as any,
  swarm3d: { count: 600, speed: 1.2, cohesion: 0.6, separation: 0.8, alignment: 0.5, vision: 0.18, bounds: 1, pointSize: 2, autoOrbitSpeed: 0.25, fov: 55, trail: 0.5 } as any,
  crystal: { maxCubes: 1500, growthRate: 12, cubeSize: 0.95, gridResolution: 28, autoOrbitSpeed: 0.3, fov: 55, ambient: 0.4, emissive: 0.2 } as any,
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
        <button className={`tab ${tab === 'organism' ? 'active' : ''}`} onClick={() => setTab('organism')} title="Organisme">
          <Bug size={13} /> <span className="tab-label">Vie</span>
        </button>
        <button className={`tab ${tab === 'visual' ? 'active' : ''}`} onClick={() => setTab('visual')} title="Visuel">
          <Palette size={13} /> <span className="tab-label">Visuel</span>
        </button>
        <button className={`tab ${tab === 'senses' ? 'active' : ''}`} onClick={() => setTab('senses')} title="Sens & Flux">
          <Activity size={13} /> <span className="tab-label">Sens</span>
        </button>
        <button className={`tab ${tab === 'obstacles' ? 'active' : ''}`} onClick={() => setTab('obstacles')} title="Obstacles physiques">
          <Shapes size={13} /> <span className="tab-label">Obs.</span>
        </button>
        <button className={`tab ${tab === 'mapping' ? 'active' : ''}`} onClick={() => setTab('mapping')} title="Projection mapping">
          <MapIcon size={13} /> <span className="tab-label">Map</span>
        </button>
        <button className={`tab ${tab === 'notes' ? 'active' : ''}`} onClick={() => setTab('notes')} title="Notes">
          <StickyNote size={13} /> <span className="tab-label">Notes</span>
        </button>
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
              <option value="worms">🐍 Worms — serpents (rope physics)</option>
              <option value="spores">🌸 Spores — bloom à l'impact</option>
              <option value="psychedelic">🌀 Psychédélique — galaxie 3D-feel</option>
              <option value="mandala">🪷 Mandala — symétrie radiale</option>
              <option value="fractal">🌌 Fractale — Julia set GPU</option>
              <option value="mathcurve">📐 Courbe math — Lissajous, Rose, Spirograph...</option>
              <option value="reactiondiffusion">🪸 Réaction-Diffusion — Gray-Scott (coral, mitosis...)</option>
              <option value="cellularautomata">⬛ Automate cellulaire — Conway, HighLife...</option>
              <option value="hilbert">🌀 Courbe de Hilbert — space-filling fractale</option>
              <option value="menger">🧊 Éponge de Menger — fractale 3D navigable</option>
              <option value="supershape3d">🌐 SuperShape 3D — surface morphable (Bourke)</option>
              <option value="swarm3d">🐝 Essaim 3D — boids dans un cube</option>
              <option value="crystal">💎 Cristal — croissance par accrétion</option>
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
                <Slider label="Taille de la poussière" value={v.size} min={0.2} max={8} step={0.1} onChange={(x) => patchValues({ size: x })} format={(x) => x.toFixed(1)} />
                <Slider label="Dispersion" value={v.spread} min={0.2} max={2} onChange={(x) => patchValues({ spread: x })} />
                <Slider label="Gravité" value={v.gravity} min={-1} max={1} onChange={(x) => patchValues({ gravity: x })} />
                <Slider label="Turbulence" value={v.turbulence} min={0} max={2} onChange={(x) => patchValues({ turbulence: x })} />
                <div className="palette-row" style={{ marginTop: 8 }}>
                  <label>Bords</label>
                  <select
                    value={(v as any).boundary ?? 'respawn'}
                    onChange={(e) => patchValues({ boundary: e.target.value })}
                    title="Comportement quand une particule sort de l'écran"
                  >
                    <option value="respawn">♻️ Respawn (recyclage central)</option>
                    <option value="wrap">🔁 Wrap (passe par les bords — pluie infinie)</option>
                    <option value="kill">💀 Kill (disparaît — la population baisse)</option>
                  </select>
                </div>
                <p style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 4, marginBottom: 0, lineHeight: 1.35 }}>
                  Pour un effet pluie/neige continu : choisis <strong>Wrap</strong> + gravité positive +
                  un obstacle circulaire <em>"avoid"</em> en bas (le "parapluie").
                </p>
              </>
            )}
            {current.organism.kind === 'tendrils' && (
              <>
                <Slider label="Nombre" value={v.count} min={4} max={80} step={1} onChange={(x) => patchValues({ count: Math.round(x) })} format={(x) => Math.round(x).toString()} />
                <Slider label="Longueur" value={v.length} min={8} max={64} step={1} onChange={(x) => patchValues({ length: Math.round(x) })} format={(x) => Math.round(x).toString()} />
                <Slider label="Vitesse" value={v.speed} min={0.1} max={2} onChange={(x) => patchValues({ speed: x })} />
                <Slider label="Torsion" value={v.twist} min={0} max={4} onChange={(x) => patchValues({ twist: x })} />
                <Slider label="Épaisseur" value={v.thickness ?? 0.01} min={0.004} max={0.08} step={0.002} onChange={(x) => patchValues({ thickness: x })} format={(x) => x.toFixed(3)} />
              </>
            )}
            {current.organism.kind === 'cells' && (
              <>
                <Slider label="Population" value={v.count} min={4} max={200} step={1} onChange={(x) => patchValues({ count: Math.round(x) })} format={(x) => Math.round(x).toString()} />
                <Slider label="Pulsation" value={v.pulse} min={0} max={3} onChange={(x) => patchValues({ pulse: x })} />
                <Slider label="Taille" value={v.size} min={0.4} max={3} onChange={(x) => patchValues({ size: x })} />
                <Slider label="Attraction" value={v.attraction} min={0} max={2} onChange={(x) => patchValues({ attraction: x })} />
                <Slider label="Répulsion" value={v.repulsion} min={0} max={2} onChange={(x) => patchValues({ repulsion: x })} />
                <div className="palette-row" style={{ marginTop: 8 }}>
                  <label>Bords</label>
                  <select
                    value={(v as any).boundary ?? 'bounce'}
                    onChange={(e) => patchValues({ boundary: e.target.value })}
                    title="Comportement des cellules aux bords de l'écran"
                  >
                    <option value="bounce">↩️ Rebond (par défaut)</option>
                    <option value="wrap">🔁 Wrap (traverse les bords)</option>
                  </select>
                </div>
                <p style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 4, marginBottom: 0, lineHeight: 1.35 }}>
                  En mode <strong>Wrap</strong> avec un flux directionnel vers le bas, les cellules
                  s'écoulent en continu au lieu de s'accumuler contre le bord.
                </p>
              </>
            )}
            {current.organism.kind === 'worms' && (
              <>
                <Slider label="Nombre" value={v.count} min={2} max={40} step={1} onChange={(x) => patchValues({ count: Math.round(x) })} format={(x) => Math.round(x).toString()} />
                <Slider label="Segments" value={v.segments} min={8} max={48} step={1} onChange={(x) => patchValues({ segments: Math.round(x) })} format={(x) => Math.round(x).toString()} />
                <Slider label="Vitesse" value={v.speed} min={0.1} max={2} onChange={(x) => patchValues({ speed: x })} />
                <Slider label="Torsion" value={v.twist} min={0} max={3} onChange={(x) => patchValues({ twist: x })} />
                <Slider label="Longueur segment" value={v.segLen} min={0.01} max={0.06} step={0.002} onChange={(x) => patchValues({ segLen: x })} format={(x) => x.toFixed(3)} />
                <Slider label="Épaisseur" value={v.thickness ?? 0.01} min={0.004} max={0.08} step={0.002} onChange={(x) => patchValues({ thickness: x })} format={(x) => x.toFixed(3)} />
              </>
            )}
            {current.organism.kind === 'spores' && (
              <>
                <Slider label="Population" value={v.count} min={100} max={2500} step={50} onChange={(x) => patchValues({ count: Math.round(x) })} format={(x) => Math.round(x).toString()} />
                <Slider label="Vitesse" value={v.speed} min={0.1} max={2} onChange={(x) => patchValues({ speed: x })} />
                <Slider label="Taille de base" value={v.size} min={0.005} max={0.04} step={0.001} onChange={(x) => patchValues({ size: x })} format={(x) => x.toFixed(3)} />
                <Slider label="Force du bloom" value={v.bloomGain} min={0.1} max={1.5} step={0.05} onChange={(x) => patchValues({ bloomGain: x })} />
                <Slider label="Décrescendo bloom" value={v.bloomDecay} min={0.2} max={3} step={0.05} onChange={(x) => patchValues({ bloomDecay: x })} />
              </>
            )}
            {current.organism.kind === 'psychedelic' && (
              <>
                <p style={{ fontSize: 11, color: 'var(--text-mute)', marginBottom: 8 }}>
                  Galaxie swirling 3D-feel — la main décale le centre, le pinch accélère, les graves pulsent, les aigus vibrent.
                </p>
                <Slider label="Points (grille²)" value={v.count} min={400} max={6400} step={100} onChange={(x) => patchValues({ count: Math.round(x) })} format={(x) => `${Math.round(Math.sqrt(x))}²`} />
                <Slider label="Vitesse rotation" value={v.speed} min={0.1} max={3} onChange={(x) => patchValues({ speed: x })} />
                <Slider label="Fréquence interne" value={v.freq} min={1} max={10} step={0.1} onChange={(x) => patchValues({ freq: x })} />
                <Slider label="Échelle" value={v.scale} min={0.3} max={2} step={0.05} onChange={(x) => patchValues({ scale: x })} />
                <Slider label="Taille points" value={v.size} min={0.5} max={6} step={0.1} onChange={(x) => patchValues({ size: x })} />
              </>
            )}
            {current.organism.kind === 'mandala' && (
              <>
                <p style={{ fontSize: 11, color: 'var(--text-mute)', marginBottom: 8 }}>
                  Géométrie sacrée multi-couches — la main x contrôle les bras (3-16), pinch ouvre le centre, audio bass = respiration. Active les connecteurs pour les étoiles inscrites.
                </p>
                <Slider label="Bras" value={v.arms} min={3} max={24} step={1} onChange={(x) => patchValues({ arms: Math.round(x) })} format={(x) => Math.round(x).toString()} />
                <Slider label="Points par bras" value={v.pointsPerArm} min={16} max={128} step={4} onChange={(x) => patchValues({ pointsPerArm: Math.round(x) })} format={(x) => Math.round(x).toString()} />
                <Slider label="Couches superposées" value={v.layers ?? 1} min={1} max={3} step={1} onChange={(x) => patchValues({ layers: Math.round(x) })} format={(x) => Math.round(x).toString()} />
                <Slider label="Connecteurs (skip-lignes)" value={v.connectors ?? 0} min={0} max={6} step={1} onChange={(x) => patchValues({ connectors: Math.round(x) })} format={(x) => Math.round(x).toString()} />
                <Slider label="Opacité connecteurs" value={v.connectorOpacity ?? 0.4} min={0} max={1} step={0.05} onChange={(x) => patchValues({ connectorOpacity: x })} format={(x) => `${Math.round(x * 100)}%`} />
                <Slider label="Rayon extérieur" value={v.outerRadius} min={0.2} max={1.2} step={0.02} onChange={(x) => patchValues({ outerRadius: x })} />
                <Slider label="Rayon intérieur" value={v.innerRadius} min={0} max={0.5} step={0.01} onChange={(x) => patchValues({ innerRadius: x })} />
                <Slider label="Ondulations" value={v.waves} min={0} max={8} step={0.1} onChange={(x) => patchValues({ waves: x })} />
                <Slider label="Vitesse ondulation" value={v.freq} min={0.1} max={3} step={0.05} onChange={(x) => patchValues({ freq: x })} />
                <Slider label="Rotation" value={v.rotation} min={-2} max={2} step={0.05} onChange={(x) => patchValues({ rotation: x })} />
                <Slider label="Épaisseur points" value={v.thickness} min={0.001} max={0.03} step={0.0005} onChange={(x) => patchValues({ thickness: x })} format={(x) => x.toFixed(4)} />
              </>
            )}
            {current.organism.kind === 'fractal' && (
              <>
                <p style={{ fontSize: 11, color: 'var(--text-mute)', marginBottom: 8 }}>
                  Julia set GPU — la fractale s'anime toute seule (orbit, zoom respire, rotation). La main pilote c en live, pinch zoome, audio bass pulse la luminosité.
                </p>
                <Slider label="Itérations (précision)" value={v.iterations} min={32} max={256} step={4} onChange={(x) => patchValues({ iterations: Math.round(x) })} format={(x) => Math.round(x).toString()} />
                <Slider label="Zoom" value={v.zoom} min={0.3} max={5} step={0.05} onChange={(x) => patchValues({ zoom: x })} />
                <Slider label="c réel (cx)" value={v.cx} min={-1} max={1} step={0.005} onChange={(x) => patchValues({ cx: x })} format={(x) => x.toFixed(3)} />
                <Slider label="c imaginaire (cy)" value={v.cy} min={-1} max={1} step={0.005} onChange={(x) => patchValues({ cy: x })} format={(x) => x.toFixed(3)} />
                <Slider label="Suivi main" value={v.followHand} min={0} max={1} step={0.05} onChange={(x) => patchValues({ followHand: x })} format={(x) => `${Math.round(x * 100)}%`} />
                <Slider label="Vitesse orbite (auto)" value={v.orbitSpeed ?? 0.3} min={0} max={2} step={0.02} onChange={(x) => patchValues({ orbitSpeed: x })} />
                <Slider label="Rayon orbite (auto)" value={v.orbitRadius ?? 0.12} min={0} max={0.5} step={0.005} onChange={(x) => patchValues({ orbitRadius: x })} format={(x) => x.toFixed(3)} />
                <Slider label="Rotation plan (auto)" value={v.rotation ?? 0.15} min={-1} max={1} step={0.02} onChange={(x) => patchValues({ rotation: x })} />
                <Slider label="Respiration zoom" value={v.zoomBreath ?? 0.08} min={0} max={0.5} step={0.01} onChange={(x) => patchValues({ zoomBreath: x })} />
                <Slider label="Rayon échappement" value={v.bailout} min={2} max={20} step={0.5} onChange={(x) => patchValues({ bailout: x })} />
                <Slider label="Luminosité" value={v.brightness} min={0.3} max={2.5} step={0.05} onChange={(x) => patchValues({ brightness: x })} />
              </>
            )}
            {current.organism.kind === 'reactiondiffusion' && (
              <>
                <p style={{ fontSize: 11, color: 'var(--text-mute)', marginBottom: 8 }}>
                  Simulation chimique Gray-Scott GPU. La main "peint" des graines de V, audio bass = nourriture, audio high = mort. Change le preset pour explorer.
                </p>
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 10, color: 'var(--text-mute)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Preset</div>
                  <select value={(v as any).preset ?? 'coral'} onChange={(e) => patchValues({ preset: e.target.value as any })} style={{ width: '100%', fontSize: 12 }}>
                    <option value="coral">🪸 Coral (organique)</option>
                    <option value="spots">⚫ Spots (taches)</option>
                    <option value="mitosis">🌀 Mitosis (spirales)</option>
                    <option value="fingerprint">👆 Fingerprint (empreinte)</option>
                    <option value="worms">🪱 Worms (vers)</option>
                    <option value="maze">🧩 Maze (labyrinthe)</option>
                    <option value="pulse">💗 Pulse (pulsations)</option>
                  </select>
                </div>
                <Slider label="Feed (F)" value={v.F} min={0.005} max={0.08} step={0.001} onChange={(x) => patchValues({ F: x })} format={(x) => x.toFixed(3)} />
                <Slider label="Kill (k)" value={v.k} min={0.04} max={0.075} step={0.001} onChange={(x) => patchValues({ k: x })} format={(x) => x.toFixed(3)} />
                <Slider label="Résolution" value={v.resolution} min={128} max={1024} step={64} onChange={(x) => patchValues({ resolution: Math.round(x) })} format={(x) => `${Math.round(x)}²`} />
                <Slider label="Steps / frame" value={v.stepsPerFrame} min={1} max={16} step={1} onChange={(x) => patchValues({ stepsPerFrame: Math.round(x) })} format={(x) => Math.round(x).toString()} />
                <Slider label="Splat size" value={v.splatSize} min={0.01} max={0.2} step={0.005} onChange={(x) => patchValues({ splatSize: x })} format={(x) => x.toFixed(3)} />
                <Slider label="Splat strength" value={v.splatStrength} min={0} max={1} step={0.05} onChange={(x) => patchValues({ splatStrength: x })} />
                <Slider label="Contraste" value={v.contrast} min={0.5} max={3} step={0.1} onChange={(x) => patchValues({ contrast: x })} />
              </>
            )}
            {current.organism.kind === 'cellularautomata' && (
              <>
                <p style={{ fontSize: 11, color: 'var(--text-mute)', marginBottom: 8 }}>
                  Automate cellulaire GPU. La main "dessine" des cellules vivantes, audio bass kick = reseed aléatoire, audio mid = vitesse de tick.
                </p>
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 10, color: 'var(--text-mute)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Règle</div>
                  <select value={(v as any).rule ?? 'conway'} onChange={(e) => patchValues({ rule: e.target.value as any })} style={{ width: '100%', fontSize: 12 }}>
                    <option value="conway">Conway B3/S23 — Game of Life classique</option>
                    <option value="highlife">HighLife B36/S23 — réplicateurs</option>
                    <option value="seeds">Seeds B2/S — explose</option>
                    <option value="daedalus">Daedalus B3/S012-8 — croissance</option>
                    <option value="maze">Maze B3/S12345 — labyrinthe</option>
                    <option value="replicator">Replicator B1357/S1357 — autoréplique tout</option>
                  </select>
                </div>
                <Slider label="Résolution" value={v.resolution} min={64} max={512} step={32} onChange={(x) => patchValues({ resolution: Math.round(x) })} format={(x) => `${Math.round(x)}²`} />
                <Slider label="Vitesse (ticks/sec)" value={v.ticksPerSec} min={1} max={60} step={1} onChange={(x) => patchValues({ ticksPerSec: Math.round(x) })} format={(x) => Math.round(x).toString()} />
                <Slider label="Trail (fade)" value={v.ageDecay} min={0.5} max={0.99} step={0.005} onChange={(x) => patchValues({ ageDecay: x })} format={(x) => x.toFixed(3)} />
                <Slider label="Brush size" value={v.brushSize} min={0.005} max={0.1} step={0.005} onChange={(x) => patchValues({ brushSize: x })} format={(x) => x.toFixed(3)} />
                <Slider label="Brush strength" value={v.brushStrength} min={0} max={1} step={0.05} onChange={(x) => patchValues({ brushStrength: x })} />
                <Slider label="Auto-reseed (bass)" value={v.autoReseed} min={0} max={1} step={0.05} onChange={(x) => patchValues({ autoReseed: x })} />
              </>
            )}
            {current.organism.kind === 'hilbert' && (
              <>
                <p style={{ fontSize: 11, color: 'var(--text-mute)', marginBottom: 8 }}>
                  Courbe de Hilbert space-filling. Ordre N = 4^N points. La main pull la courbe, audio bass pulse, autoProgress dessine progressivement.
                </p>
                <Slider label="Ordre" value={v.order} min={1} max={7} step={1} onChange={(x) => patchValues({ order: Math.round(x) })} format={(x) => `${Math.round(x)} (${Math.pow(4, Math.round(x))} pts)`} />
                <Slider label="Échelle" value={v.scale} min={0.3} max={1.5} step={0.02} onChange={(x) => patchValues({ scale: x })} />
                <Slider label="Progress" value={v.progress} min={0} max={1} step={0.01} onChange={(x) => patchValues({ progress: x })} format={(x) => `${Math.round(x * 100)}%`} />
                <Slider label="Auto-progress" value={v.autoProgress} min={0} max={2} step={0.02} onChange={(x) => patchValues({ autoProgress: x })} />
                <Slider label="Rotation (rad/s)" value={v.rotation} min={-2} max={2} step={0.05} onChange={(x) => patchValues({ rotation: x })} />
                <Slider label="Épaisseur points" value={v.thickness} min={0.001} max={0.02} step={0.0005} onChange={(x) => patchValues({ thickness: x })} format={(x) => x.toFixed(4)} />
                <Slider label="Attraction main" value={v.handPull} min={0} max={1} step={0.05} onChange={(x) => patchValues({ handPull: x })} />
                <Slider label="Décalage teinte" value={v.hueAlongCurve} min={0} max={1} step={0.05} onChange={(x) => patchValues({ hueAlongCurve: x })} />
                <label style={{ display: 'flex', gap: 6, fontSize: 11, marginTop: 4, cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!v.showPoints} onChange={(e) => patchValues({ showPoints: e.target.checked ? 1 : 0 })} />
                  Afficher les sommets (points sur la courbe)
                </label>
              </>
            )}
            {current.organism.kind === 'menger' && (
              <>
                <p style={{ fontSize: 11, color: 'var(--text-mute)', marginBottom: 8 }}>
                  Éponge de Menger 3D — fractale cubique récursive navigable. La main x change la vitesse d'orbite, la main y le tilt vertical, pinch zoome, audio bass pulse l'échelle, audio high décale la teinte.
                </p>
                <Slider label="Profondeur (subdivisions)" value={v.depth} min={1} max={4} step={1} onChange={(x) => patchValues({ depth: Math.round(x) })} format={(x) => `${Math.round(x)} (${Math.pow(20, Math.round(x))} cubes)`} />
                <Slider label="Vitesse orbite auto" value={v.autoOrbitSpeed} min={0} max={3} step={0.05} onChange={(x) => patchValues({ autoOrbitSpeed: x })} />
                <Slider label="FOV (deg)" value={v.fov} min={30} max={90} step={1} onChange={(x) => patchValues({ fov: Math.round(x) })} format={(x) => Math.round(x).toString()} />
                <Slider label="Torsion" value={v.twistAmount} min={0} max={2} step={0.05} onChange={(x) => patchValues({ twistAmount: x })} />
                <Slider label="Taille cube (fraction)" value={v.cubeSize} min={0.6} max={1.05} step={0.01} onChange={(x) => patchValues({ cubeSize: x })} />
                <Slider label="Lumière ambiante" value={v.ambient} min={0} max={1} step={0.05} onChange={(x) => patchValues({ ambient: x })} />
                <Slider label="Bloom (gain palette)" value={v.bloom} min={0} max={1} step={0.05} onChange={(x) => patchValues({ bloom: x })} />
              </>
            )}
            {current.organism.kind === 'supershape3d' && (
              <>
                <p style={{ fontSize: 11, color: 'var(--text-mute)', marginBottom: 8 }}>
                  Surface 3D paramétrique (Paul Bourke). Selon (m1,m2,n1-n6), tu obtiens sphères, étoiles, fleurs, créatures alien. Main x = orbite, main y = morph m1↔m2 en live, audio bass = rondeur, morphSpeed = auto-évolution.
                </p>
                <Slider label="m1 (symétrie latitude)" value={v.m1} min={0} max={16} step={0.1} onChange={(x) => patchValues({ m1: x })} format={(x) => x.toFixed(1)} />
                <Slider label="n1 (rondeur lat)" value={v.n1} min={0.1} max={4} step={0.05} onChange={(x) => patchValues({ n1: x })} />
                <Slider label="n2 (étirement lat)" value={v.n2} min={0.1} max={4} step={0.05} onChange={(x) => patchValues({ n2: x })} />
                <Slider label="n3 (anti-étirement lat)" value={v.n3} min={0.1} max={4} step={0.05} onChange={(x) => patchValues({ n3: x })} />
                <Slider label="m2 (symétrie longitude)" value={v.m2} min={0} max={16} step={0.1} onChange={(x) => patchValues({ m2: x })} format={(x) => x.toFixed(1)} />
                <Slider label="n4 (rondeur lon)" value={v.n4} min={0.1} max={4} step={0.05} onChange={(x) => patchValues({ n4: x })} />
                <Slider label="n5 (étirement lon)" value={v.n5} min={0.1} max={4} step={0.05} onChange={(x) => patchValues({ n5: x })} />
                <Slider label="n6 (anti-étirement lon)" value={v.n6} min={0.1} max={4} step={0.05} onChange={(x) => patchValues({ n6: x })} />
                <Slider label="Résolution (grille)" value={v.resolution} min={16} max={128} step={4} onChange={(x) => patchValues({ resolution: Math.round(x) })} format={(x) => `${Math.round(x)}²`} />
                <Slider label="Échelle" value={v.scale} min={0.3} max={2} step={0.05} onChange={(x) => patchValues({ scale: x })} />
                <Slider label="Orbite caméra" value={v.autoOrbitSpeed} min={0} max={3} step={0.05} onChange={(x) => patchValues({ autoOrbitSpeed: x })} />
                <Slider label="FOV" value={v.fov} min={30} max={90} step={1} onChange={(x) => patchValues({ fov: Math.round(x) })} format={(x) => Math.round(x).toString()} />
                <Slider label="Vitesse morph auto" value={v.morphSpeed} min={0} max={2} step={0.05} onChange={(x) => patchValues({ morphSpeed: x })} />
                <Slider label="Taille points" value={v.pointSize} min={0.5} max={6} step={0.1} onChange={(x) => patchValues({ pointSize: x })} />
                <label style={{ display: 'flex', gap: 6, fontSize: 11, marginTop: 4, cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!v.wireframe} onChange={(e) => patchValues({ wireframe: e.target.checked ? 1 : 0 })} />
                  Wireframe (lignes entre sommets)
                </label>
              </>
            )}
            {current.organism.kind === 'swarm3d' && (
              <>
                <p style={{ fontSize: 11, color: 'var(--text-mute)', marginBottom: 8 }}>
                  Boids en 3D — main x = cohésion, main y = séparation, audio mid = vitesse, audio high = alignement. <strong>Glisse la souris</strong> pour orbiter, <strong>molette</strong> pour zoomer.
                </p>
                <Slider label="Population" value={v.count} min={50} max={3000} step={50} onChange={(x) => patchValues({ count: Math.round(x) })} format={(x) => Math.round(x).toString()} />
                <Slider label="Vitesse max" value={v.speed} min={0.1} max={3} step={0.05} onChange={(x) => patchValues({ speed: x })} />
                <Slider label="Cohésion" value={v.cohesion} min={0} max={2} step={0.05} onChange={(x) => patchValues({ cohesion: x })} />
                <Slider label="Séparation" value={v.separation} min={0} max={2} step={0.05} onChange={(x) => patchValues({ separation: x })} />
                <Slider label="Alignement" value={v.alignment} min={0} max={2} step={0.05} onChange={(x) => patchValues({ alignment: x })} />
                <Slider label="Rayon perception" value={v.vision} min={0.05} max={0.5} step={0.01} onChange={(x) => patchValues({ vision: x })} format={(x) => x.toFixed(2)} />
                <Slider label="Taille cube" value={v.bounds} min={0.6} max={1.5} step={0.05} onChange={(x) => patchValues({ bounds: x })} />
                <Slider label="Taille points" value={v.pointSize} min={0.5} max={6} step={0.1} onChange={(x) => patchValues({ pointSize: x })} />
                <Slider label="Orbite caméra" value={v.autoOrbitSpeed} min={0} max={3} step={0.05} onChange={(x) => patchValues({ autoOrbitSpeed: x })} />
                <Slider label="FOV" value={v.fov} min={30} max={90} step={1} onChange={(x) => patchValues({ fov: Math.round(x) })} format={(x) => Math.round(x).toString()} />
                <Slider label="Opacité (trail)" value={v.trail} min={0} max={1} step={0.05} onChange={(x) => patchValues({ trail: x })} />
              </>
            )}
            {current.organism.kind === 'crystal' && (
              <>
                <p style={{ fontSize: 11, color: 'var(--text-mute)', marginBottom: 8 }}>
                  Cristal qui pousse par accrétion. Audio bass = vitesse de cristallisation, audio high = nouveaux nucléi, main = position des prochains cubes. <strong>Glisse la souris</strong> pour orbiter.
                </p>
                <Slider label="Cubes max" value={v.maxCubes} min={200} max={4000} step={100} onChange={(x) => patchValues({ maxCubes: Math.round(x) })} format={(x) => Math.round(x).toString()} />
                <Slider label="Vitesse croissance" value={v.growthRate} min={1} max={30} step={0.5} onChange={(x) => patchValues({ growthRate: x })} />
                <Slider label="Résolution grille" value={v.gridResolution} min={16} max={64} step={2} onChange={(x) => patchValues({ gridResolution: Math.round(x) })} format={(x) => `${Math.round(x)}³`} />
                <Slider label="Taille cube (fraction)" value={v.cubeSize} min={0.6} max={1.05} step={0.02} onChange={(x) => patchValues({ cubeSize: x })} />
                <Slider label="Orbite caméra" value={v.autoOrbitSpeed} min={0} max={3} step={0.05} onChange={(x) => patchValues({ autoOrbitSpeed: x })} />
                <Slider label="FOV" value={v.fov} min={30} max={90} step={1} onChange={(x) => patchValues({ fov: Math.round(x) })} format={(x) => Math.round(x).toString()} />
                <Slider label="Lumière ambiante" value={v.ambient} min={0} max={1} step={0.05} onChange={(x) => patchValues({ ambient: x })} />
                <Slider label="Émissif (glow)" value={v.emissive} min={0} max={0.5} step={0.02} onChange={(x) => patchValues({ emissive: x })} />
              </>
            )}
            {current.organism.kind === 'mathcurve' && (
              <>
                <p style={{ fontSize: 11, color: 'var(--text-mute)', marginBottom: 8 }}>
                  Courbe paramétrique math — choisis une formule, ajuste ses paramètres a/b/c/d. La main x/y dérive a/b en live.
                </p>
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 10, color: 'var(--text-mute)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Formule</div>
                  <select
                    value={(v as any).formula ?? 'lissajous'}
                    onChange={(e) => patchValues({ formula: e.target.value as any })}
                    style={{ width: '100%', fontSize: 12 }}
                  >
                    <option value="lissajous">∞ Lissajous (a, b, d=phase)</option>
                    <option value="rose">🌹 Rose / Rhodonea (a=pétales, b, c)</option>
                    <option value="spirograph">⚙ Spirograph (a=R, b=tours, c=r, d=offset)</option>
                    <option value="butterfly">🦋 Butterfly de Fay (a, b)</option>
                    <option value="lorenz">🦋 Lorenz attractor (chaos, a=vitesse)</option>
                    <option value="heart">❤ Cardioïde / cœur (a, b)</option>
                  </select>
                </div>
                <Slider label="Échantillons" value={v.samples} min={100} max={4000} step={50} onChange={(x) => patchValues({ samples: Math.round(x) })} format={(x) => Math.round(x).toString()} />
                <Slider label="Cycles (périodes)" value={v.cycles} min={0.1} max={10} step={0.1} onChange={(x) => patchValues({ cycles: x })} format={(x) => x.toFixed(1)} />
                <Slider label="Paramètre a" value={v.a} min={0.1} max={12} step={0.1} onChange={(x) => patchValues({ a: x })} format={(x) => x.toFixed(2)} />
                <Slider label="Paramètre b" value={v.b} min={0.1} max={12} step={0.1} onChange={(x) => patchValues({ b: x })} format={(x) => x.toFixed(2)} />
                <Slider label="Paramètre c" value={v.c} min={0} max={5} step={0.05} onChange={(x) => patchValues({ c: x })} format={(x) => x.toFixed(2)} />
                <Slider label="Paramètre d (phase)" value={v.d} min={-3.14} max={3.14} step={0.05} onChange={(x) => patchValues({ d: x })} format={(x) => x.toFixed(2)} />
                <Slider label="Échelle" value={v.scale} min={0.1} max={2} step={0.05} onChange={(x) => patchValues({ scale: x })} />
                <Slider label="Vitesse animation" value={v.speed} min={0} max={3} step={0.05} onChange={(x) => patchValues({ speed: x })} />
                <Slider label="Épaisseur points" value={v.thickness} min={0.001} max={0.02} step={0.0005} onChange={(x) => patchValues({ thickness: x })} format={(x) => x.toFixed(4)} />
                <Slider label="Opacité ligne" value={v.lineOpacity} min={0} max={1} step={0.05} onChange={(x) => patchValues({ lineOpacity: x })} format={(x) => `${Math.round(x * 100)}%`} />
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

            <WebcamFilterPanel />

            <OrganismMaskPanel />
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

  const toggle = (key: 'hands' | 'audio' | 'light' | 'midi') => {
    (current.senses as any)[key] = !(current.senses as any)[key]
    setScenes()
    // trigger react
    useSceneStore.setState({ scenes: [...useSceneStore.getState().scenes] })
  }

  // "Obstacles physiques uniquement" preset — turns off every reactive sensor
  // for this scene. Webcam / micro restent dispos en haut pour AR ou autres
  // scènes ; cette scène-ci ignore juste leurs valeurs.
  const setObstaclesOnly = () => {
    (current.senses as any).hands = false
    ;(current.senses as any).audio = false
    ;(current.senses as any).light = false
    ;(current.senses as any).midi = false
    setScenes()
    useSceneStore.setState({ scenes: [...useSceneStore.getState().scenes] })
  }
  const setAllOn = () => {
    (current.senses as any).hands = true
    ;(current.senses as any).audio = true
    ;(current.senses as any).light = true
    setScenes()
    useSceneStore.setState({ scenes: [...useSceneStore.getState().scenes] })
  }
  const allOff = !current.senses.hands && !current.senses.audio && !current.senses.light && !(current.senses as any).midi

  return (
    <div className="section">
      <h3>Capteurs actifs <span style={{ fontSize: 10, color: 'var(--text-mute)', fontWeight: 400 }}>· filtres de cette scène</span></h3>
      <p style={{ fontSize: 11, color: 'var(--text-mute)', marginBottom: 8, lineHeight: 1.5 }}>
        Décide ce que cette scène écoute. Décocher un capteur n'éteint pas le périphérique
        (la <strong>Caméra</strong>/<strong>Micro</strong> en haut restent dispos pour AR ou d'autres scènes) — seule
        la scène courante ignore les valeurs entrantes.
      </p>
      <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
        <button
          onClick={setObstaclesOnly}
          className={allOff ? 'primary' : ''}
          style={{ flex: 1, fontSize: 11, justifyContent: 'center' }}
          title="Désactive tracking main, micro et lumière — seuls les obstacles dessinés (cercle/polygone) influencent la scène."
        >
          🧱 Obstacles physiques seuls
        </button>
        <button
          onClick={setAllOn}
          style={{ flex: 1, fontSize: 11, justifyContent: 'center' }}
          title="Réactive tout"
        >
          🎛️ Tout activer
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label style={{ display: 'flex', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
          <input type="checkbox" checked={current.senses.hands} onChange={() => toggle('hands')} />
          <span>🖐️ Tracking main + corps (MediaPipe)</span>
        </label>
        <label style={{ display: 'flex', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
          <input type="checkbox" checked={current.senses.audio} onChange={() => toggle('audio')} />
          <span>🎵 Microphone (FFT)</span>
        </label>
        <label style={{ display: 'flex', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
          <input type="checkbox" checked={current.senses.light} onChange={() => toggle('light')} />
          <span>💡 Lumière ambiante</span>
        </label>
        <label style={{ display: 'flex', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
          <input type="checkbox" checked={(current.senses as any).midi ?? false} onChange={() => toggle('midi')} />
          <span>🎹 MIDI (contrôleur externe)</span>
        </label>
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 12, lineHeight: 1.5 }}>
        La main attire les organismes ; le pinch intensifie l'effet ;
        les graves font respirer la taille ; médiums/aigus modulent vitesse.
      </p>

      <h3 style={{ marginTop: 18 }}>📡 Moniteur MIDI</h3>
      <MidiMonitor />
      <VirtualMidi />

      <BindingsManager />

      <FlowControl />

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

      <BehaviorModifiers />
    </div>
  )
}

function BindingsManager() {
  const current = useSceneStore((s) => s.scenes.find((x) => x.id === s.currentId))!
  const updateBindings = useSceneStore((s) => s.updateBindings)
  const bindings = current.senses?.bindings ?? []

  const SOURCES: { value: string; label: string }[] = [
    { value: 'hand.index.y', label: 'Main — index y' },
    { value: 'hand.index.x', label: 'Main — index x' },
    { value: 'hand.pinch', label: 'Main — pinch (pincement)' },
    { value: 'hand.openness', label: 'Main — ouverture' },
    { value: 'audio.bass', label: 'Audio — basses' },
    { value: 'audio.mid', label: 'Audio — médiums' },
    { value: 'audio.high', label: 'Audio — aigus' },
    { value: 'audio.level', label: 'Audio — niveau RMS' },
    { value: 'light', label: 'Lumière ambiante' },
    { value: 'midi.mod', label: 'MIDI — Mod wheel (CC1)' },
    { value: 'midi.cc7', label: 'MIDI — Volume (CC7)' },
    { value: 'midi.cc11', label: 'MIDI — Expression (CC11)' },
    { value: 'midi.cc74', label: 'MIDI — Filtre (CC74)' },
    { value: 'midi.notes.any', label: 'MIDI — Vélocité max notes actives' },
    { value: 'midi.note60', label: 'MIDI — Note C4 (60)' },
  ]

  const TARGETS: { value: string; label: string }[] = [
    { value: 'organism.values.speed', label: 'Organisme — vitesse' },
    { value: 'organism.values.count', label: 'Organisme — densité' },
    { value: 'organism.values.size', label: 'Organisme — taille' },
    { value: 'organism.values.trail', label: 'Organisme — traînée' },
    { value: 'organism.values.cohesion', label: 'Boids — cohésion' },
    { value: 'organism.values.separation', label: 'Boids — séparation' },
    { value: 'organism.values.alignment', label: 'Boids — alignement' },
    { value: 'organism.values.pulse', label: 'Cells — pulsation' },
    { value: 'organism.values.arms', label: 'Mandala — bras' },
    { value: 'organism.values.cx', label: 'Fractal — cx' },
    { value: 'organism.values.cy', label: 'Fractal — cy' },
    { value: 'organism.values.a', label: 'MathCurve — a' },
    { value: 'organism.values.b', label: 'MathCurve — b' },
    { value: 'visual.feedback', label: 'Visuel — feedback' },
    { value: 'visual.bloom', label: 'Visuel — bloom' },
    { value: 'flow.angle', label: 'Flux — angle' },
    { value: 'flow.strength', label: 'Flux — force' },
    { value: 'flow.turbulence', label: 'Flux — turbulence' },
  ]

  const add = () => {
    const next = [...bindings, {
      id: `bind-${Date.now().toString(36)}`,
      source: 'midi.cc1', target: 'organism.values.speed',
      range: [0.1, 2.5] as [number, number], invert: false,
    }]
    updateBindings(next)
  }
  const remove = (i: number) => {
    const next = bindings.filter((_, j) => j !== i)
    updateBindings(next)
  }
  const patch = (i: number, p: any) => {
    const next = bindings.map((b, j) => j === i ? { ...b, ...p } : b)
    updateBindings(next)
  }

  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>🔗 Bindings (capteur → paramètre)</h3>
        <button onClick={add} style={{ fontSize: 11, padding: '3px 8px' }} title="Ajouter un binding">+</button>
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-mute)', margin: '4px 0 8px', lineHeight: 1.4 }}>
        Chaque binding lit un capteur (main / audio / MIDI CC / lumière) et écrit le résultat
        normalisé sur un paramètre via une plage min→max. Mis à jour à chaque frame.
      </p>
      {bindings.length === 0 && (
        <p style={{ fontSize: 11, color: 'var(--text-mute)', fontStyle: 'italic', textAlign: 'center', padding: '8px 0' }}>
          Aucun binding. Clique <strong>+</strong> pour mapper un CC MIDI ou un capteur à un paramètre.
        </p>
      )}
      {bindings.map((b, i) => (
        <div key={b.id ?? i} style={{ padding: 6, marginBottom: 6, background: 'var(--bg-elev-2)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--line)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 4 }}>
            <select value={b.source} onChange={(e) => patch(i, { source: e.target.value })} style={{ fontSize: 11 }}>
              {SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <select value={b.target} onChange={(e) => patch(i, { target: e.target.value })} style={{ fontSize: 11 }}>
              {TARGETS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input
              type="number" value={b.range?.[0] ?? 0} step={0.01}
              onChange={(e) => patch(i, { range: [parseFloat(e.target.value), b.range?.[1] ?? 1] })}
              style={{ width: 60, fontSize: 11 }}
              title="Min"
            />
            <span style={{ fontSize: 10, color: 'var(--text-mute)' }}>→</span>
            <input
              type="number" value={b.range?.[1] ?? 1} step={0.01}
              onChange={(e) => patch(i, { range: [b.range?.[0] ?? 0, parseFloat(e.target.value)] })}
              style={{ width: 60, fontSize: 11 }}
              title="Max"
            />
            <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, marginLeft: 'auto' }}>
              <input type="checkbox" checked={!!b.invert} onChange={(e) => patch(i, { invert: e.target.checked })} />
              inverser
            </label>
            <button className="ghost icon danger" onClick={() => remove(i)} title="Supprimer"><Trash2 size={11} /></button>
          </div>
        </div>
      ))}
    </div>
  )
}

const WEBCAM_FILTERS: { v: string; label: string; desc: string }[] = [
  { v: 'none',         label: '— Aucun',                desc: 'La caméra passe telle quelle.' },
  { v: 'edges',        label: '✏️ Edges (Sobel)',       desc: 'Contours façon croquis. Bass = épaisseur des traits.' },
  { v: 'ascii',        label: '⌨️ ASCII',               desc: 'Caractères selon la luminance. Bass = taille, aigus = jitter.' },
  { v: 'halftone',     label: '⚫ Halftone',             desc: 'Points imprimés rotatifs. Médiums = densité.' },
  { v: 'posterize',    label: '🎨 Posterize',           desc: 'Quantification couleurs woodblock. Aigus = nb niveaux.' },
  { v: 'kaleidoscope', label: '🌀 Kaléidoscope',        desc: 'Symétrie N-pli. Les poignets (pose) dirigent le centre.' },
  { v: 'echo',         label: '👻 Echo (motion trails)', desc: 'Rémanence temporelle. Bass = persistance.' },
  { v: 'liquify',      label: '💧 Liquify',              desc: 'Warp Perlin audio-réactif. Bass = amplitude.' },
  { v: 'chromatic',    label: '📺 Aberration RGB',       desc: 'Décalage canaux. Bass = ampleur.' },
  { v: 'infrared',     label: '🌡️ Thermographie',        desc: 'Fausse couleur infrarouge depuis la luminance.' },
]

function WebcamFilterPanel() {
  const current = useSceneStore((s) => s.scenes.find((x) => x.id === s.currentId))!
  const setWebcamFilter = useSceneStore((s) => s.setWebcamFilter)
  const f = current.webcamFilter ?? { kind: 'none', intensity: 1 }
  const meta = WEBCAM_FILTERS.find((m) => m.v === f.kind) ?? WEBCAM_FILTERS[0]
  // Per-filter defaults so switching kinds doesn't carry over irrelevant params.
  const setKind = (k: string) => {
    const defaults: Record<string, any> = {
      none:         {},
      edges:        { param0: 0.15, color: '#00ffa3', audioReact: 0.5 },
      ascii:        { param0: 8,    color: '#7cffd4', audioReact: 0.6 },
      halftone:     { param0: 0.012, color: '#ff5aa0', audioReact: 0.4 },
      posterize:    { param0: 5,    audioReact: 0.3 },
      kaleidoscope: { param0: 6,    poseReact: 1.0 },
      echo:         { param0: 0.94, audioReact: 0.5 },
      liquify:      { param0: 0.04, audioReact: 1.0 },
      chromatic:    { param0: 0.015, audioReact: 1.0 },
      infrared:     { param0: 1.0,  audioReact: 0.3 },
    }
    setWebcamFilter({ kind: k as any, intensity: 1, ...defaults[k] })
  }
  return (
    <>
      <h3 style={{ marginTop: 18 }}>📹 Filtre caméra (live)</h3>
      <p style={{ fontSize: 11, color: 'var(--text-mute)', marginBottom: 8, lineHeight: 1.4 }}>
        Effets shader appliqués au flux webcam en miroir AR. Audio & pose modulent
        les paramètres en temps réel — combine avec l'organisme pour des compositions
        hybrides.
      </p>
      <div className="palette-row">
        <label>Effet</label>
        <select value={f.kind} onChange={(e) => setKind(e.target.value)}>
          {WEBCAM_FILTERS.map((m) => <option key={m.v} value={m.v}>{m.label}</option>)}
        </select>
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-mute)', margin: '4px 0 10px', lineHeight: 1.4, fontStyle: 'italic' }}>
        {meta.desc}
      </p>
      {f.kind !== 'none' && (
        <>
          <Slider label="Intensité (mix)" value={f.intensity} min={0} max={1} step={0.02}
            onChange={(v) => setWebcamFilter({ intensity: v })}
            format={(v) => `${Math.round(v * 100)}%`} />
          {f.kind === 'edges' && (
            <Slider label="Seuil contour" value={f.param0 ?? 0.15} min={0.02} max={0.5} step={0.01}
              onChange={(v) => setWebcamFilter({ param0: v })} format={(v) => v.toFixed(2)} />
          )}
          {f.kind === 'ascii' && (
            <Slider label="Taille caractère (px)" value={f.param0 ?? 8} min={4} max={32} step={1}
              onChange={(v) => setWebcamFilter({ param0: Math.round(v) })} format={(v) => `${Math.round(v)}px`} />
          )}
          {f.kind === 'halftone' && (
            <Slider label="Espacement points" value={f.param0 ?? 0.012} min={0.004} max={0.05} step={0.001}
              onChange={(v) => setWebcamFilter({ param0: v })} format={(v) => v.toFixed(3)} />
          )}
          {f.kind === 'posterize' && (
            <Slider label="Niveaux par canal" value={f.param0 ?? 5} min={2} max={16} step={1}
              onChange={(v) => setWebcamFilter({ param0: Math.round(v) })} format={(v) => `${Math.round(v)}`} />
          )}
          {f.kind === 'kaleidoscope' && (
            <Slider label="Segments" value={f.param0 ?? 6} min={2} max={16} step={1}
              onChange={(v) => setWebcamFilter({ param0: Math.round(v) })} format={(v) => `${Math.round(v)}`} />
          )}
          {f.kind === 'echo' && (
            <Slider label="Persistance" value={f.param0 ?? 0.94} min={0.5} max={0.99} step={0.005}
              onChange={(v) => setWebcamFilter({ param0: v })} format={(v) => v.toFixed(3)} />
          )}
          {f.kind === 'liquify' && (
            <Slider label="Amplitude warp" value={f.param0 ?? 0.04} min={0.005} max={0.2} step={0.005}
              onChange={(v) => setWebcamFilter({ param0: v })} format={(v) => v.toFixed(3)} />
          )}
          {f.kind === 'chromatic' && (
            <Slider label="Aberration" value={f.param0 ?? 0.015} min={0.002} max={0.08} step={0.001}
              onChange={(v) => setWebcamFilter({ param0: v })} format={(v) => v.toFixed(3)} />
          )}
          {f.kind === 'infrared' && (
            <Slider label="Gain thermique" value={f.param0 ?? 1.0} min={0.3} max={2.5} step={0.05}
              onChange={(v) => setWebcamFilter({ param0: v })} format={(v) => v.toFixed(2)} />
          )}
          {(f.kind === 'edges' || f.kind === 'ascii' || f.kind === 'halftone') && (
            <div className="palette-row">
              <label>Couleur</label>
              <input type="color" value={f.color ?? '#00ffa3'} onChange={(e) => setWebcamFilter({ color: e.target.value })} />
            </div>
          )}
          <Slider label="Réactivité audio" value={f.audioReact ?? 0} min={0} max={1} step={0.05}
            onChange={(v) => setWebcamFilter({ audioReact: v })} format={(v) => `${Math.round(v * 100)}%`} />
          {f.kind === 'kaleidoscope' && (
            <Slider label="Réactivité pose (poignets)" value={f.poseReact ?? 0} min={0} max={1} step={0.05}
              onChange={(v) => setWebcamFilter({ poseReact: v })} format={(v) => `${Math.round(v * 100)}%`} />
          )}
          <h4 style={{ marginTop: 12, marginBottom: 4, fontSize: 11, color: 'var(--text-mute)', textTransform: 'uppercase', letterSpacing: 1 }}>
            🎯 Cibler le filtre sur
          </h4>
          <div className="palette-row">
            <label>Filtrer</label>
            <select
              value={f.applyTo ?? 'all'}
              onChange={(e) => setWebcamFilter({ applyTo: e.target.value as any })}
              title="Restreint le filtre à la silhouette détectée par MediaPipe."
            >
              <option value="all">🌍 Toute l'image webcam</option>
              <option value="body">👤 Mon corps seulement</option>
              <option value="background">🖼️ L'arrière-plan seulement</option>
            </select>
          </div>
          {(f.applyTo === 'body' || f.applyTo === 'background') && (
            <>
              <Slider label="Bord filtre (douceur)" value={f.maskFeather ?? 0.15} min={0} max={0.5} step={0.01}
                onChange={(v) => setWebcamFilter({ maskFeather: v })} format={(v) => v.toFixed(2)} />
              <p style={{ fontSize: 11, color: 'var(--accent)', marginTop: 4, lineHeight: 1.4 }}>
                ✓ Silhouette MediaPipe auto-démarrée. Le filtre n'affecte que la zone choisie ;
                le reste reste brut.
              </p>
            </>
          )}
          <CameraStatusHint kind="filter" />
          <p style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 6, lineHeight: 1.4 }}>
            Le filtre s'active dans le miroir AR (bouton AR en haut).
          </p>
        </>
      )}
    </>
  )
}

/** Inline reminder that surfaces if the camera isn't running. The TopBar
 *  exposes __animaCameraOn as a window global and emits an 'anima:camera-state'
 *  custom event — we poll the global and subscribe to the event so the hint
 *  updates the moment the user clicks Caméra above. */
function CameraStatusHint({ kind }: { kind: 'filter' | 'organism' }) {
  const [on, setOn] = useState<boolean>(!!(window as any).__animaCameraOn)
  useEffect(() => {
    const tick = () => setOn(!!(window as any).__animaCameraOn)
    const onEvt = () => tick()
    window.addEventListener('anima:camera-state', onEvt)
    const id = window.setInterval(tick, 600)
    return () => { window.removeEventListener('anima:camera-state', onEvt); clearInterval(id) }
  }, [])
  if (on) return null
  const need = kind === 'filter'
    ? "Sans caméra il n'y a rien à filtrer."
    : "Sans caméra le masque ne sait pas où est ton corps — les organismes restent visibles partout."
  return (
    <div style={{
      marginTop: 6, padding: 8, background: 'rgba(255,107,166,0.08)',
      border: '1px solid rgba(255,107,166,0.35)', borderRadius: 'var(--radius-sm)',
      fontSize: 11, color: 'var(--text)', lineHeight: 1.4,
    }}>
      ⚠️ <strong>Caméra éteinte.</strong> {need}{' '}
      <button
        onClick={() => window.dispatchEvent(new Event('anima:request-camera'))}
        style={{ fontSize: 11, padding: '2px 8px', marginLeft: 4 }}
      >
        Activer la caméra
      </button>
    </div>
  )
}

function OrganismMaskPanel() {
  const current = useSceneStore((s) => s.scenes.find((x) => x.id === s.currentId))!
  const setOrganismMask = useSceneStore((s) => s.setOrganismMask)
  const m = current.organismMask ?? { mode: 'all' as const, feather: 0.15 }
  return (
    <>
      <h3 style={{ marginTop: 18 }}>🎭 Masque organismes (silhouette)</h3>
      <p style={{ fontSize: 11, color: 'var(--text-mute)', marginBottom: 8, lineHeight: 1.4 }}>
        Restreint la couche <strong>organismes</strong> (particules, cellules,
        fractale, RD…) à l'intérieur ou à l'extérieur de ta silhouette.
        Indépendant du filtre caméra : tu peux filtrer le corps ET ne montrer
        les organismes que dedans, ou l'inverse.
      </p>
      <div className="palette-row">
        <label>Confiner</label>
        <select
          value={m.mode}
          onChange={(e) => setOrganismMask({ mode: e.target.value as any })}
        >
          <option value="all">🌍 Aucun masque (partout)</option>
          <option value="body">👤 Dans mon corps</option>
          <option value="background">🖼️ Hors de mon corps</option>
        </select>
      </div>
      {m.mode !== 'all' && (
        <>
          <Slider
            label="Bord masque (douceur)"
            value={m.feather ?? 0.15}
            min={0} max={0.5} step={0.01}
            onChange={(v) => setOrganismMask({ feather: v })}
            format={(v) => v.toFixed(2)}
          />
          <p style={{ fontSize: 11, color: 'var(--accent)', marginTop: 4, lineHeight: 1.4 }}>
            ✓ Silhouette MediaPipe auto-démarrée. En mode AR, la zone hors
            silhouette laisse passer la caméra brute (alpha = 0).
          </p>
        </>
      )}
      <CameraStatusHint kind="organism" />
    </>
  )
}

function GravityWellEditor({ wells, onChange }: {
  wells: { x: number; y: number; strength: number; radius: number }[]
  onChange: (wells: { x: number; y: number; strength: number; radius: number }[]) => void
}) {
  const patch = (i: number, p: Partial<{ x: number; y: number; strength: number; radius: number }>) => {
    const next = wells.map((w, idx) => idx === i ? { ...w, ...p } : w)
    onChange(next)
  }
  const add = () => onChange([...wells, { x: 0.5, y: 0.5, strength: 1, radius: 0.4 }])
  const remove = (i: number) => onChange(wells.filter((_, idx) => idx !== i))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <p style={{ fontSize: 10, color: 'var(--text-mute)', margin: 0 }}>
        Chaque puits attire (force &gt; 0) ou repousse (force &lt; 0) les agents dans son rayon.
        Pour faire chuter une pluie qui contourne un parapluie, combine ce puits (haut, force négative = répulsion)
        avec un obstacle circulaire (en bas, interaction "avoid") sur des Particles avec gravité positive.
      </p>
      {wells.map((w, i) => (
        <div key={i} style={{ padding: 6, background: 'var(--bg)', borderRadius: 4, border: '1px solid var(--line)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <span style={{ flex: 1, fontSize: 11, fontWeight: 500 }}>Puits #{i + 1}</span>
            <button className="ghost icon danger" onClick={() => remove(i)} title="Supprimer ce puits"><Trash2 size={10} /></button>
          </div>
          <Slider label="X" value={w.x} min={0} max={1} step={0.01} onChange={(v) => patch(i, { x: v })} format={(v) => v.toFixed(2)} />
          <Slider label="Y" value={w.y} min={0} max={1} step={0.01} onChange={(v) => patch(i, { y: v })} format={(v) => v.toFixed(2)} />
          <Slider label="Force" value={w.strength} min={-4} max={4} step={0.05} onChange={(v) => patch(i, { strength: v })} format={(v) => v.toFixed(2)} />
          <Slider label="Rayon" value={w.radius} min={0.05} max={2} step={0.05} onChange={(v) => patch(i, { radius: v })} format={(v) => v.toFixed(2)} />
        </div>
      ))}
      <button onClick={add} style={{ fontSize: 11, padding: '4px 8px', justifyContent: 'center' }}>+ Ajouter un puits</button>
    </div>
  )
}

// Only these organisms keep persistent per-agent position+velocity arrays that
// the position/velocity modifiers can actually move. The others are procedural
// (regenerated each frame) or GPU full-quad simulations with no agents — the
// position modifiers are silent no-ops there. colorCycle is visual-only and
// works on every organism.
const AGENT_ORGANISMS = new Set(['boids', 'particles', 'cells', 'spores'])
function modifierApplies(modKind: string, organismKind: string): boolean {
  if (modKind === 'colorCycle') return true
  return AGENT_ORGANISMS.has(organismKind)
}

function BehaviorModifiers() {
  const current = useSceneStore((s) => s.scenes.find((x) => x.id === s.currentId))!
  const add = useSceneStore((s) => s.addModifier)
  const remove = useSceneStore((s) => s.removeModifier)
  const update = useSceneStore((s) => s.updateModifier)
  const mods = current.modifiers ?? []
  const orgKind = current.organism.kind
  const LABELS: Record<string, { name: string; emoji: string; help: string }> = {
    vortex: { name: 'Vortex', emoji: '🌀', help: 'Tourbillon autour d\'un point (ou la main).' },
    gravityWell: { name: 'Puits gravitationnel', emoji: '🕳️', help: 'Attire/repousse vers des points.' },
    colorCycle: { name: 'Cycle de couleurs', emoji: '🌈', help: 'Décale la teinte de la palette.' },
    pulseGate: { name: 'Battement', emoji: '💓', help: 'Pulse rythmique sur la vitesse.' },
    magneticBands: { name: 'Bandes magnétiques', emoji: '〰️', help: 'Aligne les agents en bandes horizontales.' },
    zoneWalls: { name: 'Parois de zones', emoji: '🧱', help: 'Les zones du mapping deviennent des murs : les agents rebondissent dedans.' },
  }
  return (
    <div style={{ marginTop: 20 }}>
      <h3>🎚️ Comportements (modificateurs)</h3>
      <p style={{ fontSize: 11, color: 'var(--text-mute)', marginBottom: 8 }}>
        Effets orthogonaux superposables à l'organisme principal — combine-les librement.
      </p>
      {!AGENT_ORGANISMS.has(orgKind) && (
        <p style={{ fontSize: 11, color: 'var(--text-mute)', marginBottom: 8, lineHeight: 1.4, fontStyle: 'italic' }}>
          ℹ️ <strong>{orgKind}</strong> n'a pas d'agents à vitesse : seul 🌈 <em>Cycle de couleurs</em>
          a un effet. Les modificateurs de mouvement (Vortex, Puits, Battement, Bandes) sont sans effet ici.
        </p>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 8 }}>
        {(Object.keys(LABELS) as (keyof typeof LABELS)[]).map((k) => {
          const applies = modifierApplies(k, orgKind)
          return (
            <button
              key={k}
              onClick={() => add(k as any)}
              disabled={!applies}
              style={{ fontSize: 11, justifyContent: 'center', padding: '4px 6px', opacity: applies ? 1 : 0.4, cursor: applies ? 'pointer' : 'not-allowed' }}
              title={applies ? LABELS[k].help : `Sans effet sur ${orgKind} (pas d'agents à vitesse)`}
            >
              <span>{LABELS[k].emoji}</span> {LABELS[k].name}
            </button>
          )
        })}
      </div>
      {mods.length === 0 && (
        <p style={{ fontSize: 11, color: 'var(--text-mute)', fontStyle: 'italic', textAlign: 'center', padding: '8px 0' }}>
          Aucun modificateur — ajoute-en un ci-dessus.
        </p>
      )}
      {mods.map((m) => {
        const meta = LABELS[m.kind] ?? { name: m.kind, emoji: '?' }
        const noEffect = !modifierApplies(m.kind, orgKind)
        return (
          <div key={m.id} style={{ padding: 8, marginBottom: 6, background: 'var(--bg-elev-2)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--line)', opacity: noEffect ? 0.6 : 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <input type="checkbox" checked={m.enabled} onChange={(e) => update(m.id, { enabled: e.target.checked })} />
              <span style={{ flex: 1, fontSize: 12, fontWeight: 500 }}>{meta.emoji} {meta.name}</span>
              {noEffect && <span title={`Sans effet sur ${orgKind}`} style={{ fontSize: 10, color: 'var(--warn, #ffb347)' }}>⚠ inactif</span>}
              <button className="ghost icon danger" onClick={() => remove(m.id)} title="Supprimer"><Trash2 size={11} /></button>
            </div>
            {m.kind === 'vortex' && (
              <>
                <Slider label="Vitesse rotation (ω)" value={m.omega} min={-6} max={6} step={0.1} onChange={(v) => update(m.id, { omega: v })} format={(v) => v.toFixed(1)} />
                <Slider label="Rayon" value={m.radius} min={0.05} max={1.5} step={0.05} onChange={(v) => update(m.id, { radius: v })} format={(v) => v.toFixed(2)} />
                <Slider label="Aspiration" value={m.pull} min={-1} max={1} step={0.05} onChange={(v) => update(m.id, { pull: v })} format={(v) => v.toFixed(2)} />
                <label style={{ display: 'flex', gap: 6, fontSize: 11, marginTop: 4, cursor: 'pointer' }}>
                  <input type="checkbox" checked={m.center === 'hand'} onChange={(e) => update(m.id, { center: e.target.checked ? 'hand' : { x: 0.5, y: 0.5 } })} />
                  Centrer sur la main
                </label>
              </>
            )}
            {m.kind === 'colorCycle' && (
              <>
                <Slider label="Vitesse (Hz)" value={m.speedHz} min={0.01} max={2} step={0.01} onChange={(v) => update(m.id, { speedHz: v })} format={(v) => v.toFixed(2)} />
                <Slider label="Amplitude" value={m.amount} min={0} max={1} step={0.05} onChange={(v) => update(m.id, { amount: v })} format={(v) => v.toFixed(2)} />
              </>
            )}
            {m.kind === 'pulseGate' && (
              <>
                <Slider label="BPM (Hz)" value={m.bpm} min={0.1} max={5} step={0.05} onChange={(v) => update(m.id, { bpm: v })} format={(v) => v.toFixed(2)} />
                <Slider label="Intensité" value={m.intensity} min={1} max={4} step={0.1} onChange={(v) => update(m.id, { intensity: v })} format={(v) => `×${v.toFixed(1)}`} />
                <Slider label="Largeur" value={m.width} min={0.03} max={0.5} step={0.01} onChange={(v) => update(m.id, { width: v })} format={(v) => v.toFixed(2)} />
              </>
            )}
            {m.kind === 'magneticBands' && (
              <>
                <Slider label="Nombre de bandes" value={m.bands} min={2} max={12} step={1} onChange={(v) => update(m.id, { bands: Math.round(v) })} format={(v) => String(Math.round(v))} />
                <Slider label="Force" value={m.strength} min={-2} max={2} step={0.05} onChange={(v) => update(m.id, { strength: v })} format={(v) => v.toFixed(2)} />
              </>
            )}
            {m.kind === 'zoneWalls' && (
              <>
                <p style={{ fontSize: 10, color: 'var(--text-mute)', marginBottom: 6 }}>
                  Les zones polygones du <strong>mapping</strong> deviennent des murs. Crée des zones (onglet Map) pour activer le confinement.
                </p>
                <Slider label="Marge" value={m.margin ?? 0.08} min={0.005} max={0.2} step={0.005} onChange={(v) => update(m.id, { margin: v })} format={(v) => v.toFixed(3)} />
                <Slider label="Rigidité" value={m.stiffness ?? 4} min={0.2} max={20} step={0.2} onChange={(v) => update(m.id, { stiffness: v })} format={(v) => v.toFixed(1)} />
                <Slider label="Amortissement" value={m.damping ?? 0.35} min={0} max={1} step={0.02} onChange={(v) => update(m.id, { damping: v })} format={(v) => v.toFixed(2)} />
              </>
            )}
            {m.kind === 'gravityWell' && (
              <GravityWellEditor
                wells={m.wells}
                onChange={(wells) => update(m.id, { wells })}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

function FlowControl() {
  const current = useSceneStore((s) => s.scenes.find((x) => x.id === s.currentId))!
  const update = useSceneStore((s) => s.updateFlow)
  const flow = current.flow ?? { enabled: false, angle: 0, strength: 0.6, turbulence: 0.2 }
  const degrees = Math.round((flow.angle * 180 / Math.PI + 360) % 360)
  // Dial size in px
  const r = 36
  const cx = r, cy = r
  const handleX = cx + Math.cos(flow.angle) * (r - 6)
  const handleY = cy + Math.sin(flow.angle) * (r - 6)

  const onDial = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
    const px = e.clientX - rect.left - cx
    const py = e.clientY - rect.top - cy
    const a = Math.atan2(py, px)
    update({ angle: a, enabled: true })
  }

  return (
    <>
      <h3 style={{ marginTop: 18, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span><Wind size={11} style={{ verticalAlign: 'middle', color: 'var(--accent)' }} /> Flux directionnel</span>
        {flow.enabled && <span style={{ fontSize: 10, color: 'var(--text-mute)', fontFamily: 'var(--mono)' }}>{degrees}°</span>}
      </h3>
      <label style={{ display: 'flex', gap: 8, cursor: 'pointer', userSelect: 'none', marginBottom: 10 }}>
        <input type="checkbox" checked={flow.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
        <span>Activer le vent / courant</span>
      </label>
      {flow.enabled && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
            <svg
              width={r * 2} height={r * 2}
              onPointerDown={onDial} onPointerMove={(e) => e.buttons === 1 && onDial(e)}
              style={{ cursor: 'crosshair', flexShrink: 0 }}
            >
              <circle cx={cx} cy={cy} r={r - 1} fill="var(--bg)" stroke="var(--line)" strokeWidth={1} />
              <line x1={cx} y1={cy} x2={handleX} y2={handleY} stroke="var(--accent)" strokeWidth={2} strokeLinecap="round" />
              <polygon
                points={`${handleX - 4},${handleY - 4} ${handleX + 6},${handleY} ${handleX - 4},${handleY + 4}`}
                fill="var(--accent)"
                transform={`rotate(${flow.angle * 180 / Math.PI} ${handleX} ${handleY})`}
              />
              <circle cx={cx} cy={cy} r={2.5} fill="var(--text-mute)" />
            </svg>
            <div style={{ flex: 1, fontSize: 11, color: 'var(--text-mute)', lineHeight: 1.4 }}>
              <Navigation size={10} style={{ verticalAlign: 'middle' }} /> Glisse sur la jauge pour orienter le flux. Force et turbulence ajustables ci-dessous.
            </div>
          </div>
          <Slider label="Force" value={flow.strength} min={0} max={3} step={0.05} onChange={(v) => update({ strength: v })} />
          <Slider label="Turbulence" value={flow.turbulence} min={0} max={2} step={0.05} onChange={(v) => update({ turbulence: v })} />
        </>
      )}
    </>
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
        credentials: 'include',   // send the admin session cookie
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) {
        // Map the common failures to actionable messages instead of a raw code.
        if (r.status === 401) throw new Error('Connexion requise : ouvre /admin et connecte-toi, puis configure ta clé fal.ai. (La génération IA est protégée pour éviter l\'usage de ta clé payante par d\'autres.)')
        if (r.status === 403) throw new Error('Requête bloquée (origine). Recharge la page depuis l\'URL officielle.')
        if (r.status === 429) throw new Error(d.error || 'Trop de requêtes — attends une minute.')
        if (r.status === 500 && /clé fal/i.test(d.error || '')) throw new Error('Clé fal.ai non configurée : va sur /admin → Réglages pour l\'ajouter.')
        throw new Error(d.error || `Erreur ${r.status}`)
      }
      setTexture({ url: d.url, prompt: d.prompt, model: d.model, seed: d.seed, generatedAt: Date.now() })
      setPrompt('')
    } catch (e: any) { setErr(e.message) }
    finally { setBusy(false) }
  }

  // Only these organisms actually map a texture onto their material (others
  // are shader-based or line strips and ignore setTexture).
  const TEXTURABLE = new Set(['boids', 'particles', 'cells'])
  const organismSupportsTexture = TEXTURABLE.has(current.organism.kind)

  const tex = current.visual.texture
  return (
    <div>
      {!organismSupportsTexture && (
        <div style={{ fontSize: 11, color: 'var(--warn, #ffb347)', marginBottom: 8, lineHeight: 1.4, padding: 8, background: 'rgba(255,179,71,0.08)', border: '1px solid rgba(255,179,71,0.3)', borderRadius: 'var(--radius-sm)' }}>
          ⚠️ L'organisme <strong>{current.organism.kind}</strong> n'affiche pas de texture.
          Les textures s'appliquent à : <strong>Boids, Particules, Cellules</strong>.
        </div>
      )}
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
  const [presetMenu, setPresetMenu] = useState(false)

  const applyMusicalPreset = (presetId: string) => {
    const preset = SOUND_PRESETS.find((p) => p.id === presetId)
    if (!preset) return
    soundEngine.ensure()
    const newObstacles = applyPreset(obs, preset)
    newObstacles.forEach((o) => update(o.id, { sound: o.sound }))
    setPresetMenu(false)
  }
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
        <button onClick={() => add('pose')} style={{ fontSize: 12, justifyContent: 'center', gridColumn: 'span 2' }}><Bone size={12} /> Articulations (pose corps)</button>
        <button onClick={() => add('tracker')} style={{ fontSize: 12, justifyContent: 'center', gridColumn: 'span 2' }}><Pipette size={12} /> Tracker couleur (objet AR)</button>
      </div>

      {obs.length > 0 && (
        <div style={{ position: 'relative', marginBottom: 12 }}>
          <button onClick={() => setPresetMenu((x) => !x)} className="primary" style={{ width: '100%', justifyContent: 'center', fontSize: 12 }}>
            <Wand2 size={12} /> Appliquer un préset musical
          </button>
          {presetMenu && (
            <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4, background: 'var(--bg-elev)', border: '1px solid var(--line)', borderRadius: 'var(--radius)', padding: 4, zIndex: 50, maxHeight: 280, overflowY: 'auto' }}>
              {SOUND_PRESETS.map((p) => (
                <button key={p.id} onClick={() => applyMusicalPreset(p.id)}
                  style={{ width: '100%', justifyContent: 'flex-start', textAlign: 'left', flexDirection: 'column', alignItems: 'flex-start', gap: 1, padding: '6px 10px', fontSize: 12, marginBottom: 2, border: '1px solid transparent', background: 'transparent' }}>
                  <span><span style={{ marginRight: 6 }}>{p.emoji}</span><strong>{p.name}</strong></span>
                  <span style={{ fontSize: 10, color: 'var(--text-mute)' }}>{p.description}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

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

          {sel.kind === 'tracker' && sel.tracker && (
            <>
              <h3 style={{ marginTop: 10 }}>Cible couleur</h3>
              <p style={{ fontSize: 11, color: 'var(--text-mute)', marginBottom: 8 }}>
                Active AR + caméra, puis clique <strong>Pipette</strong> et tape sur l'objet réel dans l'image.
                L'obstacle suivra automatiquement cet objet.
              </p>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
                <div style={{
                  width: 40, height: 40, borderRadius: 8,
                  background: hsvToCss(sel.tracker.h, sel.tracker.s, sel.tracker.v),
                  border: '2px solid var(--line)',
                  flexShrink: 0,
                }} title="Couleur cible" />
                <button
                  className="primary"
                  onClick={() => window.dispatchEvent(new CustomEvent('anima:pick-color', { detail: sel.id }))}
                  style={{ fontSize: 12, flex: 1, justifyContent: 'center' }}
                >
                  <Pipette size={12} /> Pipette → cliquer sur l'image AR
                </button>
              </div>
              <Slider label="Tolérance match" value={sel.tracker.tolerance} min={0.05} max={0.5} step={0.01}
                onChange={(t) => update(sel.id, { tracker: { ...sel.tracker!, tolerance: t } })}
                format={(t) => `${Math.round(t * 100)}%`}
              />
              <Slider label="Rayon obstacle" value={sel.tracker.radius} min={0.02} max={0.3} step={0.01}
                onChange={(r) => update(sel.id, { tracker: { ...sel.tracker!, radius: r } })}
                format={(r) => `${Math.round(r * 100)}%`}
              />
              <p style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 6 }}>
                Tolérance plus large = match plus généreux (mais risque de bruit). Active une seule pipette à la fois.
              </p>
            </>
          )}
          {sel.kind === 'pose' && sel.pose && (
            <>
              <h3 style={{ marginTop: 10 }}>Articulations actives</h3>
              <p style={{ fontSize: 11, color: 'var(--text-mute)', marginBottom: 8 }}>
                Coche les joints qui seront des obstacles. Active la caméra + mode AR pour les voir.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 10 }}>
                {Object.entries(JOINT_LABELS).map(([idxStr, label]) => {
                  const idx = parseInt(idxStr)
                  const on = sel.pose!.joints.includes(idx)
                  return (
                    <label key={idx} style={{ display: 'flex', gap: 6, fontSize: 11, cursor: 'pointer', userSelect: 'none', padding: '3px 5px', borderRadius: 4, background: on ? 'rgba(0,255,163,0.08)' : 'transparent' }}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(e) => {
                          const next = e.target.checked
                            ? [...sel.pose!.joints, idx]
                            : sel.pose!.joints.filter((j) => j !== idx)
                          update(sel.id, { pose: { ...sel.pose!, joints: next } })
                        }}
                      />
                      <span>{label}</span>
                    </label>
                  )
                })}
              </div>
              <Slider label="Rayon par joint" value={sel.pose.radius} min={0.02} max={0.3} step={0.01}
                onChange={(r) => update(sel.id, { pose: { ...sel.pose!, radius: r } })}
                format={(r) => `${Math.round(r * 100)}%`}
              />
              <p style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 4 }}>
                Chaque joint devient une petite zone {sel.interaction === 'attract' ? 'attractive' : sel.interaction === 'avoid' ? 'd\'évitement' : sel.interaction}.
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
                  onChange={(e) => update(sel.id, { silhouette: { ...sel.silhouette!, invert: e.target.checked } })}
                />
                <span>Inverser (l'organisme reste DANS la silhouette)</span>
              </label>
              <label style={{ display: 'flex', gap: 8, cursor: 'pointer', userSelect: 'none', marginBottom: 8 }}>
                <input
                  type="checkbox"
                  checked={sel.silhouette.hideOverlay ?? false}
                  onChange={(e) => update(sel.id, { silhouette: { ...sel.silhouette!, hideOverlay: e.target.checked } })}
                />
                <span>Masquer l'aperçu visuel (l'obstacle reste actif)</span>
              </label>
              {!sel.silhouette.hideOverlay && (
                <Slider
                  label="Opacité de l'aperçu"
                  value={sel.silhouette.overlayOpacity ?? 0.5}
                  min={0} max={1} step={0.05}
                  onChange={(v) => update(sel.id, { silhouette: { ...sel.silhouette!, overlayOpacity: v } })}
                  format={(v) => `${Math.round(v * 100)}%`}
                />
              )}
              <p style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 6, lineHeight: 1.4 }}>
                Segmentation MediaPipe SelfieSegmenter à 10 fps. Active la caméra pour démarrer.
                Combinez avec <strong>kill</strong> : les organismes "disparaissent" derrière toi.
                Réduire l'opacité ou masquer l'aperçu n'affecte pas la physique — uniquement le rendu cyan.
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
            <label>Mode</label>
            <select
              value={s.density === false ? 'drone' : 'density'}
              onChange={(e) => onChange({ ...s, density: e.target.value === 'density' })}
              title="Drone = note continue. Densité = volume modulé par le nombre d'agents dans l'obstacle."
            >
              <option value="drone">🎵 Drone (continu)</option>
              <option value="density">🔊 Densité (modulé par les agents)</option>
            </select>
          </div>
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
          <Slider label="Réactivité au mic" value={s.audioReactivity ?? 0} min={0} max={1} step={0.05} onChange={(v) => onChange({ ...s, audioReactivity: v })} format={(v) => `${Math.round(v * 100)}%`} />
          <div style={{ background: 'var(--bg-elev-2)', height: 4, borderRadius: 2, overflow: 'hidden', marginTop: 8 }}>
            <div style={{ width: `${density * 100}%`, height: '100%', background: 'linear-gradient(90deg, var(--accent), var(--accent-3))', transition: 'width 80ms linear' }} />
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 8, lineHeight: 1.4 }}>
            {s.density === false
              ? "Mode drone : note continue au volume configuré, indépendamment des agents."
              : "Mode densité : la note monte avec le nombre d'agents qui traversent l'obstacle (avec un seuil minimum audible)."}
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
  const addShapes = useSceneStore((s) => s.addMappingShapes)
  const removeShape = useSceneStore((s) => s.removeMappingShape)
  const updateShape = useSceneStore((s) => s.updateMappingShape)
  const selectShape = useSceneStore((s) => s.selectMappingShape)
  const setTestPattern = useSceneStore((s) => s.setTestPattern)
  const m = current.mapping
  const shapes = m.shapes ?? []
  const selectedIdx = m.selectedShape ?? 0
  const selectedShape = shapes[selectedIdx]
  const svgInputRef = useRef<HTMLInputElement>(null)

  const onImportSVG = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    try {
      const imported = await importSVG(f)
      if (imported.length === 0) { alert('Aucune forme exploitable dans ce SVG'); return }
      const offset = (shapes.length)
      const newShapes = imported.map((s, i) => {
        const base = defaultShape(offset + i, 'polygon')
        return { ...base, name: s.name, points: s.points }
      })
      addShapes(newShapes)
    } catch (err: any) {
      alert('Import SVG échec : ' + (err?.message ?? err))
    }
    e.target.value = ''
  }

  return (
    <div className="section">
      <h3>Projection mapping</h3>
      <label style={{ display: 'flex', gap: 8, cursor: 'pointer', userSelect: 'none', marginBottom: 8 }}>
        <input
          type="checkbox"
          checked={m.enabled}
          onChange={(e) => update({ enabled: e.target.checked })}
        />
        <span>Activer le mapping</span>
      </label>
      {m.enabled && (
        <div style={{ background: 'var(--bg)', padding: 8, borderRadius: 'var(--radius-sm)', border: '1px solid var(--line)', marginBottom: 12 }}>
          <div style={{ fontSize: 10, color: 'var(--text-mute)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>🪞 AR + Zones</div>
          <label style={{ display: 'flex', gap: 8, cursor: 'pointer', userSelect: 'none', marginBottom: 6, fontSize: 12 }}>
            <input
              type="checkbox"
              checked={m.arClipToZones ?? false}
              onChange={(e) => update({ arClipToZones: e.target.checked })}
            />
            <span><strong>AR seulement dans les zones</strong></span>
          </label>
          <p style={{ fontSize: 10, color: 'var(--text-mute)', marginBottom: 8, marginLeft: 22, lineHeight: 1.4 }}>
            Cache l'image webcam plein écran — elle n'apparaît plus que dans les zones avec contenu <em>Webcam</em>.
            Le reste = fond noir / transparent / organismes selon les autres zones.
          </p>
          <label style={{ display: 'flex', gap: 8, cursor: 'pointer', userSelect: 'none', marginBottom: 6, fontSize: 12 }}>
            <input
              type="checkbox"
              checked={m.arMaskBody ?? false}
              onChange={(e) => update({ arMaskBody: e.target.checked })}
            />
            <span><strong>Masquer l'environnement (corps uniquement)</strong></span>
          </label>
          <p style={{ fontSize: 10, color: 'var(--text-mute)', marginLeft: 22, lineHeight: 1.4 }}>
            Toute zone <em>Webcam</em> ne montre que ton corps (via SelfieSegmenter), pas la pièce derrière.
            Les obstacles <em>silhouette / pose / tracker</em> restent actifs pour l'interaction.
          </p>
        </div>
      )}

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
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
        <button onClick={() => addShape('quad')} style={{ justifyContent: 'center', fontSize: 12 }}>
          <Plus size={12} /> Quad
        </button>
        <button onClick={() => addShape('polygon')} style={{ justifyContent: 'center', fontSize: 12 }}>
          <Pentagon size={12} /> Polygone
        </button>
      </div>
      <button onClick={() => svgInputRef.current?.click()} style={{ width: '100%', justifyContent: 'center', fontSize: 12, marginTop: 4 }}>
        <Download size={12} style={{ transform: 'rotate(180deg)' }} /> Importer SVG (paths / polygones)
      </button>
      <input ref={svgInputRef} type="file" accept=".svg,image/svg+xml" style={{ display: 'none' }} onChange={onImportSVG} />
      <details style={{ marginTop: 6, fontSize: 12 }}>
        <summary style={{ cursor: 'pointer', padding: '4px 0', color: 'var(--text-dim)' }}>📐 Templates de forme</summary>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3, marginTop: 4 }}>
          {SHAPE_TEMPLATES.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                const base = defaultShape(shapes.length, 'polygon')
                addShapes([{ ...base, name: t.name, points: t.points }])
              }}
              style={{ fontSize: 11, justifyContent: 'flex-start', padding: '4px 6px' }}
              title={t.name}
            >
              <span style={{ marginRight: 4 }}>{t.emoji}</span>{t.name.split(' ')[0]}
            </button>
          ))}
        </div>
      </details>

      {selectedShape && (
        <div style={{ marginTop: 12, padding: 10, background: 'var(--bg)', borderRadius: 'var(--radius-sm)' }}>
          <ShapeContentEditor shape={selectedShape} update={(p) => updateShape(selectedShape.id, p)} />
          {selectedShape.kind === 'polygon' && (
            <>
              <h3 style={{ marginTop: 14 }}>✨ Lissage (Catmull-Rom)</h3>
              <Slider
                label="Courbure"
                value={selectedShape.smooth ?? 0}
                min={0} max={1} step={0.05}
                onChange={(v) => updateShape(selectedShape.id, { smooth: v })}
                format={(v) => v === 0 ? 'angulaire' : `${Math.round(v * 100)}%`}
              />
              <Slider
                label="Rotation"
                value={selectedShape.rotation ?? 0}
                min={-Math.PI} max={Math.PI} step={0.05}
                onChange={(v) => updateShape(selectedShape.id, { rotation: v })}
                format={(v) => `${Math.round(v * 180 / Math.PI)}°`}
              />
              <button
                onClick={() => updateShape(selectedShape.id, { rotation: 0 })}
                style={{ width: '100%', justifyContent: 'center', fontSize: 11, marginTop: 4 }}
              >
                Réinitialiser rotation
              </button>
            </>
          )}
          <h3 style={{ marginTop: 14 }}><Crop size={11} style={{ verticalAlign: 'middle' }} /> Source (% du rendu)</h3>
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

function WebcamZoneStatus() {
  const [cameraOn, setCameraOn] = useState<boolean>(!!(window as any).__animaCameraOn)
  const [arOn, setArOn] = useState<boolean>(!!(window as any).__animaArOn)
  useEffect(() => {
    const onCam = (e: Event) => setCameraOn(!!(e as CustomEvent<boolean>).detail)
    const onAr = (e: Event) => setArOn(!!(e as CustomEvent<boolean>).detail)
    window.addEventListener('anima:camera-state', onCam)
    window.addEventListener('anima:ar-state', onAr)
    return () => {
      window.removeEventListener('anima:camera-state', onCam)
      window.removeEventListener('anima:ar-state', onAr)
    }
  }, [])
  return (
    <div style={{ marginBottom: 8, padding: 8, background: cameraOn ? 'rgba(0,255,163,0.08)' : 'rgba(255,180,0,0.10)', border: `1px solid ${cameraOn ? 'rgba(0,255,163,0.3)' : 'rgba(255,180,0,0.3)'}`, borderRadius: 'var(--radius-sm)' }}>
      <p style={{ fontSize: 11, color: cameraOn ? 'var(--accent)' : '#ffb400', margin: 0, marginBottom: 6 }}>
        {cameraOn
          ? `✓ Caméra active${arOn ? ' · AR ON' : ''} — la zone affiche le flux webcam en direct`
          : '⚠ Caméra inactive — la zone est vide sans flux'}
      </p>
      {!cameraOn && (
        <button
          onClick={() => window.dispatchEvent(new Event('anima:request-camera'))}
          className="primary"
          style={{ width: '100%', justifyContent: 'center', fontSize: 12 }}
        >
          📹 Démarrer la caméra
        </button>
      )}
    </div>
  )
}

function ShapeContentEditor({ shape, update }: { shape: import('../types/scene').MappingShape; update: (p: Partial<import('../types/scene').MappingShape>) => void }) {
  const content = shape.content ?? { type: 'organism' as const, opacity: 1 }
  const fileRef = useRef<HTMLInputElement>(null)

  const setType = (type: 'organism' | 'video' | 'image' | 'webcam') => {
    if (type === 'organism') {
      // Keep organismKind/Values so user can toggle back without losing dedicated organism config
      update({ content: { ...content, type, opacity: content.opacity ?? 1 } })
    } else if (type === 'webcam') {
      // Strip organism-only fields, also strip src/label (irrelevant for webcam)
      update({ content: { type, opacity: content.opacity ?? 1 } })
    } else {
      // video or image — strip organism fields. Preserve src/label only if same type (no-op click).
      const sameType = content.type === type
      update({ content: { type, src: sameType ? content.src : undefined, label: sameType ? content.label : undefined, opacity: content.opacity ?? 1 } })
      // Auto-open the file picker on a fresh switch so the user immediately sees the dialog.
      if (!sameType) setTimeout(() => fileRef.current?.click(), 0)
    }
  }
  const setZoneOrganism = (kind: 'scene' | OrganismKind) => {
    if (kind === 'scene') {
      const next = { ...content }
      delete next.organismKind
      delete next.organismValues
      update({ content: next })
    } else {
      update({ content: { ...content, type: 'organism', organismKind: kind } })
    }
  }

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    const url = URL.createObjectURL(f)
    update({ content: { ...content, src: url, label: f.name } })
    e.target.value = ''
  }

  return (
    <>
      <h3 style={{ marginTop: 0 }}>📺 Contenu de {shape.name}</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 8 }}>
        <button className={content.type === 'organism' ? 'primary' : ''} onClick={() => setType('organism')} style={{ fontSize: 11, justifyContent: 'center' }}>
          <Bug size={11} /> Organisme
        </button>
        <button className={content.type === 'video' ? 'primary' : ''} onClick={() => setType('video')} style={{ fontSize: 11, justifyContent: 'center' }}>
          <Film size={11} /> Vidéo
        </button>
        <button className={content.type === 'image' ? 'primary' : ''} onClick={() => setType('image')} style={{ fontSize: 11, justifyContent: 'center' }}>
          <ImageIcon size={11} /> Image
        </button>
        <button className={content.type === 'webcam' ? 'primary' : ''} onClick={() => setType('webcam')} style={{ fontSize: 11, justifyContent: 'center' }}>
          <CameraIcon size={11} /> Webcam
        </button>
      </div>
      {(content.type === 'video' || content.type === 'image') && (
        <div style={{ marginBottom: 8 }}>
          <button
            onClick={() => fileRef.current?.click()}
            className={content.src ? 'primary' : ''}
            style={{ width: '100%', justifyContent: 'center', fontSize: 12 }}
          >
            <FolderOpen size={12} /> {content.label ?? `Choisir un ${content.type === 'video' ? 'fichier vidéo' : 'image'}…`}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={content.type === 'video' ? 'video/*' : 'image/*'}
            style={{ display: 'none' }}
            onChange={onFile}
          />
          {content.src && (
            <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
              <button
                onClick={() => update({ content: { ...content, src: undefined, label: undefined } })}
                className="ghost"
                style={{ flex: 1, fontSize: 11, justifyContent: 'center' }}
              >
                🗑 Retirer
              </button>
            </div>
          )}
          <p style={{ fontSize: 10, color: 'var(--text-mute)', marginTop: 4 }}>
            {content.src ? '✓ Chargé : ' + (content.label ?? 'fichier') : '⚠ Choisis un fichier pour activer la zone.'} <br />
            <span style={{ opacity: 0.7 }}>(Fichier local — perdu au rechargement)</span>
          </p>
        </div>
      )}
      {content.type === 'webcam' && <WebcamZoneStatus />}
      {content.type === 'organism' && (
        <div style={{ marginBottom: 10, padding: 8, background: 'var(--bg-elev-2)', borderRadius: 'var(--radius-sm)' }}>
          <div style={{ fontSize: 10, color: 'var(--text-mute)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5 }}>Organisme de cette zone</div>
          <select
            value={content.organismKind ?? 'scene'}
            onChange={(e) => setZoneOrganism(e.target.value as 'scene' | OrganismKind)}
            style={{ width: '100%', fontSize: 12 }}
          >
            <option value="scene">▦ Organisme de la scène (partagé)</option>
            <option value="boids">🐦 Boids (instance dédiée)</option>
            <option value="particles">✨ Particules (instance dédiée)</option>
            <option value="tendrils">🌿 Tendrils (instance dédiée)</option>
            <option value="cells">🧫 Cellules (instance dédiée)</option>
            <option value="worms">🐍 Worms (instance dédiée)</option>
            <option value="spores">🌸 Spores (instance dédiée)</option>
          </select>
          <p style={{ fontSize: 10, color: 'var(--text-mute)', marginTop: 5, lineHeight: 1.4 }}>
            <strong>Partagé</strong> : la zone affiche l'organisme principal de la scène.<br />
            <strong>Dédié</strong> : cette zone simule SON propre organisme (paramètres par défaut), indépendant des autres zones.
          </p>
        </div>
      )}
      <Slider
        label="Opacité"
        value={content.opacity ?? 1}
        min={0} max={1} step={0.05}
        onChange={(v) => update({ content: { ...content, opacity: v } })}
        format={(v) => `${Math.round(v * 100)}%`}
      />
    </>
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
