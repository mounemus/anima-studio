/**
 * Fractal — Julia set en fragment shader (GPU, plein écran).
 *
 * Animation INTRINSÈQUE :
 * - `c` orbite en figure de Lissajous (orbitSpeed/orbitRadius), même sans main
 * - Zoom respire en sinus lent
 * - Rotation du plan complexe (anglePlane) tourne en continu
 * - Cycle de teinte automatique sur la palette
 * - Quand la main est détectée, `c` interpole vers la main (followHand)
 *
 * Interactif :
 * - Main x,y     : tire `c` vers la main (forcée par followHand 0..1)
 * - Pinch        : zoom additionnel (jusqu'à 2.5×)
 * - Audio bass   : pulse luminosité + accélère orbit
 * - Audio high   : décale hue + accélère rotation du plan
 */
import * as THREE from 'three'
import type { VisualParams } from '../../types/scene'
import { senseBus } from '../../senses/SenseBus'

export interface FractalParams {
  iterations: number       // 32..256 — précision
  zoom: number             // 0.3..3 — zoom de base
  cx: number               // -1..1 — centre c de base (point d'orbite)
  cy: number               // -1..1
  followHand: number       // 0..1
  bailout: number          // 2..20
  brightness: number       // 0.5..2
  orbitSpeed: number       // 0..2 — vitesse de l'orbite Lissajous de c
  orbitRadius: number      // 0..0.5 — amplitude de l'orbite
  rotation: number         // -1..1 rad/sec — rotation du plan complexe
  zoomBreath: number       // 0..0.5 — amplitude du zoom respiration
}

const VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`

const FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform float uAspect;
  uniform vec2 uC;
  uniform float uZoom;
  uniform float uIters;
  uniform float uBailout;
  uniform vec3 uPaletteA;
  uniform vec3 uPaletteB;
  uniform vec3 uPaletteC;
  uniform float uBrightness;
  uniform float uHueShift;
  uniform float uAngle;            // rotation du plan complexe

  vec3 hueShift(vec3 col, float h) {
    float U = cos(h * 6.2831853);
    float W = sin(h * 6.2831853);
    return vec3(
      (.299 + .701 * U + .168 * W) * col.r + (.587 - .587 * U + .330 * W) * col.g + (.114 - .114 * U - .497 * W) * col.b,
      (.299 - .299 * U - .328 * W) * col.r + (.587 + .413 * U + .035 * W) * col.g + (.114 - .114 * U + .292 * W) * col.b,
      (.299 - .300 * U + 1.250 * W) * col.r + (.587 - .588 * U - 1.050 * W) * col.g + (.114 + .886 * U - .203 * W) * col.b
    );
  }

  void main() {
    vec2 z = (vUv - 0.5) * 2.0 / uZoom;
    z.x *= uAspect;
    // Rotation du plan
    float ca = cos(uAngle), sa = sin(uAngle);
    z = vec2(z.x * ca - z.y * sa, z.x * sa + z.y * ca);
    float n = 0.0;
    float maxI = uIters;
    float bail2 = uBailout * uBailout;
    for (float i = 0.0; i < 256.0; i++) {
      if (i >= maxI) break;
      z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + uC;
      if (dot(z, z) > bail2) { n = i; break; }
    }
    if (n == 0.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0); return; }
    float nu = log(log(length(z)) / log(uBailout)) / log(2.0);
    float t = clamp((n + 1.0 - nu) / maxI, 0.0, 1.0);
    vec3 col = t < 0.5
      ? mix(uPaletteA, uPaletteB, t * 2.0)
      : mix(uPaletteB, uPaletteC, (t - 0.5) * 2.0);
    col = hueShift(col, uHueShift);
    col *= uBrightness;
    gl_FragColor = vec4(col, 1.0);
  }
`

export class FractalOrganism {
  mesh: THREE.Mesh
  positions = new Float32Array(0)
  velocities: Float32Array | null = null
  count = 0
  obstacles: any
  private aspect = 1
  private params: FractalParams
  private mat: THREE.ShaderMaterial
  private t = 0
  private plantAngle = 0

  constructor(params: FractalParams, visual: VisualParams) {
    this.params = params
    const geo = new THREE.PlaneGeometry(2, 2)
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      uniforms: {
        uAspect: { value: 1 },
        uC: { value: new THREE.Vector2(params.cx, params.cy) },
        uZoom: { value: params.zoom },
        uIters: { value: params.iterations },
        uBailout: { value: params.bailout },
        uBrightness: { value: params.brightness },
        uHueShift: { value: 0 },
        uAngle: { value: 0 },
        uPaletteA: { value: new THREE.Color(visual.palette.bg) },
        uPaletteB: { value: new THREE.Color(visual.palette.primary) },
        uPaletteC: { value: new THREE.Color(visual.palette.glow) },
      },
    })
    this.mesh = new THREE.Mesh(geo, this.mat)
  }

  setAspect(a: number) {
    this.aspect = a
    void this.aspect
    this.mat.uniforms.uAspect.value = a
  }

  updateParams(p: FractalParams) {
    this.params = p
    this.mat.uniforms.uIters.value = p.iterations
    this.mat.uniforms.uBailout.value = p.bailout
  }

  applyVisual(visual: VisualParams) {
    ;(this.mat.uniforms.uPaletteA.value as THREE.Color).set(visual.palette.bg)
    ;(this.mat.uniforms.uPaletteB.value as THREE.Color).set(visual.palette.primary)
    ;(this.mat.uniforms.uPaletteC.value as THREE.Color).set(visual.palette.glow)
  }

  update(dt: number) {
    const p = this.params
    const h = senseBus.hands
    const audio = senseBus.audio
    // Always advance time — even without hand or audio, the fractal lives
    this.t += dt * p.orbitSpeed * (1 + (audio.bass ?? 0) * 0.5)
    this.plantAngle += dt * p.rotation * (1 + (audio.high ?? 0) * 1.5)
    // Compute base c using Lissajous orbit around (cx, cy)
    const orbitX = Math.sin(this.t) * p.orbitRadius
    const orbitY = Math.cos(this.t * 1.31) * p.orbitRadius  // irrational ratio = never repeats
    const baseCx = p.cx + orbitX
    const baseCy = p.cy + orbitY
    // Hand interpolation (overrides orbit when followHand > 0)
    const cx = h.detected
      ? baseCx + ((h.indexTip.x - 0.5) * 1.6 - baseCx) * p.followHand
      : baseCx
    const cy = h.detected
      ? baseCy + (-(h.indexTip.y - 0.5) * 1.6 - baseCy) * p.followHand
      : baseCy
    ;(this.mat.uniforms.uC.value as THREE.Vector2).set(cx, cy)
    // Zoom breathing + pinch boost
    const breath = 1 + Math.sin(this.t * 0.4) * p.zoomBreath
    const pinchBoost = h.detected ? 1 + h.pinch * 1.5 : 1
    this.mat.uniforms.uZoom.value = p.zoom * breath * pinchBoost
    // Rotation
    this.mat.uniforms.uAngle.value = this.plantAngle
    // Brightness with bass pump
    this.mat.uniforms.uBrightness.value = p.brightness * (1 + (audio.bass ?? 0) * 0.5)
    // Automatic hue cycling — always running, audio.high accelerates
    const hueT = performance.now() * 0.00015
    this.mat.uniforms.uHueShift.value = (hueT + (audio.high ?? 0) * 0.6) % 1
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.mat.dispose()
  }
}
