import * as THREE from 'three'
import type { WormsParams, VisualParams, Obstacle } from '../../types/scene'
import { senseBus } from '../../senses/SenseBus'
import { solveObstacles } from '../Obstacles'
import { getSilhouetteMask } from '../../senses/Silhouette'

const MAX_WORMS = 40
const MAX_SEG = 48

interface Worm {
  /** flat segment positions x,y, length = MAX_SEG*2 */
  pos: Float32Array
  /** previous positions for Verlet */
  prev: Float32Array
  /** head heading angle */
  angle: number
  speed: number
  hue: number
}

/** Worms — rope-physics chains that snake through space and react to obstacles. */
export class WormsOrganism {
  mesh: THREE.LineSegments
  private worms: Worm[] = []
  private positions: Float32Array
  private colors: Float32Array
  private mat: THREE.LineBasicMaterial
  private params: WormsParams
  private aspect = 1
  private c1 = new THREE.Color()
  private c2 = new THREE.Color()
  obstacles: Obstacle[] | undefined

  constructor(params: WormsParams, visual: VisualParams) {
    this.params = params
    const segPairs = MAX_WORMS * (MAX_SEG - 1) * 2
    this.positions = new Float32Array(segPairs * 3)
    this.colors = new Float32Array(segPairs * 3)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3))
    this.mat = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending,
    })
    this.mesh = new THREE.LineSegments(geo, this.mat)
    this.applyVisual(visual)
    this.reset()
  }

  setAspect(a: number) { this.aspect = a }

  private spawn(): Worm {
    const pos = new Float32Array(MAX_SEG * 2)
    const prev = new Float32Array(MAX_SEG * 2)
    const x = (Math.random() - 0.5) * 2 * this.aspect
    const y = (Math.random() - 0.5) * 2
    const angle = Math.random() * Math.PI * 2
    const segLen = this.params.segLen
    for (let i = 0; i < MAX_SEG; i++) {
      pos[i * 2] = x - Math.cos(angle) * segLen * i
      pos[i * 2 + 1] = y - Math.sin(angle) * segLen * i
      prev[i * 2] = pos[i * 2]
      prev[i * 2 + 1] = pos[i * 2 + 1]
    }
    return { pos, prev, angle, speed: 0.7 + Math.random() * 0.6, hue: Math.random() }
  }

  private reset() {
    this.worms = []
    const n = Math.min(this.params.count, MAX_WORMS)
    for (let i = 0; i < n; i++) this.worms.push(this.spawn())
  }

  updateParams(p: WormsParams) {
    const wasCount = this.worms.length
    this.params = p
    const target = Math.min(p.count, MAX_WORMS)
    while (this.worms.length < target) this.worms.push(this.spawn())
    while (this.worms.length > target) this.worms.pop()
    if (target !== wasCount) {
      const segPerW = (MAX_SEG - 1) * 2 * 3
      for (let i = target; i < MAX_WORMS; i++) {
        for (let j = 0; j < segPerW; j++) this.positions[i * segPerW + j] = 0
      }
    }
  }

  applyVisual(visual: VisualParams) {
    this.c1.set(visual.palette.primary)
    this.c2.set(visual.palette.glow)
    this.mat.blending = visual.blendMode === 'normal' ? THREE.NormalBlending : THREE.AdditiveBlending
  }

  update(dt: number) {
    const p = this.params
    const aspect = this.aspect
    const visSeg = Math.min(MAX_SEG, Math.max(4, p.segments))
    const segLen = p.segLen
    const speedScale = p.speed * (0.4 + senseBus.audio.mid * 1.4)
    const twist = p.twist + senseBus.audio.high * 1.5
    const hand = senseBus.hands
    const handX = hand.detected ? (hand.indexTip.x - 0.5) * 2 * aspect : 0
    const handY = hand.detected ? -(hand.indexTip.y - 0.5) * 2 : 0
    const handPull = hand.detected ? (0.5 + senseBus.hands.pinch * 1.5) : 0
    const t = performance.now() * 0.001
    const tmp = new THREE.Color()
    let segIdx = 0

    for (let wi = 0; wi < this.worms.length; wi++) {
      const w = this.worms[wi]
      // Head steering — Perlin-like noise + hand + obstacles
      const noise = Math.sin(w.pos[0] * 3 + t * 0.6 + wi) + Math.cos(w.pos[1] * 2.5 - t * 0.4)
      w.angle += noise * twist * dt
      if (handPull > 0) {
        const targetAngle = Math.atan2(handY - w.pos[1], handX - w.pos[0])
        const diff = ((targetAngle - w.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI
        w.angle += diff * 0.04 * handPull
      }
      if (this.obstacles && this.obstacles.length) {
        const o = solveObstacles(w.pos[0], w.pos[1], aspect, this.obstacles, getSilhouetteMask())
        if (Math.abs(o.fx) + Math.abs(o.fy) > 0.01) {
          const wantA = Math.atan2(o.fy, o.fx)
          const diff = ((wantA - w.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI
          w.angle += diff * 0.12
        }
        if (o.kill) {
          // respawn
          const nw = this.spawn()
          this.worms[wi] = nw
          continue
        }
      }
      // Move head with Verlet
      const headX = w.pos[0]
      const headY = w.pos[1]
      const dx = Math.cos(w.angle) * w.speed * speedScale * dt
      const dy = Math.sin(w.angle) * w.speed * speedScale * dt
      w.prev[0] = headX
      w.prev[1] = headY
      w.pos[0] = headX + dx
      w.pos[1] = headY + dy
      // wrap
      if (w.pos[0] > aspect) w.pos[0] = -aspect
      else if (w.pos[0] < -aspect) w.pos[0] = aspect
      if (w.pos[1] > 1) w.pos[1] = -1
      else if (w.pos[1] < -1) w.pos[1] = 1
      // Distance-constraint chain: each segment is pulled toward the previous
      for (let i = 1; i < MAX_SEG; i++) {
        const px = w.pos[(i - 1) * 2]
        const py = w.pos[(i - 1) * 2 + 1]
        const sx = w.pos[i * 2]
        const sy = w.pos[i * 2 + 1]
        const ddx = px - sx
        const ddy = py - sy
        const d = Math.max(1e-4, Math.hypot(ddx, ddy))
        const correction = (d - segLen) / d
        w.pos[i * 2] = sx + ddx * correction * 0.5
        w.pos[i * 2 + 1] = sy + ddy * correction * 0.5
      }
      // Write line segments + colors
      tmp.copy(this.c1).lerp(this.c2, w.hue)
      for (let i = 0; i < MAX_SEG - 1; i++) {
        const i3 = segIdx * 6
        const ic = segIdx * 6
        if (i < visSeg - 1) {
          this.positions[i3] = w.pos[i * 2]
          this.positions[i3 + 1] = w.pos[i * 2 + 1]
          this.positions[i3 + 2] = 0
          this.positions[i3 + 3] = w.pos[(i + 1) * 2]
          this.positions[i3 + 4] = w.pos[(i + 1) * 2 + 1]
          this.positions[i3 + 5] = 0
          const fade = 1 - i / visSeg * 0.7
          this.colors[ic] = tmp.r * fade
          this.colors[ic + 1] = tmp.g * fade
          this.colors[ic + 2] = tmp.b * fade
          this.colors[ic + 3] = tmp.r * fade
          this.colors[ic + 4] = tmp.g * fade
          this.colors[ic + 5] = tmp.b * fade
        } else {
          this.positions[i3] = 0; this.positions[i3 + 1] = 0; this.positions[i3 + 2] = 0
          this.positions[i3 + 3] = 0; this.positions[i3 + 4] = 0; this.positions[i3 + 5] = 0
          this.colors[ic] = 0; this.colors[ic + 1] = 0; this.colors[ic + 2] = 0
          this.colors[ic + 3] = 0; this.colors[ic + 4] = 0; this.colors[ic + 5] = 0
        }
        segIdx++
      }
    }
    // Zero out unused worm slots
    const segPerW = (MAX_SEG - 1) * 2 * 3
    for (let wi = this.worms.length; wi < MAX_WORMS; wi++) {
      const base = wi * segPerW
      for (let j = 0; j < segPerW; j++) { this.positions[base + j] = 0; this.colors[base + j] = 0 }
    }
    this.mesh.geometry.attributes.position.needsUpdate = true
    this.mesh.geometry.attributes.color.needsUpdate = true
  }

  setTexture(_tex: THREE.Texture | null) { /* worms are line strips, ignore texture for now */ }

  dispose() {
    this.mesh.geometry.dispose()
    this.mat.dispose()
  }
}
