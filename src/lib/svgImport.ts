/**
 * Parse an SVG file and extract drawable shapes as polygon point arrays in [0..1] space.
 * Handles <polygon>, <polyline>, <rect>, <circle>, <ellipse>, <path> (flattened).
 *
 * Returns an array of { name, points } where points are normalized to the SVG viewBox.
 */
import type { Vec2 } from '../types/scene'

export interface ImportedShape {
  name: string
  points: Vec2[]
}

const FLATTEN_RESOLUTION = 1.5   // px between samples for path flattening

export async function importSVG(file: File): Promise<ImportedShape[]> {
  const text = await file.text()
  const parser = new DOMParser()
  const doc = parser.parseFromString(text, 'image/svg+xml')
  const svg = doc.querySelector('svg')
  if (!svg) throw new Error('SVG element introuvable')

  // Determine viewBox or width/height for normalization
  const vb = svg.getAttribute('viewBox')?.split(/\s+|,/).map(Number)
  let vx = 0, vy = 0, vw = parseFloat(svg.getAttribute('width') ?? '100'), vh = parseFloat(svg.getAttribute('height') ?? '100')
  if (vb && vb.length === 4) {
    vx = vb[0]; vy = vb[1]; vw = vb[2]; vh = vb[3]
  }
  if (!isFinite(vw) || vw <= 0) vw = 100
  if (!isFinite(vh) || vh <= 0) vh = 100

  // Build a temporary live SVG element so we can call .getTotalLength() / .getPointAtLength()
  const liveSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  liveSvg.setAttribute('viewBox', `${vx} ${vy} ${vw} ${vh}`)
  liveSvg.setAttribute('width', String(vw))
  liveSvg.setAttribute('height', String(vh))
  liveSvg.style.position = 'absolute'
  liveSvg.style.left = '-99999px'
  liveSvg.style.top = '0'
  document.body.appendChild(liveSvg)

  const out: ImportedShape[] = []
  const norm = (x: number, y: number): Vec2 => ({
    x: (x - vx) / vw,
    y: (y - vy) / vh,
  })

  let idx = 0
  try {
    // <polygon points="x,y x,y ...">
    doc.querySelectorAll('polygon, polyline').forEach((el) => {
      const raw = el.getAttribute('points') ?? ''
      const nums = raw.split(/[\s,]+/).map(Number).filter((n) => isFinite(n))
      const pts: Vec2[] = []
      for (let i = 0; i + 1 < nums.length; i += 2) pts.push(norm(nums[i], nums[i + 1]))
      if (pts.length >= 3) out.push({ name: el.getAttribute('id') || `Shape ${++idx}`, points: pts })
    })
    // <rect>
    doc.querySelectorAll('rect').forEach((el) => {
      const x = parseFloat(el.getAttribute('x') ?? '0')
      const y = parseFloat(el.getAttribute('y') ?? '0')
      const w = parseFloat(el.getAttribute('width') ?? '0')
      const h = parseFloat(el.getAttribute('height') ?? '0')
      if (w > 0 && h > 0) out.push({
        name: el.getAttribute('id') || `Rect ${++idx}`,
        points: [norm(x, y), norm(x + w, y), norm(x + w, y + h), norm(x, y + h)],
      })
    })
    // <circle> / <ellipse> → 32-side polygon
    doc.querySelectorAll('circle, ellipse').forEach((el) => {
      const cx = parseFloat(el.getAttribute('cx') ?? '0')
      const cy = parseFloat(el.getAttribute('cy') ?? '0')
      const rx = parseFloat(el.getAttribute('r') ?? el.getAttribute('rx') ?? '0')
      const ry = parseFloat(el.getAttribute('ry') ?? el.getAttribute('r') ?? '0')
      if (rx > 0 && ry > 0) {
        const N = 32
        const pts: Vec2[] = []
        for (let k = 0; k < N; k++) {
          const a = (k / N) * Math.PI * 2
          pts.push(norm(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry))
        }
        out.push({ name: el.getAttribute('id') || `Circle ${++idx}`, points: pts })
      }
    })
    // <path> — flatten via DOM
    doc.querySelectorAll('path').forEach((srcPath) => {
      const d = srcPath.getAttribute('d')
      if (!d) return
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', d)
      liveSvg.appendChild(path)
      try {
        const len = (path as SVGPathElement).getTotalLength?.() ?? 0
        if (len > 0) {
          const samples = Math.max(8, Math.min(256, Math.round(len / FLATTEN_RESOLUTION)))
          const pts: Vec2[] = []
          for (let k = 0; k < samples; k++) {
            const p = (path as SVGPathElement).getPointAtLength((k / samples) * len)
            pts.push(norm(p.x, p.y))
          }
          // Decimate consecutive duplicates
          const cleaned: Vec2[] = []
          for (const p of pts) {
            const last = cleaned[cleaned.length - 1]
            if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 0.001) cleaned.push(p)
          }
          if (cleaned.length >= 3) out.push({ name: srcPath.getAttribute('id') || `Path ${++idx}`, points: cleaned })
        }
      } catch (e) { console.warn('path flatten failed', e) }
    })
  } finally {
    document.body.removeChild(liveSvg)
  }

  return out
}
