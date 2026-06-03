import { useEffect, useRef, useState } from 'react'
import { useSceneStore } from '../store/sceneStore'
import type { Vec2 } from '../types/scene'
import { smoothPolygon, centroid, rotateAround } from '../lib/curve'

interface DragInfo {
  shapeId: string
  kind: 'corner' | 'point' | 'translate' | 'rotate'
  index: number
  /** For translate: starting points + cursor at drag begin */
  startPts?: Vec2[]
  startCorners?: [Vec2, Vec2, Vec2, Vec2]
  startCx?: number
  startCy?: number
  /** For rotate: initial angle from center to cursor */
  startAngle?: number
  startRotation?: number
  center?: Vec2
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
        return
      }
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
      } else if (d.kind === 'translate') {
        const dx = x - (d.startCx ?? 0)
        const dy = y - (d.startCy ?? 0)
        if (shape.kind === 'polygon' && d.startPts) {
          updateShape(d.shapeId, { points: d.startPts.map((p) => ({ x: p.x + dx, y: p.y + dy })) })
        } else if (d.startCorners) {
          updateShape(d.shapeId, {
            corners: d.startCorners.map((p) => ({ x: p.x + dx, y: p.y + dy })) as typeof shape.corners,
          })
        }
      } else if (d.kind === 'rotate' && d.center) {
        const ang = Math.atan2(y - d.center.y, x - d.center.x)
        const newRot = (d.startRotation ?? 0) + (ang - (d.startAngle ?? 0))
        updateShape(d.shapeId, { rotation: newRot })
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

  // For display we apply rotation + smoothing here to mirror what the shader does
  const shapes: DisplayShape[] = current.mapping.shapes && current.mapping.shapes.length > 0
    ? current.mapping.shapes.map((s) => {
        let verts: Vec2[]
        if (s.kind === 'polygon' && s.points) {
          let pts = s.points
          if (s.rotation) pts = rotateAround(pts, centroid(pts), s.rotation)
          if (s.smooth && s.smooth > 0) pts = smoothPolygon(pts, s.smooth)
          verts = pts
        } else {
          verts = s.corners
        }
        return {
          id: s.id, name: s.name, enabled: s.enabled,
          kind: s.kind === 'polygon' ? 'polygon' : 'quad',
          vertices: verts,
        }
      })
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
        // For polygons, the editing handles use the ORIGINAL (non-smoothed) points
        // so users can manipulate the source shape independent of the smoothing.
        const editPoints: Vec2[] = (() => {
          if (s.kind !== 'polygon') return s.vertices
          const realShape = current.mapping.shapes?.find((x) => x.id === s.id)
          return realShape?.points ?? s.vertices
        })()
        // Center handle for translate + rotation handle outside the bbox
        const c = centroid(editPoints)
        let minX = 1, minY = 1, maxX = 0, maxY = 0
        for (const p of editPoints) {
          if (p.x < minX) minX = p.x
          if (p.y < minY) minY = p.y
          if (p.x > maxX) maxX = p.x
          if (p.y > maxY) maxY = p.y
        }
        const rotHandle = { x: (minX + maxX) / 2, y: minY - 0.04 }
        return (
          <div key={`handles-${s.id}`}>
            {/* Translate handle (center) */}
            <div
              className="mapping-center-handle"
              style={{ left: c.x * W, top: c.y * H }}
              onPointerDown={(e) => {
                ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
                const realShape = current.mapping.shapes?.find((x) => x.id === s.id)
                dragRef.current = {
                  shapeId: s.id, kind: 'translate', index: 0,
                  startPts: realShape?.points ? [...realShape.points] : undefined,
                  startCorners: realShape?.corners ? [...realShape.corners] as [Vec2, Vec2, Vec2, Vec2] : undefined,
                  startCx: (e.clientX - rect.left) / rect.width,
                  startCy: (e.clientY - rect.top) / rect.height,
                }
              }}
              title="Glisser pour déplacer la zone"
            >⊕</div>
            {/* Rotation handle (polygon only — quads have inherent perspective) */}
            {s.kind === 'polygon' && (
              <div
                className="mapping-rotate-handle"
                style={{ left: rotHandle.x * W, top: Math.max(8, rotHandle.y * H) }}
                onPointerDown={(e) => {
                  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
                  const realShape = current.mapping.shapes?.find((x) => x.id === s.id)
                  const cx = (e.clientX - rect.left) / rect.width
                  const cy = (e.clientY - rect.top) / rect.height
                  dragRef.current = {
                    shapeId: s.id, kind: 'rotate', index: 0,
                    center: c,
                    startAngle: Math.atan2(cy - c.y, cx - c.x),
                    startRotation: realShape?.rotation ?? 0,
                  }
                }}
                title="Glisser pour pivoter"
              >↻</div>
            )}
            {/* Vertex handles */}
            {editPoints.map((p, i) => (
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
            ))}
          </div>
        )
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
