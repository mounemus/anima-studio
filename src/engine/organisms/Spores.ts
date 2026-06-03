import * as THREE from 'three'
import type { SporesParams, VisualParams, Obstacle } from '../../types/scene'
import { senseBus } from '../../senses/SenseBus'
import { solveObstacles } from '../Obstacles'
import { getSilhouetteMask } from '../../senses/Silhouette'
import { sampleFlow } from '../Flow'

const MAX = 2500

/**
 * Spores — drifting particles that BLOOM when touching obstacles
 * (size temporarily expanded, optional small chain reaction).
 */
export class SporesOrganism {
  mesh: THREE.Points
  private positions: Float32Array
  private velocities: Float32Array
  private bloom: Float32Array      // 0..1 bloom intensity
  private sizes: Float32Array      // per-instance size attribute (carried in custom attr)
  private params: SporesParams
  private aspect = 1
  private count: number
  private mat: THREE.ShaderMaterial
  obstacles: Obstacle[] | undefined

  constructor(params: SporesParams, visual: VisualParams) {
    this.params = params
    this.count = Math.min(params.count, MAX)
    const geo = new THREE.BufferGeometry()
    this.positions = new Float32Array(MAX * 3)
    this.velocities = new Float32Array(MAX * 2)
    this.bloom = new Float32Array(MAX)
    this.sizes = new Float32Array(MAX)
    const colors = new Float32Array(MAX * 3)
    const c1 = new THREE.Color(visual.palette.primary)
    const c2 = new THREE.Color(visual.palette.glow)
    const tmp = new THREE.Color()
    for (let i = 0; i < MAX; i++) {
      this.positions[i * 3] = (Math.random() - 0.5) * 2
      this.positions[i * 3 + 1] = (Math.random() - 0.5) * 2
      this.velocities[i * 2] = (Math.random() - 0.5) * 0.2
      this.velocities[i * 2 + 1] = (Math.random() - 0.5) * 0.2
      this.bloom[i] = 0
      this.sizes[i] = params.size
      const t = Math.random()
      tmp.copy(c1).lerp(c2, t)
      colors[i * 3] = tmp.r; colors[i * 3 + 1] = tmp.g; colors[i * 3 + 2] = tmp.b
    }
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geo.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1))
    geo.setDrawRange(0, this.count)
    // Use a custom ShaderMaterial so we can carry per-vertex size.
    // ShaderMaterial does NOT auto-declare `attribute vec3 color` even with vertexColors:true,
    // so we declare it explicitly. Same goes for `size`.
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: visual.blendMode === 'normal' ? THREE.NormalBlending : THREE.AdditiveBlending,
      uniforms: { uPx: { value: window.devicePixelRatio || 1 } },
      vertexShader: `
        attribute float size;
        attribute vec3 color;
        varying vec3 vColor;
        uniform float uPx;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          // For an orthographic camera, gl_PointSize is directly pixels.
          // size is in world units (~0.01–0.06), bump to pixels via the canvas height in clip.
          gl_PointSize = max(2.0, size * 600.0 * uPx);
        }
      `,
      fragmentShader: `
        precision highp float;
        varying vec3 vColor;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          if (d > 0.5) discard;
          float alpha = smoothstep(0.5, 0.0, d);
          gl_FragColor = vec4(vColor, alpha * 0.9);
        }
      `,
    })
    this.mesh = new THREE.Points(geo, this.mat)
  }

  setAspect(a: number) { this.aspect = a }

  updateParams(p: SporesParams) {
    this.params = p
    this.count = Math.min(p.count, MAX)
    this.mesh.geometry.setDrawRange(0, this.count)
  }

  applyVisual(visual: VisualParams) {
    const colors = this.mesh.geometry.attributes.color.array as Float32Array
    const c1 = new THREE.Color(visual.palette.primary)
    const c2 = new THREE.Color(visual.palette.glow)
    const tmp = new THREE.Color()
    for (let i = 0; i < MAX; i++) {
      const t = (Math.sin(i * 0.017) + 1) * 0.5
      tmp.copy(c1).lerp(c2, t)
      colors[i * 3] = tmp.r; colors[i * 3 + 1] = tmp.g; colors[i * 3 + 2] = tmp.b
    }
    this.mesh.geometry.attributes.color.needsUpdate = true
    this.mat.blending = visual.blendMode === 'normal' ? THREE.NormalBlending : THREE.AdditiveBlending
  }

  setTexture(_tex: THREE.Texture | null) { /* shader-based, ignore */ }

  update(dt: number) {
    const p = this.params
    const aspect = this.aspect
    const speed = p.speed * (0.5 + senseBus.audio.mid * 1.5)
    const hand = senseBus.hands
    const handX = hand.detected ? (hand.indexTip.x - 0.5) * 2 * aspect : 0
    const handY = hand.detected ? -(hand.indexTip.y - 0.5) * 2 : 0
    const handPull = hand.detected ? (0.4 + senseBus.hands.pinch * 1.2) : 0
    const baseSize = p.size

    for (let i = 0; i < this.count; i++) {
      let x = this.positions[i * 3]
      let y = this.positions[i * 3 + 1]
      let vx = this.velocities[i * 2]
      let vy = this.velocities[i * 2 + 1]

      // Drift Brownian
      vx += (Math.random() - 0.5) * 0.15 * dt
      vy += (Math.random() - 0.5) * 0.15 * dt
      vx *= 0.97; vy *= 0.97

      // Hand pull
      if (handPull > 0) {
        const dx = handX - x, dy = handY - y
        const d = Math.max(0.05, Math.hypot(dx, dy))
        vx += (dx / d) * handPull * dt * 0.5
        vy += (dy / d) * handPull * dt * 0.5
      }
      // Flow field
      const flow = sampleFlow(x, y, performance.now() * 0.001)
      vx += flow.fx * dt
      vy += flow.fy * dt

      // Obstacles → bloom
      if (this.obstacles && this.obstacles.length && p.reactToObstacles) {
        const o = solveObstacles(x, y, aspect, this.obstacles, getSilhouetteMask())
        vx += o.fx * dt * 0.5
        vy += o.fy * dt * 0.5
        if (o.hit) {
          // Rising-edge bloom: only trigger if not currently blooming
          if (this.bloom[i] < 0.2) this.bloom[i] = Math.min(1, this.bloom[i] + p.bloomGain)
        }
        if (o.kill) {
          x = (Math.random() - 0.5) * 2 * aspect
          y = (Math.random() - 0.5) * 2
          this.bloom[i] = 0
        }
      }

      x += vx * speed * dt
      y += vy * speed * dt
      // wrap
      if (x > aspect) x = -aspect; else if (x < -aspect) x = aspect
      if (y > 1) y = -1; else if (y < -1) y = 1

      // Bloom decay
      this.bloom[i] = Math.max(0, this.bloom[i] - p.bloomDecay * dt)
      this.sizes[i] = baseSize * (1 + this.bloom[i] * 4)

      this.positions[i * 3] = x
      this.positions[i * 3 + 1] = y
      this.velocities[i * 2] = vx
      this.velocities[i * 2 + 1] = vy
    }
    this.mesh.geometry.attributes.position.needsUpdate = true
    this.mesh.geometry.attributes.size.needsUpdate = true
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.mat.dispose()
  }
}
