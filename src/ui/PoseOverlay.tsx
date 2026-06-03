/** Faint pose skeleton overlay drawn from senseBus.pose.landmarks. */
import { useEffect, useRef } from 'react'
import { senseBus } from '../senses/SenseBus'

const BONES: Array<[number, number]> = [
  // arms
  [11, 13], [13, 15], [12, 14], [14, 16],
  // shoulders + hips
  [11, 12], [23, 24], [11, 23], [12, 24],
  // legs
  [23, 25], [25, 27], [24, 26], [26, 28],
  // feet
  [27, 31], [28, 32],
  // head
  [0, 11], [0, 12],
]
const KEY_JOINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]

export function PoseOverlay({ stageRef, visible }: { stageRef: React.RefObject<HTMLDivElement>; visible: boolean }) {
  const svgRef = useRef<SVGSVGElement>(null)

  useEffect(() => {
    if (!visible || !stageRef.current || !svgRef.current) return
    const svg = svgRef.current
    let rafId = 0
    const draw = () => {
      const r = stageRef.current!.getBoundingClientRect()
      const W = r.width, H = r.height
      if (!senseBus.pose.detected) {
        svg.innerHTML = ''
        rafId = requestAnimationFrame(draw)
        return
      }
      const lm = senseBus.pose.landmarks
      // Build all SVG elements as a single innerHTML burst (fast)
      let s = ''
      for (const [a, b] of BONES) {
        const A = lm[a], B = lm[b]
        if (!A || !B || A.vis < 0.3 || B.vis < 0.3) continue
        s += `<line class="pose-bone" x1="${A.x * W}" y1="${A.y * H}" x2="${B.x * W}" y2="${B.y * H}"/>`
      }
      for (const j of KEY_JOINTS) {
        const p = lm[j]
        if (!p || p.vis < 0.3) continue
        s += `<circle class="pose-joint" cx="${p.x * W}" cy="${p.y * H}" r="${j === 0 ? 6 : 4}"/>`
      }
      svg.innerHTML = s
      rafId = requestAnimationFrame(draw)
    }
    draw()
    return () => cancelAnimationFrame(rafId)
  }, [visible, stageRef])

  if (!visible) return null
  return <svg ref={svgRef} className="pose-overlay" />
}
