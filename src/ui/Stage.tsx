import { useEffect, useRef } from 'react'
import { Engine } from '../engine/Engine'
import { useSceneStore } from '../store/sceneStore'
import { startSilhouette, stopSilhouette } from '../senses/Silhouette'

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
    // Expose renderer for WebXR helpers (one-shot read by TopBar)
    ;(window as any).__animaRenderer = e.getRenderer()
    onEngineReady?.(e)
    return () => {
      e.destroy()
      engineRef.current = null
      try { delete (window as any).__animaRenderer } catch { /* noop */ }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // load (or fully reload) scene when id OR organism KIND changes
  // — kind change requires recreating the organism instance, not just updating params.
  useEffect(() => {
    if (current && engineRef.current) engineRef.current.loadScene(current)
  }, [current?.id, current?.organism.kind])

  // apply param updates (don't reload entire scene, just patch values)
  useEffect(() => {
    if (current && engineRef.current) {
      engineRef.current.updateOrganismParams(current.organism.values)
      engineRef.current.applyVisual(current.visual)
      engineRef.current.updateMapping(current.mapping)
      engineRef.current.updateObstacles(current.obstacles ?? [])
    }
  }, [current?.organism, current?.visual, current?.mapping, current?.obstacles])

  // Start/stop silhouette segmentation based on whether a silhouette obstacle is enabled
  useEffect(() => {
    const needSilhouette = current?.obstacles?.some((o) => o.kind === 'silhouette' && o.enabled) ?? false
    const video = document.querySelector('video') as HTMLVideoElement | null
    if (needSilhouette && video?.srcObject) {
      startSilhouette(video).catch((e) => console.warn('Silhouette failed', e))
    } else {
      stopSilhouette()
    }
    return () => { /* keep running across renders */ }
  }, [current?.obstacles])

  return (
    <div className="canvas-wrap" ref={ref} />
  )
}
