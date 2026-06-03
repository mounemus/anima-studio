import { useEffect, useRef, useState } from 'react'
import { useSceneStore } from '../store/sceneStore'
import type { Obstacle } from '../types/scene'

interface DragInfo {
  obstacleId: string
  kind: 'circle-center' | 'circle-radius' | 'poly-vertex'
  vertexIdx?: number
}

export function ObstaclesOverlay({ stageRef, editing, selectedId, onSelect }: {
  stageRef: React.RefObject<HTMLDivElement>
  editing: boolean
  selectedId: string | null
  onSelect: (id: string | null) => void
}) {
  const current = useSceneStore((s) => s.scenes.find((x) => x.id === s.currentId))
  const updateObs = useSceneStore((s) => s.updateObstacle)
  const dragRef = useRef<DragInfo | null>(null)
  const [, force] = useState(0)

  useEffect(() => {
    const ro = new ResizeObserver(() => force((x) => x + 1))
    if (stageRef.current) ro.observe(stageRef.current)
    return () => ro.disconnect()
  }, [stageRef])

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragRef.current || !stageRef.current || !current) return
      const r = stageRef.current.getBoundingClientRect()
      const nx = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
      const ny = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))
      const o = current.obstacles?.find((x) => x.id === dragRef.current!.obstacleId)
      if (!o) return
      if (dragRef.current.kind === 'circle-center' && o.circle) {
        updateObs(o.id, { circle: { ...o.circle, cx: nx, cy: ny } })
      } else if (dragRef.current.kind === 'circle-radius' && o.circle) {
        const dx = (nx - o.circle.cx)
        const dy = (ny - o.circle.cy) * (r.height / r.width)
        const newR = Math.max(0.02, Math.min(1, Math.hypot(dx, dy)))
        updateObs(o.id, { circle: { ...o.circle, r: newR } })
      } else if (dragRef.current.kind === 'poly-vertex' && o.polygon && dragRef.current.vertexIdx !== undefined) {
        const pts = [...o.polygon.points]
        pts[dragRef.current.vertexIdx] = { x: nx, y: ny }
        updateObs(o.id, { polygon: { points: pts } })
      }
    }
    const onUp = () => { dragRef.current = null }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [current, stageRef, updateObs])

  if (!current?.obstacles?.length || !stageRef.current) return null
  const r = stageRef.current.getBoundingClientRect()
  const W = r.width, H = r.height

  const obstacleColor = (o: Obstacle) => {
    switch (o.interaction) {
      case 'avoid': return 'rgba(0,212,255,0.9)'      // cyan
      case 'attract': return 'rgba(255,107,166,0.9)'  // pink
      case 'bounce': return 'rgba(255,181,71,0.9)'    // amber
      case 'kill': return 'rgba(255,90,122,0.9)'      // red
    }
  }

  return (
    <div className="obstacles-overlay" style={{ position: 'absolute', inset: 0, pointerEvents: editing ? 'auto' : 'none' }}>
      <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
        {current.obstacles.map((o) => {
          if (!o.visible) return null
          const isSel = o.id === selectedId
          const stroke = obstacleColor(o)
          const sw = isSel ? 2 : 1.2
          if (o.kind === 'circle' && o.circle) {
            const cx = o.circle.cx * W
            const cy = o.circle.cy * H
            const rPx = o.circle.r * Math.max(W, H)
            return (
              <g key={o.id} onClick={() => editing && onSelect(o.id)} style={{ pointerEvents: editing ? 'auto' : 'none', cursor: editing ? 'pointer' : 'default' }}>
                <circle cx={cx} cy={cy} r={rPx} fill={stroke.replace('0.9', '0.10')} stroke={stroke} strokeWidth={sw} strokeDasharray={o.enabled ? '0' : '5 5'} />
                <text x={cx + rPx + 6} y={cy + 4} fill={stroke} fontSize="11" fontFamily="var(--mono)">{o.name}</text>
              </g>
            )
          } else if (o.kind === 'polygon' && o.polygon) {
            const pts = o.polygon.points.map((p) => `${p.x * W},${p.y * H}`).join(' ')
            const first = o.polygon.points[0]
            return (
              <g key={o.id} onClick={() => editing && onSelect(o.id)} style={{ pointerEvents: editing ? 'auto' : 'none', cursor: editing ? 'pointer' : 'default' }}>
                <polygon points={pts} fill={stroke.replace('0.9', '0.10')} stroke={stroke} strokeWidth={sw} strokeDasharray={o.enabled ? '0' : '5 5'} />
                <text x={first.x * W + 6} y={first.y * H - 6} fill={stroke} fontSize="11" fontFamily="var(--mono)">{o.name}</text>
              </g>
            )
          } else if (o.kind === 'hand' && o.hand) {
            // visual hint at hand position will come from sense bus — simplified static badge
            return (
              <g key={o.id}>
                <text x={W - 110} y={36} fill={stroke} fontSize="11" fontFamily="var(--mono)" textAnchor="end">
                  ✋ {o.name} ({o.interaction})
                </text>
              </g>
            )
          } else if (o.kind === 'silhouette') {
            return (
              <g key={o.id}>
                <text x={W - 110} y={20} fill={stroke} fontSize="11" fontFamily="var(--mono)" textAnchor="end">
                  👤 {o.name} ({o.interaction})
                </text>
              </g>
            )
          }
          return null
        })}
      </svg>

      {editing && current.obstacles.map((o) => {
        if (o.id !== selectedId) return null
        if (o.kind === 'circle' && o.circle) {
          const cx = o.circle.cx * W
          const cy = o.circle.cy * H
          const rPx = o.circle.r * Math.max(W, H)
          return (
            <div key={o.id}>
              <div
                className="obstacle-handle"
                style={{ left: cx, top: cy }}
                onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); dragRef.current = { obstacleId: o.id, kind: 'circle-center' } }}
                title="Centre — glisse pour déplacer"
              />
              <div
                className="obstacle-handle radius"
                style={{ left: cx + rPx, top: cy }}
                onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); dragRef.current = { obstacleId: o.id, kind: 'circle-radius' } }}
                title="Rayon"
              />
            </div>
          )
        } else if (o.kind === 'polygon' && o.polygon) {
          return o.polygon.points.map((p, i) => (
            <div
              key={`${o.id}-${i}`}
              className="obstacle-handle"
              style={{ left: p.x * W, top: p.y * H }}
              onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); dragRef.current = { obstacleId: o.id, kind: 'poly-vertex', vertexIdx: i } }}
              title={`Sommet ${i + 1}`}
            />
          ))
        }
        return null
      })}
    </div>
  )
}
