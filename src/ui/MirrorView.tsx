/** AR Mirror — shows the live webcam as a full-stage background, behind the canvas. */
import { useEffect, useRef, useState } from 'react'

interface Props {
  videoRef: React.RefObject<HTMLVideoElement>
  active: boolean
  opacity?: number
}

/**
 * Renders a visible <video> tied to the same MediaStream as the hidden tracking <video>,
 * mirrored horizontally for natural self-recognition.
 */
export function MirrorView({ videoRef, active, opacity = 0.7 }: Props) {
  const dispRef = useRef<HTMLVideoElement>(null)
  const [streamReady, setStreamReady] = useState(false)

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
      // Force play if paused (browser autoplay can stall on second video)
      if (display.srcObject && display.paused) {
        display.play().catch((e) => console.warn('mirror play failed', e))
      }
    }

    apply()
    const id = setInterval(apply, 250)
    return () => { cancelled = true; clearInterval(id) }
  }, [active, videoRef])

  if (!active) return null

  return (
    <>
      <video
        ref={dispRef}
        className="mirror-bg"
        style={{ opacity }}
        autoPlay
        playsInline
        muted
      />
      {!streamReady && (
        <div className="mirror-waiting">
          <div className="mirror-waiting-spinner" />
          Démarrage de la caméra…
        </div>
      )}
    </>
  )
}
