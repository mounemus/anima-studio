/** Ready-to-drop polygon templates centered around (0.5, 0.5) at 0.3 radius. */
import type { Vec2 } from '../types/scene'

export interface ShapeTemplate {
  id: string
  name: string
  emoji: string
  points: Vec2[]
}

function ring(n: number, r: number, startAngle = -Math.PI / 2): Vec2[] {
  return Array.from({ length: n }, (_, i) => {
    const a = startAngle + (i / n) * Math.PI * 2
    return { x: 0.5 + Math.cos(a) * r, y: 0.5 + Math.sin(a) * r }
  })
}

function star(spikes: number, rOuter: number, rInner: number): Vec2[] {
  const out: Vec2[] = []
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? rOuter : rInner
    const a = -Math.PI / 2 + (i / (spikes * 2)) * Math.PI * 2
    out.push({ x: 0.5 + Math.cos(a) * r, y: 0.5 + Math.sin(a) * r })
  }
  return out
}

function heart(n = 40, scale = 0.28): Vec2[] {
  const out: Vec2[] = []
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2
    const x = 16 * Math.sin(t) ** 3
    const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))
    out.push({ x: 0.5 + x * scale / 17, y: 0.5 + y * scale / 17 })
  }
  return out
}

function blob(seed = 1, n = 14, baseR = 0.3): Vec2[] {
  // Use a deterministic pseudo-random per seed
  const r = (i: number) => {
    const x = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453
    return x - Math.floor(x)
  }
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2
    const radius = baseR * (0.7 + r(i) * 0.55)
    return { x: 0.5 + Math.cos(a) * radius, y: 0.5 + Math.sin(a) * radius }
  })
}

export const SHAPE_TEMPLATES: ShapeTemplate[] = [
  { id: 'hex', name: 'Hexagone', emoji: '⬡', points: ring(6, 0.3) },
  { id: 'octagon', name: 'Octogone', emoji: '⬣', points: ring(8, 0.3) },
  { id: 'circle', name: 'Cercle (32 pts)', emoji: '⭕', points: ring(32, 0.3) },
  { id: 'triangle', name: 'Triangle', emoji: '▲', points: ring(3, 0.32) },
  { id: 'star5', name: 'Étoile 5', emoji: '★', points: star(5, 0.32, 0.13) },
  { id: 'star8', name: 'Étoile 8', emoji: '✦', points: star(8, 0.3, 0.15) },
  { id: 'heart', name: 'Cœur', emoji: '❤', points: heart() },
  { id: 'blob1', name: 'Blob organique 1', emoji: '🫧', points: blob(1) },
  { id: 'blob2', name: 'Blob organique 2', emoji: '🫧', points: blob(7) },
  { id: 'arrow', name: 'Flèche', emoji: '➜', points: [
    { x: 0.2, y: 0.4 }, { x: 0.55, y: 0.4 }, { x: 0.55, y: 0.25 },
    { x: 0.8, y: 0.5 }, { x: 0.55, y: 0.75 }, { x: 0.55, y: 0.6 }, { x: 0.2, y: 0.6 },
  ] },
  { id: 'lightning', name: 'Éclair', emoji: '⚡', points: [
    { x: 0.55, y: 0.1 }, { x: 0.35, y: 0.45 }, { x: 0.5, y: 0.5 },
    { x: 0.4, y: 0.9 }, { x: 0.65, y: 0.5 }, { x: 0.5, y: 0.45 },
  ] },
]
