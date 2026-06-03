import { useEffect, useRef, useState } from 'react'
import { useSceneStore } from '../store/sceneStore'
import type { Vec2 } from '../types/scene'

interface DragInfo {
  shapeId: string
  kind: 'corner' | 'point'
  index: number
}

export function MappingOverlay({ stageRef }: { stageRef: React.RefObject<HTMLDivElement> }) {
  const current = useSceneStore((s) => s.scenes.find((x) => x.id === s.currentId))
  const update = useSceneStore((s) => s.updateMapping)
  const updateShape = useSceneStore((s) => s.updateMappingShape)
  const selectShape = useSceneStore((s) => s.selectMappingShape)
  const dragRef = useRef<DragInfo | null>(null)
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
      if (d.shapeId === '__legacy__' && d.kind === 'corner') {
        const corners = [...current.mapping.corners] as typeof current.mapping.corners
        corners[d.index] = { x, y }
        update({ corners })
      } else {
        const shape = current.mapping.shapes?.find((s) => s.id === d.shapeId)
        if (!shape) return
        if (d.kind === 'corner') {
          const corners = [...shape.corners] as typeof shape.corners
          corners[d.index] = { x, y }
          updateShape(d.shapeId, { corners })
        } else if (d.kind === 'point' && shape.points) {
          const pts = [...shape.points]
          pts[d.index] = { x, y }
          updateShape(d.shapeId, { points: pts })
        }
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

  // Polygon edge double-click → insert a new point at click position
  const onEdgeDoubleClick = (shapeId: string, edgeIdx: number, e: React.MouseEvent) => {
    e.stopPropagation()
    const r = stageRef.current!.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width
    const y = (e.clientY - r.top) / r.height
    const sh = current!.mapping.shapes?.find((s) => s.id === shapeId)
    if (!sh?.points) return
    const pts = [...sh.points]
    pts.splice(edgeIdx + 1, 0, { x, y })
    updateShape(shapeId, { points: pts })
  }

  const onPointContextMenu = (shapeId: string, idx: number, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const sh = current!.mapping.shapes?.find((s) => s.id === shapeId)
    if (!sh?.points || sh.points.length <= 3) return
    const pts = sh.points.filter((_, i) => i !== idx)
    updateShape(shapeId, { points: pts })
  }

  type DisplayShape = {
    id: string
    name: string
    enabled: boolean
    kind: 'quad' | 'polygon'
    vertices: Vec2[]
  }

  const shapes: DisplayShape[] = current.mapping.shapes && current.mapping.shapes.length > 0
    ? current.mapping.shapes.map((s) => ({
        id: s.id, name: s.name, enabled: s.enabled,
        kind: s.kind === 'polygon' ? 'polygon' : 'quad',
        vertices: s.kind === 'polygon' && s.points ? s.points : s.corners,
      }))
    : [{ id: '__legacy__', name: 'Zone', enabled: true, kind: 'quad', vertices: current.mapping.corners }]

  const selectedIdx = current.mapping.selectedShape ?? 0

  return (
    <div className="mapping-overlay" style={{ pointerEvents: 'none' }}>
      <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
        {shapes.map((s, idx) => {
          const points = s.vertices.map((c) => `${c.x * W},${c.y * H}`).join(' ')
            + ` ${s.vertices[0].x * W},${s.vertices[0].y * H}`
          const isSelected = idx === selectedIdx
          return (
            <g key={s.id} onClick={() => s.id !== '__legacy__' && selectShape(idx)} style={{ pointerEvents: 'auto', cursor: s.id === '__legacy__' ? 'default' : 'pointer' }}>
              <polyline
                points={points}
                stroke={isSelected ? 'var(--accent)' : 'var(--text-mute)'}
                strokeWidth={isSelected ? 1.5 : 1}
                strokeDasharray={isSelected ? '0' : '4 4'}
                fill={isSelected ? 'rgba(0,255,163,0.04)' : 'none'}
                opacity={s.enabled ? 0.85 : 0.3}
              />
              <text
                x={s.vertices[0].x * W + 12}
                y={s.vertices[0].y * H + 18}
                fill={isSelected ? 'var(--accent)' : 'var(--text-mute)'}
                fontSize="11"
                fontFamily="var(--mono)"
              >
                {s.name} {s.kind === 'polygon' ? `· ${s.vertices.length} pts` : ''}
              </text>
            </g>
          )
        })}
      </svg>

      {shapes.map((s, idx) => {
        const isSelected = idx === selectedIdx
        if (!isSelected) return null
        return s.vertices.map((p, i) => (
          <div
            key={`${s.id}-${i}`}
            className={`mapping-corner ${s.kind === 'polygon' ? 'poly-point' : ''}`}
            style={{ left: p.x * W, top: p.y * H }}
            onPointerDown={(e) => {
              ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
              dragRef.current = {
                shapeId: s.id,
                kind: s.kind === 'polygon' ? 'point' : 'corner',
                index: i,
              }
            }}
            onContextMenu={(e) => s.kind === 'polygon' && onPointContextMenu(s.id, i, e)}
            title={s.kind === 'polygon'
              ? `Sommet ${i + 1} · clic-droit pour supprimer`
              : ['Haut-gauche', 'Haut-droite', 'Bas-droite', 'Bas-gauche'][i]}
          />
        ))
      })}

      {/* Polygon edge "+" markers — double-click to insert a point */}
      {shapes.map((s, idx) => {
        const isSelected = idx === selectedIdx
        if (!isSelected || s.kind !== 'polygon' || s.id === '__legacy__') return null
        return s.vertices.map((p, i) => {
          const next = s.vertices[(i + 1) % s.vertices.length]
          const mx = (p.x + next.x) / 2 * W
          const my = (p.y + next.y) / 2 * H
          return (
            <div
              key={`${s.id}-mid-${i}`}
              className="poly-mid"
              style={{ left: mx, top: my }}
              onClick={(e) => onEdgeDoubleClick(s.id, i, e)}
              title="Cliquer pour insérer un sommet"
            >+</div>
          )
        })
      })}
    </div>
  )
}
