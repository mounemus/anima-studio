import * as THREE from 'three'
import type { ParticleParams, VisualParams, Obstacle } from '../../types/scene'
import { senseBus } from '../../senses/SenseBus'
import { solveObstacles } from '../Obstacles'
import { getSilhouetteMask } from '../../senses/Silhouette'
import { sampleFlow } from '../Flow'

const MAX = 8000

/** Generative particle cloud — emits, drifts, dies, modulated by light + audio + hand */
export class ParticlesOrganism {
  mesh: THREE.Points
  private positions: Float32Array
  private velocities: Float32Array
  private life: Float32Array
  private aspect = 1
  private count: number
  private params: ParticleParams
  private mat: THREE.PointsMaterial
  obstacles: Obstacle[] | undefined

  constructor(params: ParticleParams, visual: VisualParams) {
    this.params = params
    this.count = Math.min(params.count, MAX)
    const geo = new THREE.BufferGeometry()
    this.positions = new Float32Array(MAX * 3)
    // Stride 2 (vx,vy) — matches what applyModifiers() in Modifiers.ts expects;
    // before this fix the modifier hook wrote to velocities[i*2] thinking stride 2
    // while Particles stored at i*3, corrupting all particle indices past zero.
    this.velocities = new Float32Array(MAX * 2)
    this.life = new Float32Array(MAX)
    const colors = new Float32Array(MAX * 3)
    for (let i = 0; i < MAX; i++) this.respawn(i)
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geo.setDrawRange(0, this.count)
    this.mat = new THREE.PointsMaterial({
      size: params.size * 0.08,         // ⬆ doubled
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    })
    this.mesh = new THREE.Points(geo, this.mat)
    this.applyVisual(visual)
  }

  setAspect(a: number) { this.aspect = a }

  updateParams(p: ParticleParams) {
    const prevBoundary = this.params?.boundary ?? 'respawn'
    const nextBoundary = p.boundary ?? 'respawn'
    this.params = p
    this.count = Math.min(p.count, MAX)
    this.mesh.geometry.setDrawRange(0, this.count)
    this.mat.size = p.size * (0.04 + senseBus.audio.bass * 0.06)
    // Switching INTO wrap mode mid-session: redistribute particles uniformly
    // across the canvas so the user sees the rain/snow effect take hold right
    // away instead of waiting for the spawn disc to disperse.
    if (prevBoundary !== 'wrap' && nextBoundary === 'wrap') {
      for (let i = 0; i < this.count; i++) this.respawn(i)
      this.mesh.geometry.attributes.position.needsUpdate = true
    }
  }

  applyVisual(visual: VisualParams) {
    const colors = this.mesh.geometry.attributes.color.array as Float32Array
    const c1 = new THREE.Color(visual.palette.primary)
    const c2 = new THREE.Color(visual.palette.glow)
    const tmp = new THREE.Color()
    for (let i = 0; i < MAX; i++) {
      const t = (Math.sin(i * 0.013) + 1) * 0.5
      tmp.copy(c1).lerp(c2, t)
      colors[i * 3] = tmp.r
      colors[i * 3 + 1] = tmp.g
      colors[i * 3 + 2] = tmp.b
    }
    this.mesh.geometry.attributes.color.needsUpdate = true
    this.mat.blending = visual.blendMode === 'normal' ? THREE.NormalBlending : THREE.AdditiveBlending
  }

  setTexture(tex: THREE.Texture | null) {
    this.mat.map = tex
    this.mat.needsUpdate = true
  }

  private respawn(i: number) {
    // In wrap mode, spread the initial spawn uniformly across the whole canvas
    // so rain/snow looks like it's been falling forever from frame 1, instead
    // of starting as a tight clump at center.
    if ((this.params?.boundary ?? 'respawn') === 'wrap') {
      this.positions[i * 3] = (Math.random() - 0.5) * 2 * this.aspect * 1.4
      this.positions[i * 3 + 1] = (Math.random() - 0.5) * 2 * 1.4
    } else {
      const a = Math.random() * Math.PI * 2
      const r = Math.random() * (this.params?.spread ?? 0.5)
      this.positions[i * 3] = Math.cos(a) * r * this.aspect
      this.positions[i * 3 + 1] = Math.sin(a) * r
    }
    this.positions[i * 3 + 2] = 0
    const v = (this.params?.speed ?? 0.5) * 0.3
    this.velocities[i * 2] = (Math.random() - 0.5) * v
    this.velocities[i * 2 + 1] = (Math.random() - 0.5) * v
    this.life[i] = Math.random() * 3 + 1
  }

  update(dt: number) {
    const p = this.params
    const positions = this.positions
    const vel = this.velocities
    const life = this.life
    const hand = senseBus.hands
    const handX = hand.detected ? (hand.indexTip.x - 0.5) * 2 * this.aspect : 0
    const handY = hand.detected ? -(hand.indexTip.y - 0.5) * 2 : 0
    const handPull = hand.detected ? (0.5 + senseBus.hands.pinch * 2.0) : 0
    const turbScale = p.turbulence * 0.4
    const aBoost = 1 + senseBus.audio.mid * 1.5
    const t = performance.now() * 0.001

    for (let i = 0; i < this.count; i++) {
      let x = positions[i * 3]
      let y = positions[i * 3 + 1]
      let vx = vel[i * 2]
      let vy = vel[i * 2 + 1]

      // turbulence via cheap noise
      const nx = Math.sin(x * 3 + t * 0.7) + Math.cos(y * 2.3 - t * 0.5)
      const ny = Math.cos(x * 2.1 - t * 0.6) + Math.sin(y * 3.1 + t * 0.4)
      vx += nx * turbScale * dt
      vy += ny * turbScale * dt
      // gravity
      vy -= p.gravity * dt * 0.5
      // hand pull
      if (handPull > 0) {
        const dx = handX - x, dy = handY - y
        const d = Math.max(0.05, Math.hypot(dx, dy))
        vx += (dx / d) * handPull * dt
        vy += (dy / d) * handPull * dt
      }
      // flow field
      const flow = sampleFlow(x, y, t)
      vx += flow.fx * dt
      vy += flow.fy * dt
      // obstacles
      if (this.obstacles && this.obstacles.length) {
        const o = solveObstacles(x, y, this.aspect, this.obstacles, getSilhouetteMask())
        vx += o.fx * dt
        vy += o.fy * dt
        if (o.kill) { this.respawn(i); continue }
      }
      // damp
      vx *= 0.985; vy *= 0.985
      // move
      x += vx * p.speed * aBoost * dt
      y += vy * p.speed * aBoost * dt
      // Boundary handling — three modes :
      //  'wrap'    → teleport to the opposite side; perfect for endless rain/snow
      //              (life timer is disabled so falling particles never vanish mid-air)
      //  'kill'    → let them drift off forever; population depletes over time
      //  'respawn' → original behavior : age-out + edge-out → recycle from spawn disc
      const mode = p.boundary ?? 'respawn'
      const xMax = this.aspect * 1.5
      const yMax = 1.5
      if (mode === 'wrap') {
        // Toroidal wrap — span is 2 * limit on each axis
        const xSpan = xMax * 2
        const ySpan = yMax * 2
        if (x >  xMax) x -= xSpan
        if (x < -xMax) x += xSpan
        if (y >  yMax) y -= ySpan
        if (y < -yMax) y += ySpan
        positions[i * 3] = x
        positions[i * 3 + 1] = y
        vel[i * 2] = vx
        vel[i * 2 + 1] = vy
      } else if (mode === 'kill') {
        life[i] -= dt
        if (life[i] <= 0 || Math.abs(x) > xMax || Math.abs(y) > yMax) {
          // park off-screen, freeze — no respawn
          positions[i * 3] = xMax * 2
          positions[i * 3 + 1] = yMax * 2
        } else {
          positions[i * 3] = x
          positions[i * 3 + 1] = y
          vel[i * 2] = vx
          vel[i * 2 + 1] = vy
        }
      } else {
        // 'respawn' (default — unchanged)
        life[i] -= dt
        if (life[i] <= 0 || Math.abs(x) > xMax || Math.abs(y) > yMax) {
          this.respawn(i)
        } else {
          positions[i * 3] = x
          positions[i * 3 + 1] = y
          vel[i * 2] = vx
          vel[i * 2 + 1] = vy
        }
      }
    }
    this.mesh.geometry.attributes.position.needsUpdate = true
    this.mat.size = p.size * (0.04 + senseBus.audio.bass * 0.06)
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.mat.dispose()
  }
}
