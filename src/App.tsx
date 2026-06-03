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

export function App() {
  const load = useSceneStore((s) => s.load)
  const ready = useSceneStore((s) => s.scenes.length > 0)
  const [aiOpen, setAiOpen] = useState(false)
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

  return (
    <div className="app">
      <TopBar
        videoRef={videoRef}
        fpsRef={fpsRef}
        onToggleAI={() => setAiOpen((x) => !x)}
        canvasGetter={() => engineRef.current?.getCanvas() ?? null}
        stageRef={stageRef}
      />
      <SceneList />
      <div className="stage" ref={stageRef}>
        {ready ? (
          <>
            <Stage onEngineReady={(e) => { engineRef.current = e }} />
            <SenseMonitor />
            <MappingOverlay stageRef={stageRef} />
            <AIChat open={aiOpen} />
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
