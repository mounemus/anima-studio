import { useEffect, useRef, useState } from 'react'
import { useSceneStore } from '../store/sceneStore'
import type { Vec2 } from '../types/scene'

interface DragState { shapeId: string; cornerIdx: number }

export function MappingOverlay({ stageRef }: { stageRef: React.RefObject<HTMLDivElement> }) {
  const current = useSceneStore((s) => s.scenes.find((x) => x.id === s.currentId))
  const update = useSceneStore((s) => s.updateMapping)
  const updateShape = useSceneStore((s) => s.updateMappingShape)
  const selectShape = useSceneStore((s) => s.selectMappingShape)
  const dragRef = useRef<DragState | null>(null)
  const [, forceUpdate] = useState(0)

  useEffect(() => {
    const onResize = () => forceUpdate((x) => x + 1)
    const ro = new ResizeObserver(onResize)
    if (stageRef.current) ro.observe(stageRef.current)
    return () => ro.disconnect()
  }, [stageRef])

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragRef.current || !stageRef.current || !current) return
      const r = stageRef.current.getBoundingClientRect()
      const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
      const y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))
      const d = dragRef.current
      if (d.shapeId === '__legacy__') {
        // editing legacy single-corner system
        const corners = [...current.mapping.corners] as typeof current.mapping.corners
        corners[d.cornerIdx] = { x, y }
        update({ corners })
      } else {
        const shape = current.mapping.shapes?.find((s) => s.id === d.shapeId)
        if (!shape) return
        const corners = [...shape.corners] as typeof shape.corners
        corners[d.cornerIdx] = { x, y }
        updateShape(d.shapeId, { corners })
      }
    }
    const onUp = () => { dragRef.current = null }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [current, stageRef, update, updateShape])

  if (!current || !current.mapping.enabled || !stageRef.current) return null
  const rect = stageRef.current.getBoundingClientRect()
  const W = rect.width, H = rect.height

  // Effective shapes: either multi-shapes, or fallback to legacy single corners
  const shapes: { id: string; name: string; corners: [Vec2, Vec2, Vec2, Vec2]; enabled: boolean }[] =
    current.mapping.shapes && current.mapping.shapes.length > 0
      ? current.mapping.shapes
      : [{ id: '__legacy__', name: 'Zone', corners: current.mapping.corners, enabled: true }]

  const selectedIdx = current.mapping.selectedShape ?? 0

  return (
    <div className="mapping-overlay">
      <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
        {shapes.map((s, idx) => {
          const points = s.corners.map((c) => `${c.x * W},${c.y * H}`).join(' ')
            + ` ${s.corners[0].x * W},${s.corners[0].y * H}`
          const isSelected = idx === selectedIdx
          return (
            <g key={s.id} onClick={() => s.id !== '__legacy__' && selectShape(idx)} style={{ cursor: s.id === '__legacy__' ? 'default' : 'pointer', pointerEvents: 'auto' }}>
              <polyline
                points={points}
                stroke={isSelected ? 'var(--accent)' : 'var(--text-mute)'}
                strokeWidth={isSelected ? 1.5 : 1}
                strokeDasharray={isSelected ? '0' : '4 4'}
                fill="none"
                opacity={s.enabled ? 0.85 : 0.3}
              />
              {/* label at first corner */}
              <text
                x={s.corners[0].x * W + 12}
                y={s.corners[0].y * H + 18}
                fill={isSelected ? 'var(--accent)' : 'var(--text-mute)'}
                fontSize="11"
                fontFamily="var(--mono)"
              >
                {s.name}
              </text>
            </g>
          )
        })}
      </svg>
      {shapes.map((s, idx) => {
        const isSelected = idx === selectedIdx
        if (!isSelected) return null
        return s.corners.map((c, i) => (
          <div
            key={`${s.id}-${i}`}
            className="mapping-corner"
            style={{ left: c.x * W, top: c.y * H }}
            onPointerDown={(e) => {
              (e.target as HTMLElement).setPointerCapture(e.pointerId)
              dragRef.current = { shapeId: s.id, cornerIdx: i }
            }}
            title={['Haut-gauche', 'Haut-droite', 'Bas-droite', 'Bas-gauche'][i]}
          />
        ))
      })}
    </div>
  )
}
