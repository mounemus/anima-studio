/** AR Mirror — shows the live webcam as a full-stage background, behind the canvas. */
import { useEffect, useRef } from 'react'

interface Props {
  videoRef: React.RefObject<HTMLVideoElement>
  active: boolean
  opacity?: number   // 0..1 of the mirror visibility
}

/**
 * Renders the same MediaStream as the hidden tracking video but visually shown,
 * mirrored horizontally to match the user's expectations.
 */
export function MirrorView({ videoRef, active, opacity = 0.65 }: Props) {
  const dispRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    if (!active || !dispRef.current || !videoRef.current) return
    const display = dispRef.current
    const src = videoRef.current
    // Tie display to source stream
    const apply = () => {
      if (src.srcObject && display.srcObject !== src.srcObject) {
        display.srcObject = src.srcObject
        display.play().catch(() => {})
      }
    }
    apply()
    const id = setInterval(apply, 500)
    return () => clearInterval(id)
  }, [active, videoRef])

  if (!active) return null

  return (
    <video
      ref={dispRef}
      className="mirror-bg"
      style={{ opacity }}
      autoPlay
      playsInline
      muted
    />
  )
}
