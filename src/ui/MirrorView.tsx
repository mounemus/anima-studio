/** AR Mirror — shows the live webcam as a full-stage background, behind the canvas.
 *  When the scene declares a webcamFilter, the raw <video> is replaced by a WebGL
 *  canvas that runs the shader pipeline on the live stream every frame. */
import { useEffect, useRef, useState } from 'react'
import { useSceneStore } from '../store/sceneStore'
import { WebcamFilterPass, type WebcamFilterConfig } from '../engine/WebcamFilters'

interface Props {
  videoRef: React.RefObject<HTMLVideoElement>
  active: boolean
  opacity?: number
}

export function MirrorView({ videoRef, active, opacity = 0.7 }: Props) {
  const dispRef = useRef<HTMLVideoElement>(null)
  const filterCanvasRef = useRef<HTMLCanvasElement>(null)
  const passRef = useRef<WebcamFilterPass | null>(null)
  const [streamReady, setStreamReady] = useState(false)

  // Pick the live filter config from the active scene. We watch each leaf field so
  // a slider tweak immediately rebinds, without rebuilding the WebGL pipeline.
  const filter = useSceneStore((s) => {
    const cur = s.scenes.find((x) => x.id === s.currentId)
    return cur?.webcamFilter as WebcamFilterConfig | undefined
  })
  const filterActive = !!filter && filter.kind !== 'none'

  // Stream + autoplay management — unchanged from before
  useEffect(() => {
    if (!active) { setStreamReady(false); return }
    if (!dispRef.current) return
    const display = dispRef.current
    let cancelled = false
    const apply = () => {
      const src = videoRef.current
      if (!src || cancelled) return
      const stream = src.srcObject as MediaStream | null
      if (stream && display.srcObject !== stream) {
        display.srcObject = stream
        setStreamReady(true)
      }
      if (display.srcObject && display.paused) {
        display.play().catch((e) => console.warn('mirror play failed', e))
      }
    }
    apply()
    const id = setInterval(apply, 250)
    return () => { cancelled = true; clearInterval(id) }
  }, [active, videoRef])

  // Spin up / tear down the WebGL filter pass when the filter toggles on/off.
  useEffect(() => {
    if (!filterActive || !filterCanvasRef.current) return
    const pass = new WebcamFilterPass(filterCanvasRef.current)
    pass.setVideo(dispRef.current)
    passRef.current = pass
    pass.start()
    return () => { pass.stop(); pass.dispose(); passRef.current = null }
  }, [filterActive])

  // Live-update the config every frame's-worth of React updates without restarting WebGL.
  useEffect(() => {
    if (passRef.current && filter) passRef.current.setConfig(filter)
  }, [filter])

  // Hot-swap the source video element if the stream becomes available later.
  useEffect(() => {
    if (passRef.current) passRef.current.setVideo(dispRef.current)
  }, [streamReady, filterActive])

  if (!active) return null

  return (
    <>
      <video
        ref={dispRef}
        className="mirror-bg"
        // Hide the raw video when a filter is on — the filter canvas takes over.
        style={{ opacity: filterActive ? 0 : opacity, pointerEvents: 'none' }}
        autoPlay
        playsInline
        muted
      />
      {filterActive && (
        <canvas
          ref={filterCanvasRef}
          className="mirror-bg"
          style={{ opacity, pointerEvents: 'none' }}
        />
      )}
      {!streamReady && (
        <div className="mirror-waiting">
          <div className="mirror-waiting-spinner" />
          Démarrage de la caméra…
        </div>
      )}
    </>
  )
}
