/**
 * SuperShape3D — surface 3D paramétrique morphable.
 *
 * Étend la superformule de Johan Gielis à 3D via la sphérification de Paul Bourke :
 *   r(θ) = ((|cos(m·θ/4)/a|^n2 + |sin(m·θ/4)/b|^n3) ^ -1/n1)
 *
 * Deux superformules pour latitude (φ) et longitude (θ) :
 *   - (m1, n1, n2, n3) → contour latitudinal
 *   - (m2, n4, n5, n6) → contour longitudinal
 *
 * Les positions 3D sont :
 *   x = r1(θ) · cos(θ) · r2(φ) · cos(φ)
 *   y = r1(θ) · sin(θ) · r2(φ) · cos(φ)
 *   z = r2(φ) · sin(φ)
 *
 * Selon les params, on obtient sphères, cubes, étoiles, fleurs, créatures aliennes,
 * tores tordus — espace d'expression IMMENSE. C'est le plus expressif des organismes
 * 3D : 8 paramètres continus + main qui les morph.
 *
 * Architecture rendering :
 *   - Scene interne dédiée + PerspectiveCamera privée (comme MengerSponge)
 *   - PointsMaterial sur grille latitude × longitude
 *   - Render dans RT, display fullscreen via shader copy
 *
 * Navigable :
 *   - Caméra orbite continue (autoOrbitSpeed)
 *   - Main x : modifie la vitesse d'orbite
 *   - Pinch  : zoom
 *
 * Métamorphose :
 *   - Main y : décale m1 ↔ m2 en live (change la symétrie radiale)
 *   - Audio bass : pulse n1 (= rondeur)
 *   - Audio mid : pulse n2/n3 (= étirement)
 *   - morphSpeed > 0 : auto-évolution lente des params autour du préset
 */
import * as THREE from 'three'
import type { VisualParams } from '../../types/scene'
import { senseBus } from '../../senses/SenseBus'

export interface SuperShape3DParams {
  // Superformula params (2 sets — latitude / longitude)
  m1: number; n1: number; n2: number; n3: number   // latitude (theta)
  m2: number; n4: number; n5: number; n6: number   // longitude (phi)
  resolution: number       // 32..128 — points per axis (total = res×res)
  scale: number            // 0.3..2
  autoOrbitSpeed: number   // 0..3
  fov: number              // 30..90
  morphSpeed: number       // 0..2 — auto-drift of params over time
  pointSize: number        // 0.5..6
  wireframe: number        // 0 or 1 — show lines between vertices
}

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

const MAX_RES = 128

/** Superformula r(theta). Returns a "radius" used to deform the unit sphere. */
function superformula(theta: number, m: number, n1: number, n2: number, n3: number): number {
  const t = m * theta / 4
  const a = Math.pow(Math.abs(Math.cos(t)), n2)
  const b = Math.pow(Math.abs(Math.sin(t)), n3)
  // Avoid pow(0, negative) = Infinity
  const s = a + b
  if (s < 1e-6) return 1
  return Math.pow(s, -1 / n1)
}

export class SuperShape3DOrganism {
  mesh: THREE.Mesh
  positions = new Float32Array(0)
  velocities: Float32Array | null = null
  count = 0
  obstacles: any
  renderer: THREE.WebGLRenderer | null = null
  private params: SuperShape3DParams
  private innerScene: THREE.Scene
  private innerCamera: THREE.PerspectiveCamera
  private rt: THREE.WebGLRenderTarget
  private points: THREE.Points
  private pointMat: THREE.PointsMaterial
  private lines: THREE.LineSegments | null = null
  private lineMat: THREE.LineBasicMaterial | null = null
  private displayMat: THREE.ShaderMaterial
  private orbit = 0
  private t = 0
  // Mouse-driven additions
  private mouseYaw = 0
  private mousePitch = 0
  private mouseDistanceBias = 0
  // Reusable buffers — recomputed each frame
  private vertexPositions: Float32Array
  private vertexColors: Float32Array
  private lineIndices: Uint16Array
  private c1 = new THREE.Color()
  private c2 = new THREE.Color()
  private c3 = new THREE.Color()
  private tmp = new THREE.Color()
  private res: number

  constructor(params: SuperShape3DParams, visual: VisualParams) {
    this.params = params
    this.res = Math.max(8, Math.min(MAX_RES, Math.round(params.resolution)))
    // Internal scene
    this.innerScene = new THREE.Scene()
    this.innerScene.background = new THREE.Color(visual.palette.bg)
    this.innerCamera = new THREE.PerspectiveCamera(params.fov, 1, 0.01, 100)
    this.innerCamera.position.set(0, 0, 3.5)
    this.innerCamera.lookAt(0, 0, 0)
    // Reusable buffers
    this.vertexPositions = new Float32Array(MAX_RES * MAX_RES * 3)
    this.vertexColors = new Float32Array(MAX_RES * MAX_RES * 3)
    // Build line indices ONCE (lat-major grid → horizontal + vertical lines)
    // Each cell of the grid produces 2 line segments → 4 indices
    this.lineIndices = new Uint16Array(MAX_RES * MAX_RES * 4)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.vertexPositions, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(this.vertexColors, 3))
    this.pointMat = new THREE.PointsMaterial({
      size: params.pointSize * 0.02,
      vertexColors: true, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false,
      sizeAttenuation: true,
    })
    this.points = new THREE.Points(geo, this.pointMat)
    this.innerScene.add(this.points)
    // Wireframe lines (optional)
    this.lineMat = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false,
    })
    this.lines = new THREE.LineSegments(geo, this.lineMat)
    this.lines.visible = (params.wireframe ?? 1) > 0.5
    this.innerScene.add(this.lines)
    this.buildIndices()
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

  /** Pre-compute the wireframe line connectivity for the current resolution. */
  private buildIndices() {
    const N = this.res
    let idx = 0
    for (let j = 0; j < N - 1; j++) {
      for (let i = 0; i < N - 1; i++) {
        const a = j * N + i
        const b = j * N + (i + 1)
        const c = (j + 1) * N + i
        // 2 segments per cell — top edge + left edge
        this.lineIndices[idx++] = a
        this.lineIndices[idx++] = b
        this.lineIndices[idx++] = a
        this.lineIndices[idx++] = c
      }
    }
    this.points.geometry.setIndex(new THREE.BufferAttribute(this.lineIndices, 1))
    // Points draw uses positions directly, NOT the index buffer (which is for LineSegments only).
    // Set drawRange so Points renders N*N vertices.
    this.points.geometry.setDrawRange(0, N * N)
    if (this.lines) this.lines.geometry.setDrawRange(0, idx)
  }

  setAspect(a: number) {
    this.innerCamera.aspect = a
    this.innerCamera.updateProjectionMatrix()
  }

  updateParams(p: SuperShape3DParams) {
    const resChanged = Math.round(p.resolution) !== this.res
    this.params = p
    this.innerCamera.fov = p.fov
    this.innerCamera.updateProjectionMatrix()
    this.pointMat.size = p.pointSize * 0.02
    if (this.lines) this.lines.visible = (p.wireframe ?? 1) > 0.5
    if (resChanged) {
      this.res = Math.max(8, Math.min(MAX_RES, Math.round(p.resolution)))
      this.buildIndices()
    }
  }

  applyVisual(visual: VisualParams) {
    if (this.innerScene.background instanceof THREE.Color) {
      this.innerScene.background.set(visual.palette.bg)
    }
    this.c1.set(visual.palette.primary)
    this.c2.set(visual.palette.secondary)
    this.c3.set(visual.palette.glow)
    this.pointMat.blending = visual.blendMode === 'normal' ? THREE.NormalBlending : THREE.AdditiveBlending
    if (this.lineMat) this.lineMat.blending = this.pointMat.blending
  }

  update(dt: number) {
    if (!this.renderer) return
    const p = this.params
    const h = senseBus.hands
    const a = senseBus.audio
    this.t += dt
    // Orbit — hand x speeds up
    const orbitSpeed = p.autoOrbitSpeed * (1 + (h.detected ? (h.indexTip.x - 0.5) * 1.6 : 0))
    this.orbit += dt * orbitSpeed
    // Pinch + mouse-wheel zoom
    const distance = Math.max(1.4, 3.5 - (h.detected ? h.pinch * 1.8 : 0) + this.mouseDistanceBias)
    const yaw = this.orbit + this.mouseYaw
    const pitch = Math.sin(this.orbit * 0.4) * 0.3 + this.mousePitch
    this.innerCamera.position.set(
      Math.cos(yaw) * distance,
      Math.sin(pitch) * distance,
      Math.sin(yaw) * distance,
    )
    this.innerCamera.lookAt(0, 0, 0)
    // Param morphing
    //  - hand y nudges m1 ↔ m2 in real time
    //  - audio bass swells n1 (roundness)
    //  - morphSpeed adds slow auto-drift
    const handY = h.detected ? (h.indexTip.y - 0.5) * 4 : 0
    const m1 = p.m1 + handY + Math.sin(this.t * p.morphSpeed) * 2
    const m2 = p.m2 - handY + Math.cos(this.t * p.morphSpeed * 0.7) * 2
    const n1Bias = (a.bass ?? 0) * 0.6
    const n1 = Math.max(0.1, p.n1 + n1Bias)
    const n4 = Math.max(0.1, p.n4 + n1Bias)
    const n2 = p.n2 + (a.mid ?? 0) * 0.5
    const n3 = p.n3 + (a.mid ?? 0) * 0.5
    const n5 = p.n5, n6 = p.n6
    // Generate vertex grid (lat = j ∈ [0, π], lon = i ∈ [0, 2π])
    const N = this.res
    const positions = this.vertexPositions
    const colors = this.vertexColors
    const tmp = this.tmp
    for (let j = 0; j < N; j++) {
      const phi = (j / (N - 1)) * Math.PI - Math.PI / 2  // [-π/2, π/2]
      const r2 = superformula(phi, m2, n4, n5, n6)
      for (let i = 0; i < N; i++) {
        const theta = (i / (N - 1)) * Math.PI * 2 - Math.PI  // [-π, π]
        const r1 = superformula(theta, m1, n1, n2, n3)
        const cosPhi = Math.cos(phi)
        const x = r1 * Math.cos(theta) * r2 * cosPhi * p.scale
        const y = r1 * Math.sin(theta) * r2 * cosPhi * p.scale
        const z = r2 * Math.sin(phi) * p.scale
        const idx = j * N + i
        positions[idx * 3]     = x
        positions[idx * 3 + 1] = y
        positions[idx * 3 + 2] = z
        // Color: lerp along latitude (north pole = c1, equator = c2, south pole = c3)
        const t01 = j / (N - 1)
        if (t01 < 0.5) tmp.copy(this.c1).lerp(this.c2, t01 * 2)
        else tmp.copy(this.c2).lerp(this.c3, (t01 - 0.5) * 2)
        colors[idx * 3]     = tmp.r
        colors[idx * 3 + 1] = tmp.g
        colors[idx * 3 + 2] = tmp.b
      }
    }
    ;(this.points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
    ;(this.points.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true
    // Render the 3D scene into the RT
    this.renderer.setRenderTarget(this.rt)
    this.renderer.render(this.innerScene, this.innerCamera)
    this.renderer.setRenderTarget(null)
    // Audio high shifts the palette hue continuously
    this.displayMat.uniforms.uHueShift.value =
      (performance.now() * 0.0001 + (a.high ?? 0) * 0.4) % 1
  }

  mouseInteract(ev: { kind: string; dxNorm?: number; dyNorm?: number; wheelDelta?: number }) {
    if (ev.kind === 'drag') {
      this.mouseYaw += (ev.dxNorm ?? 0) * Math.PI
      this.mousePitch = Math.max(-1.3, Math.min(1.3, this.mousePitch + (ev.dyNorm ?? 0) * 1.5))
    } else if (ev.kind === 'wheel') {
      this.mouseDistanceBias = Math.max(-2.5, Math.min(5, this.mouseDistanceBias + (ev.wheelDelta ?? 0) * 0.002))
    }
  }

  dispose() {
    this.points.geometry.dispose()
    this.pointMat.dispose()
    this.lineMat?.dispose()
    this.rt.dispose()
    this.mesh.geometry.dispose()
    this.displayMat.dispose()
  }
}
