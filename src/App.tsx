import { useEffect, useRef, useState } from 'react'
import { Stage } from './ui/Stage'
import { SceneList } from './ui/SceneList'
import { ParamPanel } from './ui/ParamPanel'
import { SenseMonitor } from './ui/SenseMonitor'
import { TopBar } from './ui/TopBar'
import { MappingOverlay } from './ui/MappingOverlay'
import { AIChat } from './ui/AIChat'
import { useSceneStore } from './store/sceneStore'
import type { Engine } from './engine/Engine'
import { Eye } from 'lucide-react'
import { enterFullscreen } from './lib/recorder'

export function App() {
  const load = useSceneStore((s) => s.load)
  const ready = useSceneStore((s) => s.scenes.length > 0)
  const [aiOpen, setAiOpen] = useState(false)
  const [outputMode, setOutputMode] = useState(false)
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
    </div>
  )
}
