import { useEffect, useRef, useState, useMemo } from 'react'
import { Stage } from './ui/Stage'
import { SceneList } from './ui/SceneList'
import { ParamPanel } from './ui/ParamPanel'
import { SenseMonitor } from './ui/SenseMonitor'
import { TopBar } from './ui/TopBar'
import { MappingOverlay } from './ui/MappingOverlay'
import { ObstaclesOverlay } from './ui/ObstaclesOverlay'
import { AIChat } from './ui/AIChat'
import { MirrorView } from './ui/MirrorView'
import { PoseOverlay } from './ui/PoseOverlay'
import { useSceneStore } from './store/sceneStore'
import type { Engine } from './engine/Engine'
import { Eye, AlertTriangle, Pipette } from 'lucide-react'
import { enterFullscreen } from './lib/recorder'
import { isOutputWindow } from './lib/multiDisplay'
import { pickColorAt } from './engine/ColorTracker'

export function App() {
  const load = useSceneStore((s) => s.load)
  const ready = useSceneStore((s) => s.scenes.length > 0)
  const dbStatus = useSceneStore((s) => s.dbStatus)
  const dbError = useSceneStore((s) => s.dbError)
  const [aiOpen, setAiOpen] = useState(false)
  const isOutput = useMemo(() => isOutputWindow(), [])
  const [outputMode, setOutputMode] = useState(isOutput)
  const [mirrorMode, setMirrorMode] = useState(false)
  const [selectedObstacle, setSelectedObstacle] = useState<string | null>(null)
  const [pickingForObstacle, setPickingForObstacle] = useState<string | null>(null)
  const [pickFlash, setPickFlash] = useState<{ x: number; y: number; color: string } | null>(null)
  const addObstacle = useSceneStore((s) => s.addObstacle)
  const updateObstacle = useSceneStore((s) => s.updateObstacle)
  const currentSceneId = useSceneStore((s) => s.currentId)

  // Listen for the pipette request from the obstacle UI
  useEffect(() => {
    const onPick = (e: Event) => {
      const id = (e as CustomEvent<string>).detail
      setPickingForObstacle(id)
      if (!mirrorMode) setMirrorMode(true)
    }
    window.addEventListener('anima:pick-color', onPick)
    return () => window.removeEventListener('anima:pick-color', onPick)
  }, [mirrorMode])
  useEffect(() => {
    const onSelect = (e: Event) => setSelectedObstacle((e as CustomEvent<string | null>).detail)
    window.addEventListener('anima:obstacle-select', onSelect)
    return () => window.removeEventListener('anima:obstacle-select', onSelect)
  }, [])
  const engineRef = useRef<Engine | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null!)
  const stageRef = useRef<HTMLDivElement>(null!)
  const fpsRef = useRef(0)

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const id = setInterval(() => {
      if (engineRef.current) fpsRef.current = engineRef.current.getStats().fps
    }, 200)
    return () => clearInterval(id)
  }, [])

  // Keyboard shortcuts: F = output mode, Esc = exit output mode / cancel color pick
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault()
        setOutputMode((x) => !x)
      } else if (e.key === 'Escape') {
        if (pickingForObstacle) { setPickingForObstacle(null); return }
        if (outputMode) {
          setOutputMode(false)
          if (document.fullscreenElement) document.exitFullscreen()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [outputMode, pickingForObstacle])

  // Enter/exit fullscreen alongside output mode (best-effort, may be blocked by browser)
  useEffect(() => {
    if (outputMode && stageRef.current && !document.fullscreenElement) {
      enterFullscreen(stageRef.current)
    } else if (!outputMode && document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
    }
  }, [outputMode])

  // Mirror mode → renderer transparency
  useEffect(() => {
    if (engineRef.current) engineRef.current.setTransparent(mirrorMode)
  }, [mirrorMode])

  // Pointer handler for the stage:
  // - if a color-pick is pending → sample the webcam pixel and update the tracker obstacle
  // - else: Alt+click to place a new attract circle
  const onStageClick = (e: React.PointerEvent) => {
    if (!mirrorMode || !stageRef.current || !currentSceneId) return
    const target = e.target as HTMLElement
    const onCanvas = target.tagName === 'CANVAS' || target === stageRef.current ||
      target.classList.contains('mirror-bg') || target.classList.contains('canvas-wrap')
    if (!onCanvas) return
    const r = stageRef.current.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width
    const y = (e.clientY - r.top) / r.height

    // Color picker active?
    if (pickingForObstacle) {
      const hsv = pickColorAt(videoRef.current, x, y)
      if (hsv) {
        const scene = useSceneStore.getState().scenes.find((s) => s.id === currentSceneId)
        const obs = scene?.obstacles?.find((o) => o.id === pickingForObstacle)
        if (obs?.tracker) {
          updateObstacle(pickingForObstacle, {
            tracker: { ...obs.tracker, h: hsv.h, s: hsv.s, v: hsv.v },
          })
          // Visual feedback : flash a ring at the sampled position for 600ms
          setPickFlash({ x, y, color: `hsl(${Math.round(hsv.h * 360)} ${Math.round(hsv.s * 100)}% ${Math.round(hsv.v * 100)}%)` })
          setTimeout(() => setPickFlash(null), 700)
        }
      } else {
        console.warn('pickColorAt returned null — camera not ready?')
      }
      setPickingForObstacle(null)
      return
    }

    if (!e.altKey) return                       // require Alt to place
    addObstacle('circle')
    setTimeout(() => {
      const scene = useSceneStore.getState().scenes.find((s) => s.id === currentSceneId)
      const last = scene?.obstacles?.[scene.obstacles.length - 1]
      if (last) updateObstacle(last.id, {
        circle: { cx: x, cy: y, r: 0.08 },
        interaction: 'attract',
        margin: 0.12,
        strength: 1.2,
      })
    }, 50)
  }

  return (
    <div className={`app ${outputMode ? 'app--output' : ''}`}>
      <TopBar
        videoRef={videoRef}
        fpsRef={fpsRef}
        onToggleAI={() => setAiOpen((x) => !x)}
        onToggleOutput={() => setOutputMode((x) => !x)}
        outputMode={outputMode}
        onToggleMirror={() => setMirrorMode((x) => !x)}
        mirrorMode={mirrorMode}
        canvasGetter={() => engineRef.current?.getCanvas() ?? null}
        stageRef={stageRef}
      />
      <SceneList />
      <div
        className={`stage ${mirrorMode ? 'stage--mirror' : ''}`}
        ref={stageRef}
        onPointerDown={onStageClick}
        style={pickingForObstacle ? { cursor: 'crosshair' } : undefined}
      >
        {ready ? (
          <>
            <MirrorView videoRef={videoRef} active={mirrorMode} />
            <Stage onEngineReady={(e) => { engineRef.current = e; e.setTransparent(mirrorMode) }} />
            <PoseOverlay stageRef={stageRef} visible={mirrorMode && !outputMode} />
            {!outputMode && <SenseMonitor />}
            {!outputMode && <MappingOverlay stageRef={stageRef} />}
            {!outputMode && <ObstaclesOverlay stageRef={stageRef} editing={true} selectedId={selectedObstacle} onSelect={setSelectedObstacle} />}
            {!outputMode && <AIChat open={aiOpen} />}
            {mirrorMode && !outputMode && !pickingForObstacle && (
              <div className="tap-hint">
                🪞 Miroir AR · <kbd>Alt</kbd> + clic sur l'image pour poser un attracteur
              </div>
            )}
            {pickingForObstacle && (
              <div className="tap-hint" style={{ background: 'rgba(0,212,255,0.18)', borderColor: 'var(--accent-2)', color: 'var(--accent-2)' }}>
                <Pipette size={12} style={{ verticalAlign: 'middle' }} /> Pipette active — clique sur l'objet à tracker · <kbd onClick={() => setPickingForObstacle(null)} style={{ cursor: 'pointer' }}>Esc</kbd>
              </div>
            )}
            {pickFlash && (
              <div
                className="pick-flash"
                style={{
                  left: `${pickFlash.x * 100}%`,
                  top: `${pickFlash.y * 100}%`,
                  borderColor: pickFlash.color,
                  boxShadow: `0 0 20px ${pickFlash.color}`,
                }}
              />
            )}
            {outputMode && (
              <div className="output-hint" onClick={() => setOutputMode(false)}>
                <Eye size={14} /> Mode SORTIE — pressez <kbd>F</kbd> ou <kbd>Esc</kbd> pour revenir
              </div>
            )}
          </>
        ) : (
          <div className="welcome">
            <h1>Anima Studio</h1>
            <p>Initialisation...</p>
          </div>
        )}
      </div>
      <ParamPanel />
      {/*
        Tracking video : kept "displayed" (1×1 px off-screen, opacity 0) instead of display:none.
        Some browsers stall the MediaStream pipeline on display:none, which prevents the visible
        Mirror video from showing live frames.
      */}
      <video
        ref={videoRef}
        style={{ position: 'fixed', left: 0, top: 0, width: 1, height: 1, opacity: 0, pointerEvents: 'none', zIndex: -1 }}
        autoPlay
        playsInline
        muted
      />
      {dbStatus === 'fallback' && (
        <div className="db-warning">
          <AlertTriangle size={14} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong>Stockage indisponible</strong> — tes modifications ne seront pas sauvegardées.
            <div style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 2 }}>
              {dbError ?? 'localStorage indisponible (mode privé ?)'}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
