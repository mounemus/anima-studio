import { useEffect, useRef } from 'react'
import { Engine } from '../engine/Engine'
import { useSceneStore } from '../store/sceneStore'

interface Props {
  onEngineReady?: (e: Engine) => void
}

export function Stage({ onEngineReady }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const engineRef = useRef<Engine | null>(null)
  const current = useSceneStore((s) => s.scenes.find((x) => x.id === s.currentId))

  useEffect(() => {
    if (!ref.current) return
    const e = new Engine(ref.current)
    engineRef.current = e
    onEngineReady?.(e)
    return () => {
      e.destroy()
      engineRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // load scene on change
  useEffect(() => {
    if (current && engineRef.current) engineRef.current.loadScene(current)
  }, [current?.id])

  // apply param updates (don't reload entire scene, just patch)
  useEffect(() => {
    if (current && engineRef.current) {
      engineRef.current.updateOrganismParams(current.organism.values)
      engineRef.current.applyVisual(current.visual)
      engineRef.current.updateMapping(current.mapping)
    }
  }, [current?.organism, current?.visual, current?.mapping])

  return (
    <div className="canvas-wrap" ref={ref} />
  )
}
