import { useEffect, useRef, useState, useMemo } from 'react'
import { Stage } from './ui/Stage'
import { SceneList } from './ui/SceneList'
import { ParamPanel } from './ui/ParamPanel'
import { SenseMonitor } from './ui/SenseMonitor'
import { TopBar } from './ui/TopBar'
import { MappingOverlay } from './ui/MappingOverlay'
import { ObstaclesOverlay } from './ui/ObstaclesOverlay'
import { AIChat } from './ui/AIChat'
import { useSceneStore } from './store/sceneStore'
import type { Engine } from './engine/Engine'
import { Eye, AlertTriangle, RefreshCw } from 'lucide-react'
import { enterFullscreen } from './lib/recorder'
import { isOutputWindow } from './lib/multiDisplay'
import { resetDb } from './lib/db'

export function App() {
  const load = useSceneStore((s) => s.load)
  const ready = useSceneStore((s) => s.scenes.length > 0)
  const dbStatus = useSceneStore((s) => s.dbStatus)
  const dbError = useSceneStore((s) => s.dbError)
  const [aiOpen, setAiOpen] = useState(false)
  const isOutput = useMemo(() => isOutputWindow(), [])
  const [outputMode, setOutputMode] = useState(isOutput)
  const [selectedObstacle, setSelectedObstacle] = useState<string | null>(null)
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

  // Keyboard shortcuts: F = output mode, Esc = exit output mode
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ignore if typing
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault()
        setOutputMode((x) => !x)
      } else if (e.key === 'Escape' && outputMode) {
        setOutputMode(false)
        if (document.fullscreenElement) document.exitFullscreen()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [outputMode])

  // Enter/exit fullscreen alongside output mode (best-effort, may be blocked by browser)
  useEffect(() => {
    if (outputMode && stageRef.current && !document.fullscreenElement) {
      enterFullscreen(stageRef.current)
    } else if (!outputMode && document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
    }
  }, [outputMode])

  return (
    <div className={`app ${outputMode ? 'app--output' : ''}`}>
      <TopBar
        videoRef={videoRef}
        fpsRef={fpsRef}
        onToggleAI={() => setAiOpen((x) => !x)}
        onToggleOutput={() => setOutputMode((x) => !x)}
        outputMode={outputMode}
        canvasGetter={() => engineRef.current?.getCanvas() ?? null}
        stageRef={stageRef}
      />
      <SceneList />
      <div className="stage" ref={stageRef}>
        {ready ? (
          <>
            <Stage onEngineReady={(e) => { engineRef.current = e }} />
            {!outputMode && <SenseMonitor />}
            {!outputMode && <MappingOverlay stageRef={stageRef} />}
            {!outputMode && <ObstaclesOverlay stageRef={stageRef} editing={true} selectedId={selectedObstacle} onSelect={setSelectedObstacle} />}
            {!outputMode && <AIChat open={aiOpen} />}
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
      <video ref={videoRef} style={{ display: 'none' }} autoPlay playsInline muted />
      {dbStatus === 'fallback' && (
        <div className="db-warning">
          <AlertTriangle size={14} />
          <div style={{ flex: 1 }}>
            <strong>Mode hors-ligne</strong> — IndexedDB inaccessible. Tes modifications ne seront pas sauvegardées.
            <div style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 2 }}>
              {dbError}
            </div>
          </div>
          <button
            onClick={() => { resetDb(); load() }}
            className="primary"
            style={{ fontSize: 11, padding: '4px 8px' }}
          >
            <RefreshCw size={11} /> Réessayer
          </button>
        </div>
      )}
    </div>
  )
}
