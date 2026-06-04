/**
 * HilbertCurve — courbe de Hilbert récursive animée.
 *
 * La courbe de Hilbert est une « space-filling curve » fractale : elle remplit
 * un carré 2D sans jamais se croiser, à n'importe quel ordre N (4ⁿ points).
 *
 * On la trace comme une polyligne animée :
 *   - draw progressif : seuls les `progress` premiers segments sont visibles
 *   - colorisation le long de la courbe (gradient palette)
 *   - distortion possible par la main (pull toward index finger)
 *   - audio bass pulse le scale
 *   - rotation lente continue
 *
 * Ordre praticable : 1..7 (= 4 à 16 384 points). À l'ordre 8 = 65 536 points,
 * c'est trop dense pour un slider live ; clamp à 7.
 *
 * Implémenté avec deux objets :
 *  - Line (polyligne complète)
 *  - Points (sommets pour effet "perles enfilées")
 */
import * as THREE from 'three'
import type { VisualParams } from '../../types/scene'
import { senseBus } from '../../senses/SenseBus'

export interface HilbertCurveParams {
  order: number          // 1..7 (clamped)
  scale: number          // 0.3..1.5
  progress: number       // 0..1 — fraction de la courbe affichée
  autoProgress: number   // 0..2 — vitesse d'avancement automatique (boucle si > 0)
  rotation: number       // -2..2 rad/sec
  thickness: number      // 0.001..0.02 (taille des points)
  handPull: number       // 0..1 — intensité de l'attraction vers la main
  showPoints: number     // 0 ou 1 — afficher les sommets
  hueAlongCurve: number  // 0..1 — décalage de teinte le long de la courbe
}

const MAX_ORDER = 7
const MAX_VERTS = Math.pow(4, MAX_ORDER)   // 16384

/**
 * Calcule la position (x, y) sur la courbe de Hilbert d'ordre N pour l'index d ∈ [0, 4^N).
 * Algorithme classique de Wikipedia (https://en.wikipedia.org/wiki/Hilbert_curve).
 */
function d2xy(n: number, d: number): [number, number] {
  let rx = 0, ry = 0, t = d
  let x = 0, y = 0
  let s = 1
  while (s < n) {
    rx = 1 & (t / 2)
    ry = 1 & (t ^ rx)
    // rotate
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x
        y = s - 1 - y
      }
      const tmp = x; x = y; y = tmp
    }
    x += s * rx
    y += s * ry
    t = Math.floor(t / 4)
    s *= 2
  }
  return [x, y]
}

export class HilbertCurveOrganism {
  mesh: THREE.Group
  positions: Float32Array   // exposed for modifiers (NDC)
  velocities: Float32Array | null = null
  count: number = 0
  obstacles: any
  private params: HilbertCurveParams
  private line: THREE.Line
  private points: THREE.Points
  private lineMat: THREE.LineBasicMaterial
  private pointMat: THREE.PointsMaterial
  private rotation = 0
  private t = 0
  private c1 = new THREE.Color()
  private c2 = new THREE.Color()
  private c3 = new THREE.Color()
  private tmp = new THREE.Color()
  /** Pre-computed normalized (x, y) for each vertex at the current order. */
  private basePts: Float32Array = new Float32Array(MAX_VERTS * 2)
  private baseOrder = 0

  constructor(params: HilbertCurveParams, visual: VisualParams) {
    this.params = params
    // Geometry uses shared buffer for points + line (drawRange driven by progress)
    this.positions = new Float32Array(MAX_VERTS * 3)
    const colors = new Float32Array(MAX_VERTS * 3)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    this.lineMat = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false,
    })
    this.line = new THREE.Line(geo, this.lineMat)
    this.pointMat = new THREE.PointsMaterial({
      size: params.thickness * 200, vertexColors: true, transparent: true,
      opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false,
      sizeAttenuation: true,
    })
    this.points = new THREE.Points(geo, this.pointMat)
    this.mesh = new THREE.Group()
    this.mesh.add(this.line)
    this.mesh.add(this.points)
    this.rebuildBaseCurve(params.order)
    this.applyVisual(visual)
  }

  private rebuildBaseCurve(order: number) {
    const ord = Math.max(1, Math.min(MAX_ORDER, Math.round(order)))
    if (ord === this.baseOrder) return
    this.baseOrder = ord
    const side = Math.pow(2, ord)   // 2^order cells per side
    const total = side * side
    // Convert each Hilbert index → normalized [-1, 1]
    for (let d = 0; d < total; d++) {
      const [x, y] = d2xy(side, d)
      // Center on origin, scale so the whole curve fits in [-1, 1]
      this.basePts[d * 2]     = (x / (side - 1)) * 2 - 1
      this.basePts[d * 2 + 1] = (y / (side - 1)) * 2 - 1
    }
    this.count = total
  }

  setAspect(_a: number) {}

  updateParams(p: HilbertCurveParams) {
    this.params = p
    this.pointMat.size = p.thickness * 200
    this.points.visible = (p.showPoints ?? 1) > 0.5
    if (Math.round(p.order) !== this.baseOrder) {
      this.rebuildBaseCurve(p.order)
    }
  }

  applyVisual(visual: VisualParams) {
    this.c1.set(visual.palette.primary)
    this.c2.set(visual.palette.secondary)
    this.c3.set(visual.palette.glow)
    const blend = visual.blendMode === 'normal' ? THREE.NormalBlending : THREE.AdditiveBlending
    this.lineMat.blending = blend
    this.pointMat.blending = blend
  }

  update(dt: number) {
    const p = this.params
    const h = senseBus.hands
    const a = senseBus.audio
    this.t += dt
    this.rotation += dt * p.rotation
    // Auto-progress (loop sweep)
    let prog = p.progress
    if (p.autoProgress > 0) {
      prog = ((this.t * p.autoProgress) % 1.5) - 0.25   // sweep through 0..1 with slight overshoot
      prog = Math.max(0, Math.min(1, prog))
    }
    // Audio bass pump scale
    const scale = p.scale * (1 + (a.bass ?? 0) * 0.2)
    const cosR = Math.cos(this.rotation), sinR = Math.sin(this.rotation)
    // Hand pull (push curve toward index)
    const handX = h.detected ? (h.indexTip.x - 0.5) * 2 : 0
    const handY = h.detected ? -(h.indexTip.y - 0.5) * 2 : 0
    const pull = h.detected ? p.handPull : 0

    const N = this.count
    const visibleCount = Math.max(2, Math.round(N * prog))
    const positions = this.positions
    const colors = this.points.geometry.attributes.color.array as Float32Array
    const tmp = this.tmp

    for (let i = 0; i < visibleCount; i++) {
      let x = this.basePts[i * 2]
      let y = this.basePts[i * 2 + 1]
      // Apply scale + rotation
      const sx = x * scale, sy = y * scale
      let rx = sx * cosR - sy * sinR
      let ry = sx * sinR + sy * cosR
      // Hand pull: lerp each vertex slightly toward the hand position, falling off with distance
      if (pull > 0) {
        const dx = handX - rx, dy = handY - ry
        const d = Math.sqrt(dx * dx + dy * dy)
        const fall = 1 / (1 + d * 3)
        rx += dx * fall * pull * 0.4
        ry += dy * fall * pull * 0.4
      }
      positions[i * 3]     = rx
      positions[i * 3 + 1] = ry
      positions[i * 3 + 2] = 0
      // Color along curve : 0..1 along the Hilbert index, with optional hue shift
      const t01 = i / Math.max(1, N - 1)
      const hueShifted = (t01 + p.hueAlongCurve * this.t * 0.1) % 1
      if (hueShifted < 0.5) tmp.copy(this.c1).lerp(this.c2, hueShifted * 2)
      else tmp.copy(this.c2).lerp(this.c3, (hueShifted - 0.5) * 2)
      colors[i * 3]     = tmp.r
      colors[i * 3 + 1] = tmp.g
      colors[i * 3 + 2] = tmp.b
    }
    this.line.geometry.setDrawRange(0, visibleCount)
    this.points.geometry.setDrawRange(0, visibleCount)
    ;(this.line.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
    ;(this.line.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true
  }

  dispose() {
    this.line.geometry.dispose()
    this.lineMat.dispose()
    this.pointMat.dispose()
  }
}
