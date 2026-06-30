/**
 * HandsOverlay — squelette des 21 landmarks MediaPipe Hands.
 *
 * Affiche en SVG par-dessus le canvas :
 *   - 5 chaînes de doigts (pouce, index, majeur, annulaire, auriculaire)
 *   - 3 ponts de paume (5-9, 9-13, 13-17) pour fermer la main
 *   - Un cercle plus gros sur le poignet (0) et l'index tip (8)
 *   - L'indicateur de pinch (cercle qui rétrécit entre pouce et index)
 *   - Les obstacles 'hand' actifs affichent un ring coloré selon l'interaction
 *
 * Coordinate convention : senseBus.hands.landmarks.x est déjà mirroré (mirror
 * webcam), .y est top-left. On scale × stage size pour le placement.
 *
 * Performance : redraw via innerHTML par frame — économique sur 21 nodes.
 * S'auto-masque quand senseBus.hands.detected = false.
 */
import { useEffect, useMemo, useRef } from 'react'
import { senseBus } from '../senses/SenseBus'
import { useSceneStore } from '../store/sceneStore'
import type { ObstacleInteraction } from '../types/scene'

const EMPTY_ARRAY: any[] = []

// MediaPipe Hands connections — same skeleton used in their official docs.
const FINGER_CHAINS: Array<[number, number]> = [
  // Thumb
  [0, 1], [1, 2], [2, 3], [3, 4],
  // Index
  [0, 5], [5, 6], [6, 7], [7, 8],
  // Middle
  [5, 9], [9, 10], [10, 11], [11, 12],
  // Ring
  [9, 13], [13, 14], [14, 15], [15, 16],
  // Pinky
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
]

const INTERACTION_COLOR: Record<ObstacleInteraction, string> = {
  avoid: 'rgba(0, 212, 255, 0.95)',
  attract: 'rgba(255, 107, 166, 0.95)',
  bounce: 'rgba(255, 181, 71, 0.95)',
  kill: 'rgba(255, 90, 122, 0.95)',
}

export function HandsOverlay({ stageRef, visible }: { stageRef: React.RefObject<HTMLDivElement>; visible: boolean }) {
  const svgRef = useRef<SVGSVGElement>(null)
  // Stable empty fallback so Zustand selector never returns a new [] reference
  // on each render (caused the infinite-getSnapshot warning + React unmount).
  const obstacles = useSceneStore((s) => s.scenes.find((x) => x.id === s.currentId)?.obstacles ?? EMPTY_ARRAY)
  const handObstacleMemo = useMemo(
    () => obstacles.find((o) => o.enabled && o.kind === 'hand'),
    [obstacles],
  )

  useEffect(() => {
    if (!visible || !stageRef.current || !svgRef.current) return
    const svg = svgRef.current
    let rafId = 0
    const handObstacle = handObstacleMemo
    const handObsColor = handObstacle ? INTERACTION_COLOR[handObstacle.interaction] : null

    const draw = () => {
      const r = stageRef.current!.getBoundingClientRect()
      const W = r.width, H = r.height
      if (!senseBus.hands.detected) {
        if (svg.innerHTML !== '') svg.innerHTML = ''
        rafId = requestAnimationFrame(draw)
        return
      }
      const lm = senseBus.hands.landmarks
      let s = ''
      // Bones
      for (const [a, b] of FINGER_CHAINS) {
        const A = lm[a], B = lm[b]
        if (!A || !B) continue
        s += `<line class="hand-bone" x1="${A.x * W}" y1="${A.y * H}" x2="${B.x * W}" y2="${B.y * H}"/>`
      }
      // Joints (small circles on every landmark)
      for (let i = 0; i < 21; i++) {
        const p = lm[i]
        if (!p) continue
        // Fingertips a bit bigger
        const isTip = i === 4 || i === 8 || i === 12 || i === 16 || i === 20
        const r = isTip ? 4 : 2.5
        s += `<circle class="hand-joint${isTip ? ' tip' : ''}" cx="${p.x * W}" cy="${p.y * H}" r="${r}"/>`
      }
      // Wrist + index tip — bigger anchor circles
      const wrist = lm[0]
      const idx = lm[8]
      if (wrist) s += `<circle class="hand-anchor" cx="${wrist.x * W}" cy="${wrist.y * H}" r="6"/>`
      if (idx) s += `<circle class="hand-tip-major" cx="${idx.x * W}" cy="${idx.y * H}" r="7"/>`
      // Pinch indicator : circle on the midpoint between thumb-tip (4) and index-tip (8)
      const thumb = lm[4]
      if (thumb && idx) {
        const mx = (thumb.x + idx.x) * 0.5 * W
        const my = (thumb.y + idx.y) * 0.5 * H
        const pinchRadius = 16 * (1 - senseBus.hands.pinch * 0.85)
        s += `<circle class="hand-pinch" cx="${mx}" cy="${my}" r="${Math.max(3, pinchRadius)}"/>`
      }
      // Hand-obstacle ring (when an obstacle uses the hand as a collider)
      if (handObsColor && handObstacle?.hand) {
        const target = handObstacle.hand.source === 'index' ? idx : (lm[9] ?? wrist)
        if (target) {
          const radiusPx = (handObstacle.hand.radius ?? 0.12) * Math.max(W, H)
          s += `<circle cx="${target.x * W}" cy="${target.y * H}" r="${radiusPx}" fill="none" stroke="${handObsColor}" stroke-width="2.2" opacity="0.85"/>`
        }
      }
      svg.innerHTML = s
      rafId = requestAnimationFrame(draw)
    }
    draw()
    return () => cancelAnimationFrame(rafId)
  }, [visible, stageRef, handObstacleMemo])

  if (!visible) return null
  return <svg ref={svgRef} className="hands-overlay" />
}
