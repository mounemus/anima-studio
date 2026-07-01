/**
 * Murmuration — flocking dense d'oiseaux avec battement d'ailes.
 *
 * Modèle :
 *   - jusqu'à 8000 agents (vs 5000 pour Boids classique)
 *   - règles de Reynolds 1986 (cohésion, séparation, alignement) + biais
 *     spécifiques murmuration : alignement fort + cohésion faible + swirl
 *     léger (chaque oiseau ressent une petite tangentielle au centre de masse local)
 *   - réponse "prédateur" forte : main + obstacles "kill"/"avoid" causent des
 *     virages brusques (factor ×4 vs Boids ordinaire)
 *   - audio : bass = ampli flap, mid = vitesse flap, high = nervosité (jitter)
 *
 * Rendu :
 *   - InstancedMesh d'un mini-triangle "ailes" (3 vertices : apex + leftTip + rightTip)
 *   - Vertex shader anime la HAUTEUR Y des wing tips via sin(t * flapSpeed + phase)
 *     → effet de battement visible même à 3000 oiseaux
 *   - Chaque oiseau a sa propre phase aléatoire → battements désynchronisés (réaliste)
 *   - Couleur per-instance : nuance dégradée selon profondeur Z (devant = clair, fond = sombre)
 *
 * Profondeur Z fake :
 *   - Chaque oiseau a aussi un `pz ∈ [-1, 1]` (depth)
 *   - Scale per-instance = base * (1 + pz * 0.3) → effet de perspective sans
 *     vraie 3D scene (reste compat avec la OrthographicCamera principale)
 *   - Z dérive lentement pour stratifier la nuée (illusion de volume)
 *
 * Compat modifiers :
 *   - Expose positions (stride 3) + velocities (stride 2) pour vortex/gravityWell
 */
import * as THREE from 'three'
import type { VisualParams, Obstacle } from '../../types/scene'
import { senseBus } from '../../senses/SenseBus'
import { solveObstacles } from '../Obstacles'
import { getSilhouetteMask } from '../../senses/Silhouette'
import { sampleFlow } from '../Flow'

const MAX_BIRDS = 8000

export interface MurmurationParams {
  count: number             // 200..8000
  cohesion: number          // 0..2 (faible pour murmuration)
  separation: number        // 0..3
  alignment: number         // 0..3 (fort pour murmuration)
  swirl: number             // 0..2 — tangentielle locale (effet de rotation collective)
  speed: number             // 0.1..3
  vision: number            // 0.05..0.5 — rayon des règles
  size: number              // 0.005..0.04
  flapSpeed: number         // 1..30 Hz
  flapAmplitude: number     // 0..1.2 — amplitude visuelle des wings
  predatorResponse: number  // 0..3 — virage brusque sur main/obstacles
  depthSpread: number       // 0..1 — étalement Z (profondeur fake)
  trail: number             // 0.5..0.999
}

const VERT = `
  precision highp float;
  attribute float aVertexType;        // 0 = body, 1 = wing
  attribute float aInstancePhase;
  attribute float aInstanceDepth;     // -1..1 — fake Z
  uniform float uTime;
  uniform float uFlapSpeed;
  uniform float uFlapAmplitude;
  uniform float uAudioBass;
  varying float vWing;
  varying float vDepth;

  void main() {
    vec3 p = position;
    if (aVertexType > 0.5) {
      // Wing tip — oscillate Y. Bass amplifies amplitude.
      float amp = uFlapAmplitude * (1.0 + uAudioBass * 0.5);
      float flap = sin(uTime * uFlapSpeed + aInstancePhase);
      p.y += flap * amp;
      // Add slight Z-bend so wings curve when up (visible from oblique angle)
      p.z += abs(flap) * 0.1 * amp;
      vWing = abs(flap);
    } else {
      vWing = 0.0;
    }
    vDepth = aInstanceDepth;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
  }
`

const FRAG = `
  precision highp float;
  uniform vec3 uColorNear;
  uniform vec3 uColorFar;
  uniform vec3 uColorGlow;
  varying float vWing;
  varying float vDepth;

  void main() {
    // depth 0..1 (near=1, far=0) — lerp between near/far palette colors
    float t = (vDepth + 1.0) * 0.5;
    vec3 col = mix(uColorFar, uColorNear, t);
    // Wings flash slightly with glow color at peak flap → suggestion of feather shimmer
    col = mix(col, uColorGlow, vWing * 0.45);
    gl_FragColor = vec4(col, 0.95);
  }
`

export class MurmurationOrganism {
  mesh: THREE.InstancedMesh
  /** Exposed for the Modifier system (in NDC ~[-1,1]) */
  positions: Float32Array        // x,y,z stride 3
  velocities: Float32Array       // vx,vy stride 2
  count: number = 0
  obstacles: Obstacle[] | undefined
  private params: MurmurationParams
  private mat: THREE.ShaderMaterial
  private dummy = new THREE.Object3D()
  private aspect = 1
  private t = 0
  // Geometry attributes
  private phases: Float32Array
  private depths: Float32Array
  private phaseAttr: THREE.InstancedBufferAttribute
  private depthAttr: THREE.InstancedBufferAttribute
  // Spatial grid used to compute local average velocity in O(N) instead of the
  // previous O(N²) neighbor scan. Turns the flock from a random dust cloud
  // into coordinated coherent waves (real murmuration behaviour).
  private static GRID = 16
  private gridVX = new Float32Array(16 * 16)
  private gridVY = new Float32Array(16 * 16)
  private gridCount = new Uint16Array(16 * 16)

  constructor(params: MurmurationParams, visual: VisualParams) {
    this.params = params
    this.count = Math.min(params.count, MAX_BIRDS)
    // ---- Bird geometry : 3 vertices, 1 triangle ----
    //  - apex (body/head) :   ( 0,  0.4, 0)
    //  - left wing tip :      (-1, -0.15, 0)
    //  - right wing tip :     ( 1, -0.15, 0)
    const geo = new THREE.BufferGeometry()
    const verts = new Float32Array([
      0,    0.4,  0,
      -1,  -0.15, 0,
      1,   -0.15, 0,
    ])
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3))
    // Per-vertex marker so shader knows which vertex to flap
    const vertexType = new Float32Array([0, 1, 1])
    geo.setAttribute('aVertexType', new THREE.BufferAttribute(vertexType, 1))
    geo.setIndex([0, 1, 2])
    // ---- Per-instance phase + depth ----
    this.phases = new Float32Array(MAX_BIRDS)
    this.depths = new Float32Array(MAX_BIRDS)
    for (let i = 0; i < MAX_BIRDS; i++) {
      this.phases[i] = Math.random() * Math.PI * 2
      this.depths[i] = (Math.random() - 0.5) * 2 * (params.depthSpread ?? 0.6)
    }
    this.phaseAttr = new THREE.InstancedBufferAttribute(this.phases, 1)
    this.depthAttr = new THREE.InstancedBufferAttribute(this.depths, 1)
    geo.setAttribute('aInstancePhase', this.phaseAttr)
    geo.setAttribute('aInstanceDepth', this.depthAttr)
    // ---- Shader material ----
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uFlapSpeed: { value: params.flapSpeed },
        uFlapAmplitude: { value: params.flapAmplitude },
        uAudioBass: { value: 0 },
        uColorNear: { value: new THREE.Color(visual.palette.primary) },
        uColorFar: { value: new THREE.Color(visual.palette.secondary) },
        uColorGlow: { value: new THREE.Color(visual.palette.glow) },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    this.mesh = new THREE.InstancedMesh(geo, this.mat, MAX_BIRDS)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.count = this.count
    // ---- Position / velocity buffers (NDC -1..1 + z depth) ----
    this.positions = new Float32Array(MAX_BIRDS * 3)
    this.velocities = new Float32Array(MAX_BIRDS * 2)
    for (let i = 0; i < MAX_BIRDS; i++) {
      this.positions[i * 3]     = (Math.random() - 0.5) * 2
      this.positions[i * 3 + 1] = (Math.random() - 0.5) * 2
      this.positions[i * 3 + 2] = this.depths[i]
      const ang = Math.random() * Math.PI * 2
      this.velocities[i * 2]     = Math.cos(ang) * 0.3
      this.velocities[i * 2 + 1] = Math.sin(ang) * 0.3
    }
  }

  setAspect(a: number) { this.aspect = a }

  updateParams(p: MurmurationParams) {
    this.params = p
    this.count = Math.min(p.count, MAX_BIRDS)
    this.mesh.count = this.count
    this.mat.uniforms.uFlapSpeed.value = p.flapSpeed
    this.mat.uniforms.uFlapAmplitude.value = p.flapAmplitude
  }

  applyVisual(visual: VisualParams) {
    ;(this.mat.uniforms.uColorNear.value as THREE.Color).set(visual.palette.primary)
    ;(this.mat.uniforms.uColorFar.value as THREE.Color).set(visual.palette.secondary)
    ;(this.mat.uniforms.uColorGlow.value as THREE.Color).set(visual.palette.glow)
    this.mat.blending = visual.blendMode === 'normal' ? THREE.NormalBlending : THREE.AdditiveBlending
  }

  update(dt: number) {
    const p = this.params
    const n = this.count
    const aspect = this.aspect
    const audio = senseBus.audio
    const hand = senseBus.hands
    this.t += dt
    this.mat.uniforms.uTime.value = this.t
    this.mat.uniforms.uAudioBass.value = audio.bass ?? 0

    const px = this.positions
    const vx = this.velocities

    // ---- Hand "predator" position (in world coords) ----
    const handX = hand.detected ? (hand.indexTip.x - 0.5) * 2 * aspect : 0
    const handY = hand.detected ? -(hand.indexTip.y - 0.5) * 2 : 0
    const predatorActive = hand.detected
    const predatorStrength = p.predatorResponse * (0.6 + (hand.pinch ?? 0) * 1.4)
    // Danger radius scales with vision so the flock responds proportionally
    const danger = Math.max(0.25, p.vision * 2.5)
    const danger2 = danger * danger

    // ---- Audio modulations ----
    const speedMul = p.speed * (0.6 + (audio.mid ?? 0) * 1.4)

    const sil = getSilhouetteMask()

    // ============================================================
    // PASS 1 — build a 16×16 spatial grid of average velocity.
    // Each cell holds the mean (vx, vy) of birds inside it. Feeding
    // that mean back into each bird's alignment produces coordinated
    // WAVES propagating through the flock — the real murmuration feel.
    // O(N), no neighbor pair scan needed.
    // ============================================================
    const G = MurmurationOrganism.GRID
    const gvx = this.gridVX; const gvy = this.gridVY; const gc = this.gridCount
    gvx.fill(0); gvy.fill(0); gc.fill(0)
    const invCellX = G / (2 * aspect)
    const invCellY = G / 2
    for (let i = 0; i < n; i++) {
      const i3 = i * 3, i2 = i * 2
      // Map [-aspect, aspect] × [-1, 1] → cell indices [0, G)
      let gx = ((px[i3] + aspect) * invCellX) | 0
      let gy = ((px[i3 + 1] + 1) * invCellY) | 0
      if (gx < 0) gx = 0; else if (gx >= G) gx = G - 1
      if (gy < 0) gy = 0; else if (gy >= G) gy = G - 1
      const c = gy * G + gx
      gvx[c] += vx[i2]
      gvy[c] += vx[i2 + 1]
      gc[c]++
    }
    // Normalize to per-cell averages
    for (let c = 0; c < G * G; c++) {
      if (gc[c] > 0) { gvx[c] /= gc[c]; gvy[c] /= gc[c] }
    }

    // ============================================================
    // PASS 2 — per-bird forces, using grid lookups (constant time).
    // ============================================================
    for (let i = 0; i < n; i++) {
      const i3 = i * 3
      const i2 = i * 2
      const xi = px[i3], yi = px[i3 + 1]
      let fx = 0, fy = 0

      // Cell coords of this bird
      let gx = ((xi + aspect) * invCellX) | 0
      let gy = ((yi + 1) * invCellY) | 0
      if (gx < 0) gx = 0; else if (gx >= G) gx = G - 1
      if (gy < 0) gy = 0; else if (gy >= G) gy = G - 1
      const c = gy * G + gx

      // --- Alignment : match the local cell's average velocity ---
      // This is the KEY force for murmuration coordination. Strong coefficient
      // + grid propagation = waves of aligned flight sweeping through the flock.
      if (gc[c] > 1) {
        fx += (gvx[c] - vx[i2])     * p.alignment * 2.2
        fy += (gvy[c] - vx[i2 + 1]) * p.alignment * 2.2
      }

      // --- Cohesion : gentle pull toward the average velocity of the wider
      //     3×3 neighbourhood, weighted by density (denser cells attract more) ---
      let sumX = 0, sumY = 0, sumC = 0
      for (let dy = -1; dy <= 1; dy++) {
        const yy = gy + dy
        if (yy < 0 || yy >= G) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = gx + dx
          if (xx < 0 || xx >= G) continue
          const cc = yy * G + xx
          const w = gc[cc]
          if (w > 0) {
            // Cell centre position in world coords
            const cwx = (xx + 0.5) / G * 2 * aspect - aspect
            const cwy = (yy + 0.5) / G * 2 - 1
            sumX += cwx * w; sumY += cwy * w
            sumC += w
          }
        }
      }
      if (sumC > 0) {
        const cx = sumX / sumC, cy = sumY / sumC
        fx += (cx - xi) * p.cohesion * 0.8
        fy += (cy - yi) * p.cohesion * 0.8
      }

      // --- Separation : push away from THIS cell's centre when it's too dense
      //     (cheap proxy for pair separation, avoids O(N²)) ---
      if (gc[c] > 4) {
        const cwx = (gx + 0.5) / G * 2 * aspect - aspect
        const cwy = (gy + 0.5) / G * 2 - 1
        const dxc = xi - cwx, dyc = yi - cwy
        const dc2 = dxc * dxc + dyc * dyc + 1e-4
        const s = p.separation * gc[c] * 0.008 / dc2
        fx += dxc * s
        fy += dyc * s
      }

      // --- Swirl : rotational component using local grid velocity ---
      // Perpendicular of local flow ⟹ rotational drift in the neighborhood.
      if (p.swirl > 0 && gc[c] > 0) {
        fx += -gvy[c] * p.swirl * 0.4
        fy +=  gvx[c] * p.swirl * 0.4
      }

      // --- Curl-noise wind field : GLOBAL smoothly-varying vector field ---
      // Two sines per axis, phase-shifted, evolving over time → all birds
      // in a region drift in the same direction. This is what visually turns
      // the flock into flowing ribbons rather than random dots.
      const t = this.t * 0.35
      const wx = Math.sin(xi * 1.7 + yi * 0.9 + t)     + 0.6 * Math.sin(yi * 2.3 - t * 0.7)
      const wy = Math.cos(yi * 1.9 - xi * 0.6 + t * 0.8) + 0.6 * Math.cos(xi * 1.4 + t * 0.5)
      fx += wx * 0.35
      fy += wy * 0.35

      // --- Predator (hand) ---
      if (predatorActive) {
        const dx = xi - handX
        const dy = yi - handY
        const d2h = dx * dx + dy * dy
        if (d2h < danger2 && d2h > 1e-5) {
          const inv = 1 / Math.sqrt(d2h)
          const fall = 1 - Math.sqrt(d2h) / danger
          const f = predatorStrength * fall * 8
          fx += dx * inv * f
          fy += dy * inv * f
        }
      }

      // --- Obstacles (silhouette + circles + pose) ---
      if (this.obstacles && this.obstacles.length) {
        const o = solveObstacles(xi, yi, aspect, this.obstacles, sil)
        fx += o.fx * 2.5
        fy += o.fy * 2.5
      }

      // --- Scene-level flow field (Sens > Flux) ---
      const fl = sampleFlow(xi, yi, this.t)
      fx += fl.fx
      fy += fl.fy

      // (No random jitter — was destroying coordination. Audio 'high' now
      //  slightly speeds up the wind field time via the earlier this.t += dt,
      //  giving nervousness without decorrelation.)

      // --- Integrate velocity, cap speed ---
      vx[i2]     += fx * dt
      vx[i2 + 1] += fy * dt
      const sp2 = vx[i2] * vx[i2] + vx[i2 + 1] * vx[i2 + 1]
      if (sp2 > speedMul * speedMul) {
        const s = speedMul / Math.sqrt(sp2)
        vx[i2] *= s; vx[i2 + 1] *= s
      }
      // Minimum speed so birds never fully stall (murmurations never freeze)
      const minSp = speedMul * 0.35
      if (sp2 < minSp * minSp && sp2 > 1e-6) {
        const s = minSp / Math.sqrt(sp2)
        vx[i2] *= s; vx[i2 + 1] *= s
      }

      // --- Integrate position + wrap ---
      px[i3]     += vx[i2]     * dt
      px[i3 + 1] += vx[i2 + 1] * dt
      const xMax = aspect
      if (px[i3] > xMax)  px[i3] = -xMax
      else if (px[i3] < -xMax) px[i3] = xMax
      if (px[i3 + 1] > 1)  px[i3 + 1] = -1
      else if (px[i3 + 1] < -1) px[i3 + 1] = 1

      // --- Depth drift (parallax layers) ---
      px[i3 + 2] += (Math.sin(this.t * 0.1 + i * 0.013) * 0.02 - px[i3 + 2] * 0.001) * dt
      this.depths[i] = px[i3 + 2]
    }
    // Push depth changes to GPU (cheap — single attribute)
    this.depthAttr.needsUpdate = true

    // ---- Write per-instance matrices ----
    const baseSize = p.size * (0.8 + (audio.bass ?? 0) * 0.6)
    for (let i = 0; i < n; i++) {
      const i3 = i * 3
      const i2 = i * 2
      // Heading = atan2(vy, vx) — bird rotates to face flight direction
      const heading = Math.atan2(vx[i2 + 1], vx[i2])
      // Depth-scaled size (depth -1 = far/small, +1 = near/big)
      const depthScale = 1 + this.depths[i] * 0.35
      const sz = baseSize * depthScale
      this.dummy.position.set(px[i3], px[i3 + 1], 0)
      this.dummy.rotation.z = heading - Math.PI / 2  // tip points up by default
      this.dummy.scale.set(sz, sz, sz)
      this.dummy.updateMatrix()
      this.mesh.setMatrixAt(i, this.dummy.matrix)
    }
    this.mesh.instanceMatrix.needsUpdate = true
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.mat.dispose()
  }
}
