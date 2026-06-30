/** Draws the live SelfieSegmenter silhouette mask as a soft glowing outline overlay,
 *  color-coded by the obstacle's interaction. Only active when at least one
 *  silhouette obstacle is enabled.
 */
import { useEffect, useMemo, useRef } from 'react'
import { useSceneStore } from '../store/sceneStore'
import { getSilhouetteMask } from '../senses/Silhouette'
import type { ObstacleInteraction } from '../types/scene'

const INTERACTION_RGBA: Record<ObstacleInteraction, [number, number, number]> = {
  avoid: [0, 212, 255],
  attract: [255, 107, 166],
  bounce: [255, 181, 71],
  kill: [255, 90, 122],
}

const EMPTY_ARRAY: any[] = []

export function SilhouetteOverlay({ stageRef }: { stageRef: React.RefObject<HTMLDivElement> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // CRITICAL: the previous code did `... ?? []` inside the Zustand selector which
  // returned a NEW array reference every render → Zustand's getSnapshot detected
  // it as a state change → infinite re-render warning, which combined with the
  // .filter() below feeding useEffect deps caused React to unmount the entire
  // tree (black screen on scene switch). Use a stable empty reference instead.
  const obstacles = useSceneStore((s) => s.scenes.find((x) => x.id === s.currentId)?.obstacles ?? EMPTY_ARRAY)
  // Memoize so the useEffect dep list doesn't see a new array every render.
  // Only re-derive when the underlying obstacles array reference (or relevant
  // fields) actually change.
  const activeSilhouettes = useMemo(
    () => obstacles.filter((o) => o.enabled && o.kind === 'silhouette'),
    [obstacles],
  )

  useEffect(() => {
    if (activeSilhouettes.length === 0 || !canvasRef.current || !stageRef.current) return
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let rafId = 0

    const resize = () => {
      const r = stageRef.current!.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.floor(r.width * dpr)
      canvas.height = Math.floor(r.height * dpr)
      canvas.style.width = `${r.width}px`
      canvas.style.height = `${r.height}px`
      ctx.scale(dpr, dpr)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(stageRef.current)

    // Offscreen 1-channel scratch canvas to draw mask pixels then composite blurred onto display
    const scratch = document.createElement('canvas')
    let scratchCtx: CanvasRenderingContext2D | null = null

    const draw = () => {
      rafId = requestAnimationFrame(draw)
      const mask = getSilhouetteMask()
      if (!mask) return
      const r = stageRef.current!.getBoundingClientRect()
      const W = r.width, H = r.height
      if (scratch.width !== mask.w || scratch.height !== mask.h) {
        scratch.width = mask.w
        scratch.height = mask.h
        scratchCtx = scratch.getContext('2d')
      }
      if (!scratchCtx) return
      // Use the first silhouette obstacle's interaction for color
      const o = activeSilhouettes[0]
      // Skip the entire draw if the user hid the overlay — physics still run
      // through the engine; this just blanks the on-screen cyan glow.
      if (o.silhouette?.hideOverlay) { ctx.clearRect(0, 0, W, H); return }
      const opacity = o.silhouette?.overlayOpacity ?? 0.5
      if (opacity <= 0.001) { ctx.clearRect(0, 0, W, H); return }
      const [R, G, B] = INTERACTION_RGBA[o.interaction]
      const invert = o.silhouette?.invert ?? false
      const img = scratchCtx.createImageData(mask.w, mask.h)
      // Base alpha 160 (≈ previous "soft 80 + edge 70 ≈ 0.6" composite) scaled by opacity
      const baseAlpha = Math.round(160 * opacity)
      for (let i = 0; i < mask.data.length; i++) {
        const v = mask.data[i] > 127
        const on = v !== invert
        const o4 = i * 4
        img.data[o4] = R
        img.data[o4 + 1] = G
        img.data[o4 + 2] = B
        img.data[o4 + 3] = on ? baseAlpha : 0
      }
      scratchCtx.putImageData(img, 0, 0)

      // Composite onto display with mirror, soft blur, and a brighter edge highlight
      ctx.clearRect(0, 0, W, H)
      ctx.save()
      ctx.translate(W, 0)
      ctx.scale(-1, 1)   // mirror X to match the displayed webcam
      // Soft fill
      ctx.filter = 'blur(5px)'
      ctx.globalAlpha = opacity
      ctx.drawImage(scratch, 0, 0, W, H)
      // Hard edge (less blur, more contrast)
      ctx.filter = 'blur(1px) brightness(1.7)'
      ctx.globalAlpha = 0.7 * opacity
      ctx.drawImage(scratch, 0, 0, W, H)
      ctx.restore()
      ctx.filter = 'none'
      ctx.globalAlpha = 1
    }
    draw()

    return () => { cancelAnimationFrame(rafId); ro.disconnect() }
  }, [activeSilhouettes, stageRef])

  if (activeSilhouettes.length === 0) return null
  return <canvas ref={canvasRef} className="silhouette-overlay" />
}
