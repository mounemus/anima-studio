import { useEffect, useRef, useState } from 'react'
import { Engine } from '../engine/Engine'
import { useSceneStore } from '../store/sceneStore'
import { startSilhouette, stopSilhouette } from '../senses/Silhouette'
import { startColorTracking, stopColorTracking } from '../engine/ColorTracker'
import { invalidateWebcamCache } from '../engine/ContentSources'

interface Props {
  onEngineReady?: (e: Engine) => void
}

export function Stage({ onEngineReady }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const engineRef = useRef<Engine | null>(null)
  const current = useSceneStore((s) => s.scenes.find((x) => x.id === s.currentId))
  // Tracks camera on/off. The silhouette/mask effects depend on it so they
  // re-run when the camera is turned on AFTER a scene (with a body mask) is
  // already loaded — previously they snapshotted document.querySelector('video')
  // once and never re-evaluated, so the mask never started in that order.
  const [cameraReady, setCameraReady] = useState<boolean>(!!(window as any).__animaCameraOn)
  useEffect(() => {
    const onState = () => setCameraReady(!!(window as any).__animaCameraOn)
    window.addEventListener('anima:camera-state', onState)
    return () => window.removeEventListener('anima:camera-state', onState)
  }, [])

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

  // Start/stop silhouette segmentation when needed (silhouette obstacle, maskBody,
  // OR a webcamFilter with applyTo restricted to body/background — without the
  // SelfieSegmenter feeding the mask the filter would silently fall back to
  // whole-frame mode).
  useEffect(() => {
    const needForObstacle = current?.obstacles?.some((o) => o.kind === 'silhouette' && o.enabled) ?? false
    const needForMaskBody = !!current?.mapping?.arMaskBody
    const filterApplyTo = current?.webcamFilter?.applyTo
    const needForFilter = current?.webcamFilter?.kind && current.webcamFilter.kind !== 'none'
      && filterApplyTo && filterApplyTo !== 'all'
    // The organism-layer mask uses the same SelfieSegmenter buffer — auto-start it
    // so 'Mask organism on body' actually shows the body without an extra checkbox.
    const needForOrganismMask = current?.organismMask && current.organismMask.mode !== 'all'
    const need = needForObstacle || needForMaskBody || !!needForFilter || !!needForOrganismMask
    const video = document.querySelector('video') as HTMLVideoElement | null
    if (need && video?.srcObject) {
      startSilhouette(video).catch((e) => console.warn('Silhouette failed', e))
    } else {
      stopSilhouette()
    }
  }, [current?.obstacles, current?.mapping?.arMaskBody, current?.webcamFilter?.kind, current?.webcamFilter?.applyTo, current?.organismMask?.mode, cameraReady])

  // Start/stop color tracking based on tracker obstacles
  useEffect(() => {
    const needTracker = current?.obstacles?.some((o) => o.kind === 'tracker' && o.enabled) ?? false
    const video = document.querySelector('video') as HTMLVideoElement | null
    if (needTracker && video?.srcObject) {
      startColorTracking(video)
    } else {
      stopColorTracking()
    }
  }, [current?.obstacles, cameraReady])

  // Propagate flow updates
  useEffect(() => {
    if (current && engineRef.current) engineRef.current.updateFlow(current.flow)
  }, [current?.flow])

  // Propagate modifier updates — without this, Vortex / GravityWell / ColorCycle /
  // PulseGate / MagneticBands only "took" on a full scene reload because Engine
  // reads modifiers from currentScene every frame.
  useEffect(() => {
    if (current && engineRef.current) engineRef.current.updateModifiers(current.modifiers ?? [])
  }, [current?.modifiers])

  // React to camera state changes: invalidate webcam textures and force a re-resolve
  // so zones using webcam content pick up (or release) the live MediaStream.
  useEffect(() => {
    const onCamState = () => {
      invalidateWebcamCache()
      const sc = useSceneStore.getState().scenes.find((x) => x.id === useSceneStore.getState().currentId)
      if (sc && engineRef.current) engineRef.current.updateMapping(sc.mapping)
    }
    window.addEventListener('anima:camera-state', onCamState)
    return () => window.removeEventListener('anima:camera-state', onCamState)
  }, [])

  // Auto-request the camera as soon as a zone selects 'webcam' content
  // (or arClipToZones is on, since AR-in-zones implies webcam zones make sense)
  // OR a webcam filter / organism mask needs the silhouette — those run on top
  // of MediaPipe which itself needs the video stream. Without this, picking
  // 'Mon corps seulement' on either mask silently fails (no video → no
  // SelfieSegmenter output → mask shader sees uMaskValid=0 → 'all' fallback).
  useEffect(() => {
    const needsForZones = !!(
      current?.mapping?.shapes?.some((sh) => (sh.content?.type === 'webcam' || sh.chromaKey) && sh.enabled)
    )
    const filterNeedsCamera = current?.webcamFilter?.kind && current.webcamFilter.kind !== 'none'
    const orgMaskNeedsCamera = current?.organismMask && current.organismMask.mode !== 'all'
    const silObstacle = current?.obstacles?.some((o) => o.kind === 'silhouette' && o.enabled)
    const needsCamera = needsForZones || !!filterNeedsCamera || !!orgMaskNeedsCamera || !!silObstacle
    if (needsCamera && !(window as any).__animaCameraOn) {
      window.dispatchEvent(new Event('anima:request-camera'))
    }
  }, [current?.mapping?.shapes, current?.webcamFilter?.kind, current?.organismMask?.mode, current?.obstacles])

  return (
    <div className="canvas-wrap" ref={ref} />
  )
}
