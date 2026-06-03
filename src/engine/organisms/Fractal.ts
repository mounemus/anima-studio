/**
 * Fractal — Julia set en fragment shader (GPU, plein écran).
 *
 * Calcule z = z² + c en boucle dans le fragment shader. `c` est piloté par la
 * position de la main (ou un point fixe configurable). Le nombre d'itérations
 * avant échappement définit la couleur (gradient palette).
 *
 * Interactif :
 * - Main x,y     : déplace le paramètre `c` du Julia → morphe la forme en live
 * - Pinch        : zoom sur le centre
 * - Audio bass   : pulse la luminosité globale
 * - Audio high   : décale la palette (hue shift)
 *
 * Pas de "particules" — c'est un plan plein écran avec shader. Le système de
 * modifiers ne touche pas ce shader (positions=null, count=0 — les modifiers
 * font no-op).
 *
 * Compat : `setAspect` recalcule l'uniform d'aspect ratio.
 */
import * as THREE from 'three'
import type { VisualParams } from '../../types/scene'
import { senseBus } from '../../senses/SenseBus'

export interface FractalParams {
  iterations: number       // 32..256 — précision
  zoom: number             // 0.3..3 — zoom de base
  cx: number               // -1..1 — composante réelle de c (overridée par main)
  cy: number               // -1..1 — composante imaginaire de c
  followHand: number       // 0..1 — interpolation hand-c (0 = static, 1 = full follow)
  bailout: number          // 2..20 — rayon d'échappement
  brightness: number       // 0.5..2
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
  uniform float uHueShift;     // 0..1

  // HSV → RGB helper for hue shifting
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
    // Map uv [0,1] → complex plane around origin, respecting aspect
    vec2 z = (vUv - 0.5) * 2.0 / uZoom;
    z.x *= uAspect;
    float n = 0.0;
    float maxI = uIters;
    float bail2 = uBailout * uBailout;
    for (float i = 0.0; i < 256.0; i++) {
      if (i >= maxI) break;
      // z = z^2 + c
      z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + uC;
      if (dot(z, z) > bail2) { n = i; break; }
    }
    if (n == 0.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0); return; }
    // Smooth iteration count (continuous coloring)
    float nu = log(log(length(z)) / log(uBailout)) / log(2.0);
    float t = clamp((n + 1.0 - nu) / maxI, 0.0, 1.0);
    // Gradient through 3 palette colors
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
  /** Fractal is GPU-only — no per-vertex positions for modifiers to mutate. */
  positions = new Float32Array(0)
  velocities: Float32Array | null = null
  count = 0
  obstacles: any
  private aspect = 1
  private params: FractalParams
  private mat: THREE.ShaderMaterial

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
    this.mat.uniforms.uZoom.value = p.zoom
    this.mat.uniforms.uIters.value = p.iterations
    this.mat.uniforms.uBailout.value = p.bailout
    this.mat.uniforms.uBrightness.value = p.brightness
  }

  applyVisual(visual: VisualParams) {
    ;(this.mat.uniforms.uPaletteA.value as THREE.Color).set(visual.palette.bg)
    ;(this.mat.uniforms.uPaletteB.value as THREE.Color).set(visual.palette.primary)
    ;(this.mat.uniforms.uPaletteC.value as THREE.Color).set(visual.palette.glow)
  }

  update(_dt: number) {
    const p = this.params
    const h = senseBus.hands
    const audio = senseBus.audio
    // Hand interpolation toward followHand
    const cx = h.detected
      ? p.cx + ((h.indexTip.x - 0.5) * 2 * 0.8 - p.cx) * p.followHand
      : p.cx
    const cy = h.detected
      ? p.cy + (-(h.indexTip.y - 0.5) * 2 * 0.8 - p.cy) * p.followHand
      : p.cy
    ;(this.mat.uniforms.uC.value as THREE.Vector2).set(cx, cy)
    // Pinch zooms in
    const z = p.zoom * (1 + (h.detected ? h.pinch * 1.5 : 0))
    this.mat.uniforms.uZoom.value = z
    // Audio bass boosts brightness
    this.mat.uniforms.uBrightness.value = p.brightness * (1 + (audio.bass ?? 0) * 0.4)
    // Audio high shifts hue
    const t = performance.now() * 0.0002
    this.mat.uniforms.uHueShift.value = (t + (audio.high ?? 0) * 0.5) % 1
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.mat.dispose()
  }
}
