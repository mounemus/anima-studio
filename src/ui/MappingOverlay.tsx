import { useEffect, useRef } from 'react'
import { useSceneStore } from '../store/sceneStore'

export function MappingOverlay({ stageRef }: { stageRef: React.RefObject<HTMLDivElement> }) {
  const current = useSceneStore((s) => s.scenes.find((x) => x.id === s.currentId))
  const update = useSceneStore((s) => s.updateMapping)
  const dragRef = useRef<number | null>(null)

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (dragRef.current === null || !stageRef.current || !current) return
      const r = stageRef.current.getBoundingClientRect()
      const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
      const y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))
      const corners = [...current.mapping.corners] as typeof current.mapping.corners
      corners[dragRef.current] = { x, y }
      update({ corners })
    }
    const onUp = () => { dragRef.current = null }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [current, stageRef, update])

  if (!current || !current.mapping.enabled || !stageRef.current) return null
  const r = stageRef.current.getBoundingClientRect()
  const corners = current.mapping.corners
  return (
    <div className="mapping-overlay">
      <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
        <polyline
          className="mapping-edge"
          points={corners.map((c) => `${c.x * r.width},${c.y * r.height}`).concat(`${corners[0].x * r.width},${corners[0].y * r.height}`).join(' ')}
        />
      </svg>
      {corners.map((c, i) => (
        <div
          key={i}
          className="mapping-corner"
          style={{ left: c.x * r.width, top: c.y * r.height }}
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture(e.pointerId)
            dragRef.current = i
          }}
          title={['Haut-gauche', 'Haut-droite', 'Bas-droite', 'Bas-gauche'][i]}
        />
      ))}
    </div>
  )
}
