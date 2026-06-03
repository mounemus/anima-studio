import * as THREE from 'three'
import type { TendrilsParams, VisualParams, Obstacle } from '../../types/scene'
import { senseBus } from '../../senses/SenseBus'
import { solveObstacles } from '../Obstacles'
import { getSilhouetteMask } from '../../senses/Silhouette'

const MAX_TENDRILS = 80
const MAX_LEN = 64

interface Tendril {
  head: { x: number; y: number }
  angle: number
  speed: number
  hue: number
  buf: Float32Array  // [x,y, x,y, ...] length = MAX_LEN*2
  age: number
}

/** Tendril organisms — growing curves that flock & twist */
export class TendrilsOrganism {
  mesh: THREE.LineSegments
  private tendrils: Tendril[] = []
  private positions: Float32Array
  private colors: Float32Array
  private params: TendrilsParams
  private aspect = 1
  private c1 = new THREE.Color()
  private c2 = new THREE.Color()
  private mat: THREE.LineBasicMaterial
  obstacles: Obstacle[] | undefined

  constructor(params: TendrilsParams, visual: VisualParams) {
    this.params = params
    const segCount = MAX_TENDRILS * (MAX_LEN - 1) * 2
    this.positions = new Float32Array(segCount * 3)
    this.colors = new Float32Array(segCount * 3)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3))
    this.mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      linewidth: 1,
    })
    this.mesh = new THREE.LineSegments(geo, this.mat)
    this.applyVisual(visual)
    this.reset()
  }

  setAspect(a: number) { this.aspect = a }

  private reset() {
    this.tendrils = []
    for (let i = 0; i < Math.min(this.params.count, MAX_TENDRILS); i++) {
      this.tendrils.push(this.spawn())
    }
  }

  private spawn(): Tendril {
    const buf = new Float32Array(MAX_LEN * 2)
    const x = (Math.random() - 0.5) * 2 * this.aspect
    const y = (Math.random() - 0.5) * 2
    for (let i = 0; i < MAX_LEN; i++) { buf[i * 2] = x; buf[i * 2 + 1] = y }
    return {
      head: { x, y },
      angle: Math.random() * Math.PI * 2,
      speed: 0.3 + Math.random() * 0.5,
      hue: Math.random(),
      buf,
      age: 0,
    }
  }

  updateParams(p: TendrilsParams) {
    const wasCount = this.tendrils.length
    this.params = p
    const target = Math.min(p.count, MAX_TENDRILS)
    while (this.tendrils.length < target) this.tendrils.push(this.spawn())
    while (this.tendrils.length > target) this.tendrils.pop()
    if (target !== wasCount) {
      // clear positions of removed
      const segPerT = (MAX_LEN - 1) * 2 * 3
      for (let i = target; i < MAX_TENDRILS; i++) {
        for (let j = 0; j < segPerT; j++) this.positions[i * segPerT + j] = 0
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
    const visLen = Math.min(MAX_LEN, Math.max(4, p.length))
    const speedScale = p.speed * (0.4 + senseBus.audio.mid * 1.4)
    const twist = p.twist + senseBus.audio.high * 1.5
    const hand = senseBus.hands
    const handX = hand.detected ? (hand.indexTip.x - 0.5) * 2 * aspect : 0
    const handY = hand.detected ? -(hand.indexTip.y - 0.5) * 2 : 0
    const handPull = hand.detected ? (0.5 + senseBus.hands.pinch * 1.5) : 0
    const t = performance.now() * 0.001

    let segIdx = 0
    const tmp = new THREE.Color()
    for (let ti = 0; ti < this.tendrils.length; ti++) {
      const td = this.tendrils[ti]
      td.age += dt
      // angle dynamics
      const noise = Math.sin(td.head.x * 3 + t * 0.6 + ti) + Math.cos(td.head.y * 2.5 - t * 0.4)
      td.angle += noise * twist * dt
      if (handPull > 0) {
        const targetAngle = Math.atan2(handY - td.head.y, handX - td.head.x)
        const diff = ((targetAngle - td.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI
        td.angle += diff * 0.05 * handPull
      }
      // obstacles: nudge angle away from obstacles
      if (this.obstacles && this.obstacles.length) {
        const o = solveObstacles(td.head.x, td.head.y, aspect, this.obstacles, getSilhouetteMask())
        if (Math.abs(o.fx) + Math.abs(o.fy) > 0.01) {
          const wantA = Math.atan2(o.fy, o.fx)
          const diff = ((wantA - td.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI
          td.angle += diff * 0.08
        }
        if (o.kill) { td.head.x = (Math.random() - 0.5) * 2 * aspect; td.head.y = (Math.random() - 0.5) * 2 }
      }
      // move head
      td.head.x += Math.cos(td.angle) * td.speed * speedScale * dt
      td.head.y += Math.sin(td.angle) * td.speed * speedScale * dt
      // wrap
      if (td.head.x > aspect) td.head.x = -aspect
      else if (td.head.x < -aspect) td.head.x = aspect
      if (td.head.y > 1) td.head.y = -1
      else if (td.head.y < -1) td.head.y = 1
      // shift buf
      for (let i = MAX_LEN - 1; i > 0; i--) {
        td.buf[i * 2] = td.buf[(i - 1) * 2]
        td.buf[i * 2 + 1] = td.buf[(i - 1) * 2 + 1]
      }
      td.buf[0] = td.head.x
      td.buf[1] = td.head.y
      // write line segments
      tmp.copy(this.c1).lerp(this.c2, td.hue)
      for (let i = 0; i < MAX_LEN - 1; i++) {
        const i3 = segIdx * 6
        const ic = segIdx * 6
        if (i < visLen - 1) {
          this.positions[i3] = td.buf[i * 2]
          this.positions[i3 + 1] = td.buf[i * 2 + 1]
          this.positions[i3 + 2] = 0
          this.positions[i3 + 3] = td.buf[(i + 1) * 2]
          this.positions[i3 + 4] = td.buf[(i + 1) * 2 + 1]
          this.positions[i3 + 5] = 0
          const a = 1 - i / visLen
          this.colors[ic] = tmp.r * a
          this.colors[ic + 1] = tmp.g * a
          this.colors[ic + 2] = tmp.b * a
          this.colors[ic + 3] = tmp.r * a
          this.colors[ic + 4] = tmp.g * a
          this.colors[ic + 5] = tmp.b * a
        } else {
          // collapse to zero
          this.positions[i3] = 0; this.positions[i3 + 1] = 0; this.positions[i3 + 2] = 0
          this.positions[i3 + 3] = 0; this.positions[i3 + 4] = 0; this.positions[i3 + 5] = 0
          this.colors[ic] = 0; this.colors[ic + 1] = 0; this.colors[ic + 2] = 0
          this.colors[ic + 3] = 0; this.colors[ic + 4] = 0; this.colors[ic + 5] = 0
        }
        segIdx++
      }
    }
    // zero out unused tendril slots
    const segPerT = (MAX_LEN - 1) * 2 * 3
    for (let ti = this.tendrils.length; ti < MAX_TENDRILS; ti++) {
      const base = ti * segPerT
      for (let j = 0; j < segPerT; j++) { this.positions[base + j] = 0; this.colors[base + j] = 0 }
    }
    this.mesh.geometry.attributes.position.needsUpdate = true
    this.mesh.geometry.attributes.color.needsUpdate = true
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.mat.dispose()
  }
}
