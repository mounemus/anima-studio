/**
 * ParticleSwarm3D — boids étendu sur 3 axes, rendus en perspective.
 *
 * Simulation flocking (Reynolds 1986) avec cohésion + séparation + alignement,
 * mais en 3D : chaque agent a (x, y, z) + vitesse 3D, contraints dans un cube
 * unité. Caméra perspective + orbit auto + drag souris (mouseInteract).
 *
 * Métamorphose : les params (cohésion/séparation/alignement) sont morphés en
 * live par la main x/y/pinch et par audio bass/mid/high.
 *
 * Rendu : Points dans une Scene+PerspectiveCamera privées, RT, fullscreen
 * quad — même architecture que Menger/SuperShape3D. Couleur par vélocité
 * (gradient palette), taille pulse au bass.
 */
import * as THREE from 'three'
import type { VisualParams } from '../../types/scene'
import { senseBus } from '../../senses/SenseBus'

export interface ParticleSwarm3DParams {
  count: number              // 200..3000
  speed: number              // 0.1..3
  cohesion: number           // 0..2
  separation: number         // 0..2
  alignment: number          // 0..2
  vision: number             // 0.05..0.5 — perception radius (world units)
  bounds: number             // 0.6..1.5 — cube half-size
  pointSize: number          // 0.5..6
  autoOrbitSpeed: number     // 0..3
  fov: number                // 30..90
  trail: number              // 0..1 — opacity (visual hint; engine feedback owns the real trail)
}

const MAX = 3000

const VERT = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
`
const COPY_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTex;
  uniform float uHueShift;
  vec3 hueShift(vec3 col, float h) {
    float U = cos(h * 6.2831853); float W = sin(h * 6.2831853);
    return vec3(
      (.299 + .701 * U + .168 * W) * col.r + (.587 - .587 * U + .330 * W) * col.g + (.114 - .114 * U - .497 * W) * col.b,
      (.299 - .299 * U - .328 * W) * col.r + (.587 + .413 * U + .035 * W) * col.g + (.114 - .114 * U + .292 * W) * col.b,
      (.299 - .300 * U + 1.250 * W) * col.r + (.587 - .588 * U - 1.050 * W) * col.g + (.114 + .886 * U - .203 * W) * col.b
    );
  }
  void main() {
    vec4 c = texture2D(uTex, vUv);
    gl_FragColor = vec4(hueShift(c.rgb, uHueShift), c.a);
  }
`

export class ParticleSwarm3DOrganism {
  mesh: THREE.Mesh
  positions = new Float32Array(0)
  velocities: Float32Array | null = null
  count = 0
  obstacles: any
  renderer: THREE.WebGLRenderer | null = null
  private params: ParticleSwarm3DParams
  private innerScene: THREE.Scene
  private innerCamera: THREE.PerspectiveCamera
  private rt: THREE.WebGLRenderTarget
  private points: THREE.Points
  private pointMat: THREE.PointsMaterial
  private displayMat: THREE.ShaderMaterial
  // Per-agent storage (3D)
  private px = new Float32Array(MAX)
  private py = new Float32Array(MAX)
  private pz = new Float32Array(MAX)
  private vx = new Float32Array(MAX)
  private vy = new Float32Array(MAX)
  private vz = new Float32Array(MAX)
  private orbit = 0
  private c1 = new THREE.Color()
  private c2 = new THREE.Color()
  private c3 = new THREE.Color()
  private tmp = new THREE.Color()
  // Mouse controls
  private mouseYaw = 0
  private mousePitch = 0
  private mouseDistanceBias = 0

  constructor(params: ParticleSwarm3DParams, visual: VisualParams) {
    this.params = params
    this.count = Math.min(MAX, Math.max(50, Math.round(params.count)))
    // Random initial state inside the bounds cube
    const B = params.bounds
    for (let i = 0; i < MAX; i++) {
      this.px[i] = (Math.random() - 0.5) * 2 * B
      this.py[i] = (Math.random() - 0.5) * 2 * B
      this.pz[i] = (Math.random() - 0.5) * 2 * B
      this.vx[i] = (Math.random() - 0.5) * 0.2
      this.vy[i] = (Math.random() - 0.5) * 0.2
      this.vz[i] = (Math.random() - 0.5) * 0.2
    }
    // Three.js Points : single Float32Array of (x, y, z) per vertex
    this.positions = new Float32Array(MAX * 3)
    const colors = new Float32Array(MAX * 3)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geo.setDrawRange(0, this.count)
    this.pointMat = new THREE.PointsMaterial({
      size: params.pointSize * 0.025,
      vertexColors: true, transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false,
      sizeAttenuation: true,
    })
    this.points = new THREE.Points(geo, this.pointMat)
    // Internal 3D scene
    this.innerScene = new THREE.Scene()
    this.innerScene.background = new THREE.Color(visual.palette.bg)
    this.innerScene.add(this.points)
    this.innerCamera = new THREE.PerspectiveCamera(params.fov, 1, 0.01, 100)
    this.innerCamera.position.set(0, 0, 3.5)
    // RT + display
    this.rt = new THREE.WebGLRenderTarget(1024, 1024, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    })
    this.displayMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: COPY_FRAG,
      transparent: true, depthWrite: false,
      uniforms: {
        uTex: { value: this.rt.texture },
        uHueShift: { value: 0 },
      },
    })
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.displayMat)
    this.applyVisual(visual)
  }

  setAspect(a: number) {
    this.innerCamera.aspect = a
    this.innerCamera.updateProjectionMatrix()
  }

  updateParams(p: ParticleSwarm3DParams) {
    this.params = p
    this.count = Math.min(MAX, Math.max(50, Math.round(p.count)))
    this.points.geometry.setDrawRange(0, this.count)
    this.pointMat.size = p.pointSize * 0.025
    this.pointMat.opacity = 0.4 + p.trail * 0.6
    this.innerCamera.fov = p.fov
    this.innerCamera.updateProjectionMatrix()
  }

  applyVisual(visual: VisualParams) {
    if (this.innerScene.background instanceof THREE.Color) this.innerScene.background.set(visual.palette.bg)
    this.c1.set(visual.palette.primary)
    this.c2.set(visual.palette.secondary)
    this.c3.set(visual.palette.glow)
    this.pointMat.blending = visual.blendMode === 'normal' ? THREE.NormalBlending : THREE.AdditiveBlending
  }

  update(dt: number) {
    if (!this.renderer) return
    const p = this.params
    const h = senseBus.hands
    const a = senseBus.audio
    // Audio + hand modulate flock params
    const speed = p.speed * (0.5 + (a.mid ?? 0) * 1.5)
    const cohesion = p.cohesion + (h.detected ? (h.indexTip.x - 0.5) * 1.2 : 0)
    const separation = p.separation + (h.detected ? (h.indexTip.y - 0.5) * 1.2 : 0)
    const alignment = p.alignment * (1 + (a.high ?? 0) * 0.6)
    const vision = p.vision
    const v2 = vision * vision
    const sep2 = (vision * 0.5) ** 2
    const B = p.bounds
    const N = this.count
    // O(N²) — fine for N≤500. Above that becomes slow but still real-time at N=2000 in modern browsers.
    for (let i = 0; i < N; i++) {
      let cx = 0, cy = 0, cz = 0      // cohesion target
      let sx = 0, sy = 0, sz = 0      // separation
      let ax = 0, ay = 0, az = 0      // alignment (sum of velocities)
      let nNear = 0
      for (let j = 0; j < N; j++) {
        if (i === j) continue
        const dx = this.px[j] - this.px[i]
        const dy = this.py[j] - this.py[i]
        const dz = this.pz[j] - this.pz[i]
        const d2 = dx * dx + dy * dy + dz * dz
        if (d2 > v2) continue
        nNear++
        cx += this.px[j]; cy += this.py[j]; cz += this.pz[j]
        ax += this.vx[j]; ay += this.vy[j]; az += this.vz[j]
        if (d2 < sep2 && d2 > 1e-5) {
          const inv = 1 / Math.sqrt(d2)
          sx -= dx * inv; sy -= dy * inv; sz -= dz * inv
        }
      }
      if (nNear > 0) {
        cx = cx / nNear - this.px[i]
        cy = cy / nNear - this.py[i]
        cz = cz / nNear - this.pz[i]
        ax = ax / nNear - this.vx[i]
        ay = ay / nNear - this.vy[i]
        az = az / nNear - this.vz[i]
      }
      this.vx[i] += (cx * cohesion + sx * separation + ax * alignment) * dt
      this.vy[i] += (cy * cohesion + sy * separation + ay * alignment) * dt
      this.vz[i] += (cz * cohesion + sz * separation + az * alignment) * dt
      // Clamp speed
      const sp = Math.hypot(this.vx[i], this.vy[i], this.vz[i])
      const maxSp = speed
      if (sp > maxSp) {
        const k = maxSp / sp
        this.vx[i] *= k; this.vy[i] *= k; this.vz[i] *= k
      }
      // Bounds — soft turn
      if (this.px[i] > B) this.vx[i] -= 0.5 * dt
      else if (this.px[i] < -B) this.vx[i] += 0.5 * dt
      if (this.py[i] > B) this.vy[i] -= 0.5 * dt
      else if (this.py[i] < -B) this.vy[i] += 0.5 * dt
      if (this.pz[i] > B) this.vz[i] -= 0.5 * dt
      else if (this.pz[i] < -B) this.vz[i] += 0.5 * dt
      // Integrate
      this.px[i] += this.vx[i] * dt
      this.py[i] += this.vy[i] * dt
      this.pz[i] += this.vz[i] * dt
    }
    // Copy into the shared positions buffer + color by speed
    const positions = this.positions
    const colors = this.points.geometry.attributes.color.array as Float32Array
    const tmp = this.tmp
    for (let i = 0; i < N; i++) {
      positions[i * 3]     = this.px[i]
      positions[i * 3 + 1] = this.py[i]
      positions[i * 3 + 2] = this.pz[i]
      // Color : interpolate palette by normalized speed
      const sp = Math.min(1, Math.hypot(this.vx[i], this.vy[i], this.vz[i]) / speed)
      if (sp < 0.5) tmp.copy(this.c1).lerp(this.c2, sp * 2)
      else tmp.copy(this.c2).lerp(this.c3, (sp - 0.5) * 2)
      colors[i * 3]     = tmp.r
      colors[i * 3 + 1] = tmp.g
      colors[i * 3 + 2] = tmp.b
    }
    ;(this.points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
    ;(this.points.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true
    // Camera orbit
    this.orbit += dt * p.autoOrbitSpeed
    const yaw = this.orbit + this.mouseYaw
    const pitch = Math.sin(this.orbit * 0.3) * 0.25 + this.mousePitch
    const distance = Math.max(1.8, 4 - (h.detected ? h.pinch * 1.6 : 0) + this.mouseDistanceBias)
    this.innerCamera.position.set(Math.cos(yaw) * distance, Math.sin(pitch) * distance, Math.sin(yaw) * distance)
    this.innerCamera.lookAt(0, 0, 0)
    // Render the inner 3D scene into the RT
    this.renderer.setRenderTarget(this.rt)
    this.renderer.render(this.innerScene, this.innerCamera)
    this.renderer.setRenderTarget(null)
    // Bass pump on point size
    this.pointMat.size = p.pointSize * 0.025 * (1 + (a.bass ?? 0) * 0.5)
    this.displayMat.uniforms.uHueShift.value = (performance.now() * 0.0001 + (a.high ?? 0) * 0.4) % 1
  }

  mouseInteract(ev: { kind: string; dxNorm?: number; dyNorm?: number; wheelDelta?: number }) {
    if (ev.kind === 'drag') {
      this.mouseYaw += (ev.dxNorm ?? 0) * Math.PI
      this.mousePitch = Math.max(-1.3, Math.min(1.3, this.mousePitch + (ev.dyNorm ?? 0) * 1.5))
    } else if (ev.kind === 'wheel') {
      this.mouseDistanceBias = Math.max(-2.5, Math.min(6, this.mouseDistanceBias + (ev.wheelDelta ?? 0) * 0.002))
    }
  }

  dispose() {
    this.points.geometry.dispose()
    this.pointMat.dispose()
    this.rt.dispose()
    this.mesh.geometry.dispose()
    this.displayMat.dispose()
  }
}
