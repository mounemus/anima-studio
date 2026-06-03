/** Pose skeleton overlay. Joints used by active pose obstacles are highlighted with
 *  rings color-coded by interaction (avoid=cyan, attract=pink, bounce=amber, kill=red).
 */
import { useEffect, useRef } from 'react'
import { senseBus } from '../senses/SenseBus'
import { useSceneStore } from '../store/sceneStore'
import type { ObstacleInteraction } from '../types/scene'

const BONES: Array<[number, number]> = [
  [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 12], [23, 24], [11, 23], [12, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 31], [28, 32],
  [0, 11], [0, 12],
]
const KEY_JOINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]

const INTERACTION_COLOR: Record<ObstacleInteraction, string> = {
  avoid: 'rgba(0, 212, 255, 0.95)',
  attract: 'rgba(255, 107, 166, 0.95)',
  bounce: 'rgba(255, 181, 71, 0.95)',
  kill: 'rgba(255, 90, 122, 0.95)',
}

export function PoseOverlay({ stageRef, visible }: { stageRef: React.RefObject<HTMLDivElement>; visible: boolean }) {
  const svgRef = useRef<SVGSVGElement>(null)
  // We need to read obstacles to know which joints are highlighted, but we don't want to re-render
  // on every store change. The svg is updated imperatively each frame.
  const obstacles = useSceneStore((s) => s.scenes.find((x) => x.id === s.currentId)?.obstacles ?? [])

  useEffect(() => {
    if (!visible || !stageRef.current || !svgRef.current) return
    const svg = svgRef.current
    let rafId = 0
    // Pre-compute joint → list of active obstacle interactions (for color rings)
    const jointInteractions = new Map<number, ObstacleInteraction[]>()
    for (const o of obstacles) {
      if (!o.enabled || o.kind !== 'pose' || !o.pose) continue
      for (const j of o.pose.joints) {
        const list = jointInteractions.get(j) ?? []
        list.push(o.interaction)
        jointInteractions.set(j, list)
      }
    }

    const draw = () => {
      const r = stageRef.current!.getBoundingClientRect()
      const W = r.width, H = r.height
      if (!senseBus.pose.detected) {
        svg.innerHTML = ''
        rafId = requestAnimationFrame(draw)
        return
      }
      const lm = senseBus.pose.landmarks
      let s = ''
      // bones
      for (const [a, b] of BONES) {
        const A = lm[a], B = lm[b]
        if (!A || !B || A.vis < 0.3 || B.vis < 0.3) continue
        s += `<line class="pose-bone" x1="${A.x * W}" y1="${A.y * H}" x2="${B.x * W}" y2="${B.y * H}"/>`
      }
      // joints
      for (const j of KEY_JOINTS) {
        const p = lm[j]
        if (!p || p.vis < 0.3) continue
        const interactions = jointInteractions.get(j)
        const baseR = j === 0 ? 6 : 4
        if (interactions && interactions.length > 0) {
          // Highlighted active joint — bigger + colored rings per interaction
          interactions.forEach((it, i) => {
            const ringR = baseR + 6 + i * 4
            s += `<circle cx="${p.x * W}" cy="${p.y * H}" r="${ringR}" fill="none" stroke="${INTERACTION_COLOR[it]}" stroke-width="2" opacity="0.85"/>`
          })
          s += `<circle cx="${p.x * W}" cy="${p.y * H}" r="${baseR + 2}" fill="${INTERACTION_COLOR[interactions[0]]}" stroke="white" stroke-width="1.5"/>`
        } else {
          s += `<circle class="pose-joint" cx="${p.x * W}" cy="${p.y * H}" r="${baseR}"/>`
        }
      }
      svg.innerHTML = s
      rafId = requestAnimationFrame(draw)
    }
    draw()
    return () => cancelAnimationFrame(rafId)
  }, [visible, stageRef, obstacles])

  if (!visible) return null
  return <svg ref={svgRef} className="pose-overlay" />
}
