/**
 * CellularAutomata — règles de type Conway's Game of Life sur GPU.
 *
 * Grille de cellules vivantes/mortes (canal R, 0/1), avec une variable « âge »
 * (canal G, 0..1) qui s'incrémente tant que la cellule reste vivante puis
 * décroît en trail. Le canal G permet une visualisation colorée avec rémanence.
 *
 * Règles supportées (notation B/S = "born if neighbours in X / survives if Y") :
 *   - 'conway'    : B3/S23 — règle classique
 *   - 'highlife'  : B36/S23 — survivants + spawn à 6
 *   - 'seeds'     : B2/S — seules les naissances persistent (explose)
 *   - 'daedalus'  : B3/S012345678 — toujours vivant après naissance (croissance)
 *   - 'maze'      : B3/S12345 — produit des labyrinthes
 *   - 'replicator': B1357/S1357 — autoréplique tout pattern
 *
 * Interactif :
 *   - Main : injecte des cellules vivantes autour du pointer
 *   - Pinch : taille du brush
 *   - Audio bass kick fort → reseed automatique avec un pattern aléatoire
 *   - Audio mid : tick speed (frames entre 2 sim steps)
 */
import * as THREE from 'three'
import type { VisualParams } from '../../types/scene'
import { senseBus } from '../../senses/SenseBus'

export type CARule = 'conway' | 'highlife' | 'seeds' | 'daedalus' | 'maze' | 'replicator'

interface RuleSpec {
  born: number[]
  survive: number[]
}
const RULES: Record<CARule, RuleSpec> = {
  conway:     { born: [3],       survive: [2, 3] },
  highlife:   { born: [3, 6],    survive: [2, 3] },
  seeds:      { born: [2],       survive: [] },
  daedalus:   { born: [3],       survive: [0, 1, 2, 3, 4, 5, 6, 7, 8] },
  maze:       { born: [3],       survive: [1, 2, 3, 4, 5] },
  replicator: { born: [1, 3, 5, 7], survive: [1, 3, 5, 7] },
}

export interface CellularAutomataParams {
  rule: CARule
  resolution: number      // 64..512 — grid size
  ticksPerSec: number     // 1..60 — simulation step rate (independent of FPS)
  ageDecay: number        // 0.8..0.99 — how fast the dead-cell trail fades
  brushSize: number       // 0.005..0.1
  brushStrength: number   // 0..1
  autoReseed: number      // 0..1 — bass-kick reseed sensitivity
}

const VERT = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
`

// SIM SHADER : encodes the rule + age + brush + reseed
const SIM_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uPrev;
  uniform vec2 uTexel;
  uniform vec3 uBornBits;       // 3 ints encoded as bit-mask in float, see encoding below
  uniform vec3 uSurviveBits;
  uniform float uAgeDecay;
  uniform vec2 uBrushPos;
  uniform float uBrushRadius;
  uniform float uBrushStrength;
  uniform float uSeedSeed;       // random reseed pulse (>0 triggers chaos)

  // We pack the "born if N neighbours" and "survive if N neighbours" rules into
  // 3 vec3 components representing a 9-bit mask (bits 0..8). Each component carries
  // 3 bits to keep precision safe in float texture lookups.
  // hasBit returns 1 if bit n is set in the packed mask.
  float hasBit(vec3 mask, int n) {
    if (n < 3)  return mod(floor(mask.x / pow(2.0, float(n))), 2.0);
    if (n < 6)  return mod(floor(mask.y / pow(2.0, float(n - 3))), 2.0);
    return mod(floor(mask.z / pow(2.0, float(n - 6))), 2.0);
  }

  float life(vec2 uv) {
    return step(0.5, texture2D(uPrev, uv).r);
  }

  void main() {
    float self = life(vUv);
    float age = texture2D(uPrev, vUv).g;
    // Count 8 neighbours
    float n = 0.0;
    n += life(vUv + vec2(-uTexel.x, -uTexel.y));
    n += life(vUv + vec2( 0.0,      -uTexel.y));
    n += life(vUv + vec2( uTexel.x, -uTexel.y));
    n += life(vUv + vec2(-uTexel.x,  0.0));
    n += life(vUv + vec2( uTexel.x,  0.0));
    n += life(vUv + vec2(-uTexel.x,  uTexel.y));
    n += life(vUv + vec2( 0.0,       uTexel.y));
    n += life(vUv + vec2( uTexel.x,  uTexel.y));
    int ni = int(n + 0.5);
    // Lookup born / survive bits
    float alive = 0.0;
    if (self < 0.5) {
      alive = hasBit(uBornBits, ni);
    } else {
      alive = hasBit(uSurviveBits, ni);
    }
    // Age channel : increments while alive, fades while dead
    float newAge = alive > 0.5
      ? min(1.0, age + 0.02)
      : age * uAgeDecay;
    // Brush injection : add live cells in the cursor area
    if (uBrushPos.x >= 0.0) {
      float d = distance(vUv, uBrushPos);
      if (d < uBrushRadius) {
        float r = fract(sin(dot(vUv * 1000.0, vec2(12.9898, 78.233))) * 43758.5453);
        if (r < uBrushStrength) {
          alive = 1.0;
          newAge = 1.0;
        }
      }
    }
    // Random reseed pulse when bass kicks
    if (uSeedSeed > 0.001) {
      float r = fract(sin(dot(vUv * 100.0 + uSeedSeed, vec2(23.0, 47.0))) * 14000.0);
      if (r < uSeedSeed * 0.2) { alive = 1.0; newAge = 1.0; }
    }
    gl_FragColor = vec4(alive, newAge, 0.0, 1.0);
  }
`

// DISPLAY SHADER : colorise selon l'âge (R = vivant, G = âge)
const DISPLAY_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uSrc;
  uniform vec3 uPaletteA;
  uniform vec3 uPaletteB;
  uniform vec3 uPaletteC;

  void main() {
    vec2 c = texture2D(uSrc, vUv).rg;
    float age = c.g;
    if (age < 0.001) { gl_FragColor = vec4(uPaletteA, 1.0); return; }
    vec3 col = age < 0.5
      ? mix(uPaletteA, uPaletteB, age * 2.0)
      : mix(uPaletteB, uPaletteC, (age - 0.5) * 2.0);
    gl_FragColor = vec4(col, 1.0);
  }
`

/** Encode an array of [0..8] integers into a vec3 of 3-bit-packed floats. */
function packRule(bits: number[]): THREE.Vector3 {
  let x = 0, y = 0, z = 0
  for (const n of bits) {
    if (n < 3) x |= 1 << n
    else if (n < 6) y |= 1 << (n - 3)
    else if (n < 9) z |= 1 << (n - 6)
  }
  return new THREE.Vector3(x, y, z)
}

export class CellularAutomataOrganism {
  mesh: THREE.Mesh
  positions = new Float32Array(0)
  velocities: Float32Array | null = null
  count = 0
  obstacles: any
  renderer: THREE.WebGLRenderer | null = null
  private params: CellularAutomataParams
  private rtA: THREE.WebGLRenderTarget
  private rtB: THREE.WebGLRenderTarget
  private currentRT: THREE.WebGLRenderTarget
  private simMat: THREE.ShaderMaterial
  private displayMat: THREE.ShaderMaterial
  private simScene: THREE.Scene
  private simCam: THREE.OrthographicCamera
  private fullQuad: THREE.Mesh
  private res: number
  private tickAccumulator = 0
  private lastBass = 0

  constructor(params: CellularAutomataParams, visual: VisualParams) {
    this.params = params
    this.res = Math.max(32, Math.min(512, params.resolution))
    const rtOpts: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
    }
    this.rtA = new THREE.WebGLRenderTarget(this.res, this.res, rtOpts)
    this.rtB = new THREE.WebGLRenderTarget(this.res, this.res, rtOpts)
    this.currentRT = this.rtA
    const rule = RULES[params.rule] ?? RULES.conway
    this.simMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: SIM_FRAG,
      uniforms: {
        uPrev: { value: this.rtA.texture },
        uTexel: { value: new THREE.Vector2(1 / this.res, 1 / this.res) },
        uBornBits: { value: packRule(rule.born) },
        uSurviveBits: { value: packRule(rule.survive) },
        uAgeDecay: { value: params.ageDecay },
        uBrushPos: { value: new THREE.Vector2(-1, -1) },
        uBrushRadius: { value: params.brushSize },
        uBrushStrength: { value: params.brushStrength },
        uSeedSeed: { value: 0 },
      },
    })
    this.simScene = new THREE.Scene()
    this.simCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    this.fullQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.simMat)
    this.simScene.add(this.fullQuad)
    this.displayMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: DISPLAY_FRAG,
      transparent: true, depthWrite: false,
      uniforms: {
        uSrc: { value: this.rtA.texture },
        uPaletteA: { value: new THREE.Color(visual.palette.bg) },
        uPaletteB: { value: new THREE.Color(visual.palette.primary) },
        uPaletteC: { value: new THREE.Color(visual.palette.glow) },
      },
    })
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.displayMat)
    // Initial seed when renderer is attached (deferred via update())
  }

  seed() {
    if (!this.renderer) return
    const seedMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        void main() {
          // ~30% random density seed across the grid
          float r = fract(sin(dot(vUv * vec2(50.0, 80.0) + 13.0, vec2(12.9898, 78.233))) * 43758.5453);
          float alive = step(0.7, r);
          gl_FragColor = vec4(alive, alive, 0.0, 1.0);
        }
      `,
    })
    const prev = this.fullQuad.material
    this.fullQuad.material = seedMat
    this.renderer.setRenderTarget(this.rtA)
    this.renderer.render(this.simScene, this.simCam)
    this.renderer.setRenderTarget(this.rtB)
    this.renderer.render(this.simScene, this.simCam)
    this.renderer.setRenderTarget(null)
    this.fullQuad.material = prev
    seedMat.dispose()
    this.currentRT = this.rtA
    this.displayMat.uniforms.uSrc.value = this.currentRT.texture
  }

  setAspect(_a: number) { /* no-op */ }

  updateParams(p: CellularAutomataParams) {
    const ruleChanged = p.rule !== this.params.rule
    this.params = p
    if (ruleChanged) {
      const r = RULES[p.rule] ?? RULES.conway   // fall back if a scene carries a bad/missing rule
      ;(this.simMat.uniforms.uBornBits.value as THREE.Vector3).copy(packRule(r.born))
      ;(this.simMat.uniforms.uSurviveBits.value as THREE.Vector3).copy(packRule(r.survive))
    }
    this.simMat.uniforms.uAgeDecay.value = p.ageDecay
    this.simMat.uniforms.uBrushRadius.value = p.brushSize
    this.simMat.uniforms.uBrushStrength.value = p.brushStrength
    if (p.resolution !== this.res) {
      this.res = Math.max(32, Math.min(512, p.resolution))
      this.rtA.setSize(this.res, this.res)
      this.rtB.setSize(this.res, this.res)
      this.simMat.uniforms.uTexel.value.set(1 / this.res, 1 / this.res)
      this.seed()
    }
  }

  applyVisual(visual: VisualParams) {
    ;(this.displayMat.uniforms.uPaletteA.value as THREE.Color).set(visual.palette.bg)
    ;(this.displayMat.uniforms.uPaletteB.value as THREE.Color).set(visual.palette.primary)
    ;(this.displayMat.uniforms.uPaletteC.value as THREE.Color).set(visual.palette.glow)
  }

  update(dt: number) {
    if (!this.renderer) return
    // First-frame seed (now that renderer is set)
    if (!this._seeded) { this.seed(); this._seeded = true }
    const p = this.params
    const h = senseBus.hands
    const a = senseBus.audio
    // Hand brush
    if (h.detected) {
      this.simMat.uniforms.uBrushPos.value.set(h.indexTip.x, 1 - h.indexTip.y)
      this.simMat.uniforms.uBrushRadius.value = p.brushSize * (1 + h.pinch * 4)
    } else {
      this.simMat.uniforms.uBrushPos.value.set(-1, -1)
    }
    // Bass kick reseed detection (rising edge above threshold)
    const bass = a.bass ?? 0
    const kick = bass > 0.5 && this.lastBass < 0.3 ? bass * p.autoReseed : 0
    this.lastBass = bass
    this.simMat.uniforms.uSeedSeed.value = kick
    // Tick rate driven by ticksPerSec (independent of frame rate)
    // Audio mid speeds up the simulation when present
    const tickRate = p.ticksPerSec * (1 + (a.mid ?? 0) * 1.5)
    this.tickAccumulator += dt * tickRate
    while (this.tickAccumulator >= 1) {
      this.tickAccumulator -= 1
      const src = this.currentRT
      const dst = src === this.rtA ? this.rtB : this.rtA
      this.simMat.uniforms.uPrev.value = src.texture
      this.renderer.setRenderTarget(dst)
      this.renderer.render(this.simScene, this.simCam)
      this.currentRT = dst
    }
    this.renderer.setRenderTarget(null)
    this.displayMat.uniforms.uSrc.value = this.currentRT.texture
  }

  private _seeded = false

  dispose() {
    this.rtA.dispose(); this.rtB.dispose()
    this.simMat.dispose(); this.displayMat.dispose()
    this.fullQuad.geometry.dispose()
    this.mesh.geometry.dispose()
  }
}
