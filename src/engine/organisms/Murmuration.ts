/**
 * Murmuration — TOPOLOGICAL flocking (Ballerini et al. 2008, PNAS / STARFLAG).
 *
 * Réf. : Ballerini, M. et al. (2008). "Interaction ruling animal collective
 *        behavior depends on topological rather than metric distance."
 *        PNAS 105(4), 1232-1237.
 *        + Hemelrijk & Hildenbrandt (2011) — variable shape of bird flocks.
 *        + Couzin, I. D. et al. (2002) — 3 zones (répulsion/alignement/attraction).
 *
 * Découverte clé : un étourneau interagit avec un NOMBRE FIXE de voisins
 * (~7 les plus proches), PAS avec tous ceux dans un rayon. C'est CE qui
 * produit la vraie murmuration :
 *   - Cohésion indépendante de la densité (le banc peut se disperser, se
 *     resserrer, changer de forme, se scinder — sans jamais se déliter).
 *   - Sous l'attaque d'un prédateur, un modèle métrique (rayon fixe) se
 *     FRAGMENTE en poussière ; un modèle topologique reste soudé et fait
 *     un demi-tour collectif (l'effet "volute" des vraies vidéos).
 *
 * Chaque oiseau, parmi ses K=7 plus proches voisins :
 *   - Séparation : s'écarte de ceux entrés dans sa sphère personnelle.
 *   - Alignement : copie leur cap moyen (les vagues se propagent de proche
 *     en proche → shimmer / agitation waves).
 *   - Cohésion   : se rapproche de leur centroïde.
 * + attraction faible vers le perchoir, swirl, répulsion des bords, prédateur.
 *
 * Règles physiques : turn-rate LIMITÉ (banking fluide, pas de flip instantané)
 * + vitesse quasi-constante (les vrais étourneaux gardent leur airspeed en virage).
 *
 * Perf / anti-crash : spatial hash À DENSITÉ ADAPTATIVE (taille de bin calée
 * pour ~2.5 oiseaux/bin quelle que soit la population) + PLAFOND DUR de
 * candidats scannés par oiseau (MAX_SCAN). Même si toute la nuée s'effondre
 * dans un seul bin, le travail reste O(N·MAX_SCAN) — jamais O(N²) (c'était la
 * cause du freeze/crash du modèle métrique précédent).
 *
 * Rendu : InstancedMesh triangles ailes, vertex shader anime le flap.
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
  cohesion: number          // 0..2 (poids attraction vers centroïde des voisins)
  separation: number        // 0..3 (poids répulsion sphère personnelle)
  alignment: number         // 0..3 (poids alignement cap moyen)
  swirl: number             // 0..2 — biais rotationnel autour du perchoir
  speed: number             // 0.1..3 — vitesse ~constante (NDC/s)
  vision: number            // 0.05..0.5 — échelle sphère personnelle / perchoir
  size: number              // 0.005..0.04
  flapSpeed: number         // 1..30 Hz
  flapAmplitude: number     // 0..1.2
  predatorResponse: number  // 0..3
  depthSpread: number       // 0..1
  trail: number             // 0.5..0.999
}

const VERT = `
  precision highp float;
  attribute float aVertexType;
  attribute float aInstancePhase;
  attribute float aInstanceDepth;
  uniform float uTime;
  uniform float uFlapSpeed;
  uniform float uFlapAmplitude;
  uniform float uAudioBass;
  varying float vWing;
  varying float vDepth;

  void main() {
    vec3 p = position;
    if (aVertexType > 0.5) {
      float amp = uFlapAmplitude * (1.0 + uAudioBass * 0.5);
      float flap = sin(uTime * uFlapSpeed + aInstancePhase);
      p.y += flap * amp;
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
    float t = (vDepth + 1.0) * 0.5;
    vec3 col = mix(uColorFar, uColorNear, t);
    col = mix(col, uColorGlow, vWing * 0.45);
    gl_FragColor = vec4(col, 0.95);
  }
`

// ------- Constants -------
const K_NEIGHBORS = 7          // topological interaction count (Ballerini ~6-7)
const MAX_SCAN = 64            // hard cap on candidates examined per bird (anti-freeze)
const TARGET_PER_BIN = 2.5     // density-adaptive hash targets this occupancy
const PERSONAL_FRAC = 0.5      // personal-space radius = vision * this
const MAX_TURN_PER_SEC = 4.5   // rad/s — cap on pivot speed (~260°/s), smooth banking
const ROOST_STRENGTH = 0.28    // gentle pull toward origin (keeps flock centered)
const EDGE_MARGIN = 0.15       // soft edge repulsion starts within this of the border
const EDGE_STRENGTH = 3.5
const MIN_SPEED_FRAC = 0.55    // never let a bird stall below this fraction of cruise

export class MurmurationOrganism {
  mesh: THREE.InstancedMesh
  positions: Float32Array        // stride 3 (x,y,z)
  velocities: Float32Array       // stride 2 (vx,vy)
  count: number = 0
  obstacles: Obstacle[] | undefined
  private params: MurmurationParams
  private mat: THREE.ShaderMaterial
  private dummy = new THREE.Object3D()
  private aspect = 1
  private t = 0
  private phases: Float32Array
  private depths: Float32Array
  private phaseAttr: THREE.InstancedBufferAttribute
  private depthAttr: THREE.InstancedBufferAttribute
  // Spatial hash — bin size density-adaptive. Rebuilt each frame.
  // Bins stored as plain number[] pooled across frames to avoid GC churn.
  private hashBins: (number[] | undefined)[] = []
  private hashCols = 0
  private hashRows = 0
  private hashSize = 0.2
  // Scratch for the K-nearest selection (reused every bird, never re-allocated)
  private knnIdx = new Int32Array(K_NEIGHBORS)
  private knnD2 = new Float32Array(K_NEIGHBORS)

  constructor(params: MurmurationParams, visual: VisualParams) {
    this.params = params
    this.count = Math.min(params.count, MAX_BIRDS)
    // Geometry : simple triangle (body apex + 2 wing tips)
    const geo = new THREE.BufferGeometry()
    const verts = new Float32Array([
      0,    0.4,  0,
      -1,  -0.15, 0,
      1,   -0.15, 0,
    ])
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3))
    const vertexType = new Float32Array([0, 1, 1])
    geo.setAttribute('aVertexType', new THREE.BufferAttribute(vertexType, 1))
    geo.setIndex([0, 1, 2])
    // Per-instance attributes (pre-allocated for MAX_BIRDS, reused frame-to-frame)
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
    // Shader material
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
    // Positions + velocities — start clustered near origin, random headings
    this.positions = new Float32Array(MAX_BIRDS * 3)
    this.velocities = new Float32Array(MAX_BIRDS * 2)
    for (let i = 0; i < MAX_BIRDS; i++) {
      const ang = Math.random() * Math.PI * 2
      const r = Math.sqrt(Math.random()) * 0.6
      this.positions[i * 3]     = Math.cos(ang) * r
      this.positions[i * 3 + 1] = Math.sin(ang) * r
      this.positions[i * 3 + 2] = this.depths[i]
      // Initial velocity tangent to origin (starts a natural swirl)
      const tang = ang + Math.PI / 2
      this.velocities[i * 2]     = Math.cos(tang) * params.speed
      this.velocities[i * 2 + 1] = Math.sin(tang) * params.speed
    }
  }

  setAspect(a: number) {
    this.aspect = a
  }

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

  // ==================================================================
  // Rebuild the spatial hash with a DENSITY-ADAPTIVE bin size.
  // We size bins so each holds ~TARGET_PER_BIN birds on average, no matter
  // how many birds there are or how spread out they are. That guarantees a
  // 3×3 neighbourhood always contains enough candidates to pick the K nearest
  // (topological model needs a variable metric radius — this delivers it) AND
  // keeps per-bird scan cost bounded.
  // ==================================================================
  private rebuildHash() {
    const n = this.count
    const worldWidth = 2 * this.aspect + 0.6
    const worldHeight = 2 + 0.6
    const area = worldWidth * worldHeight
    // binSize such that (area / binSize²) bins each hold ~TARGET_PER_BIN birds
    let binSize = Math.sqrt((area * TARGET_PER_BIN) / Math.max(1, n))
    // Clamp so we never explode the grid nor make it uselessly coarse
    binSize = Math.min(Math.max(binSize, 0.04), 0.6)
    this.hashSize = binSize
    const cols = Math.max(4, Math.min(256, Math.ceil(worldWidth / binSize)))
    const rows = Math.max(4, Math.min(256, Math.ceil(worldHeight / binSize)))
    if (cols !== this.hashCols || rows !== this.hashRows) {
      this.hashBins = new Array(cols * rows)
      this.hashCols = cols
      this.hashRows = rows
    }
    // Clear bins — reuse the pooled arrays
    const bins = this.hashBins
    for (let i = 0; i < bins.length; i++) {
      const b = bins[i]
      if (b) b.length = 0
    }
    const px = this.positions
    const invBin = 1 / binSize
    const originX = -this.aspect - 0.3
    const originY = -1 - 0.3
    for (let i = 0; i < n; i++) {
      const x = px[i * 3]
      const y = px[i * 3 + 1]
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      let cx = ((x - originX) * invBin) | 0
      let cy = ((y - originY) * invBin) | 0
      if (cx < 0) cx = 0; else if (cx >= cols) cx = cols - 1
      if (cy < 0) cy = 0; else if (cy >= rows) cy = rows - 1
      const idx = cy * cols + cx
      let bin = bins[idx]
      if (!bin) { bin = []; bins[idx] = bin }
      bin.push(i)
    }
  }

  update(dt: number) {
    const p = this.params
    const n = this.count
    if (n === 0) return
    const aspect = this.aspect
    const audio = senseBus.audio
    const hand = senseBus.hands
    this.t += dt
    this.mat.uniforms.uTime.value = this.t
    this.mat.uniforms.uAudioBass.value = audio.bass ?? 0

    // Cap dt to avoid huge jumps on tab-return (real dt can spike to 3s)
    const cdt = Math.min(dt, 1 / 30)

    const px = this.positions
    const vx = this.velocities

    // Personal-space radius (metric, but only tested against the K nearest —
    // so it stays bounded and never triggers an O(N²) scan).
    const personal = Math.max(0.03, p.vision * PERSONAL_FRAC)

    // ---- Predator (hand) ----
    const handX = hand.detected ? (hand.indexTip.x - 0.5) * 2 * aspect : 0
    const handY = hand.detected ? -(hand.indexTip.y - 0.5) * 2 : 0
    const predatorActive = hand.detected
    const predatorStrength = p.predatorResponse * (0.6 + (hand.pinch ?? 0) * 1.4)
    const danger = Math.max(0.25, p.vision * 2.5)
    const danger2 = danger * danger

    // ---- Audio ----
    // Speed quasi-constant (real starlings hold airspeed). Audio.mid boosts +20% max.
    const cruiseSpeed = p.speed * (0.85 + (audio.mid ?? 0) * 0.2)
    const minSpeed = cruiseSpeed * MIN_SPEED_FRAC
    // Audio.high tightens the turn cap → nervous flock reacts faster
    const maxTurn = MAX_TURN_PER_SEC * (1 + (audio.high ?? 0) * 1.2)

    const sil = getSilhouetteMask()

    // Rebuild density-adaptive spatial hash for this frame
    this.rebuildHash()
    const bins = this.hashBins
    const cols = this.hashCols
    const rows = this.hashRows
    const invBin = 1 / this.hashSize
    const originX = -aspect - 0.3
    const originY = -1 - 0.3
    const knnIdx = this.knnIdx
    const knnD2 = this.knnD2

    // ==================================================================
    // Main per-bird update — TOPOLOGICAL K-nearest + turn-rate limit.
    // ==================================================================
    for (let i = 0; i < n; i++) {
      const i3 = i * 3
      const i2 = i * 2
      const xi = px[i3]
      const yi = px[i3 + 1]
      const vxi = vx[i2]
      const vyi = vx[i2 + 1]

      // Guard : NaN → re-seed near origin (defensive, self-healing)
      if (!Number.isFinite(xi) || !Number.isFinite(yi) || !Number.isFinite(vxi) || !Number.isFinite(vyi)) {
        px[i3] = (Math.random() - 0.5) * 0.4
        px[i3 + 1] = (Math.random() - 0.5) * 0.4
        vx[i2] = cruiseSpeed
        vx[i2 + 1] = 0
        continue
      }

      let cxb = ((xi - originX) * invBin) | 0
      let cyb = ((yi - originY) * invBin) | 0
      if (cxb < 0) cxb = 0; else if (cxb >= cols) cxb = cols - 1
      if (cyb < 0) cyb = 0; else if (cyb >= rows) cyb = rows - 1

      // --- Collect the K nearest neighbours (topological), scanning 3×3 bins.
      //     Hard MAX_SCAN cap makes this O(1) per bird even if a bin is packed. ---
      let knnCount = 0
      let worstPos = 0        // index in knn arrays holding the current largest d²
      let worstD2 = Infinity
      let scanned = 0

      for (let dy = -1; dy <= 1 && scanned < MAX_SCAN; dy++) {
        const ry = cyb + dy
        if (ry < 0 || ry >= rows) continue
        const rowBase = ry * cols
        for (let dx = -1; dx <= 1 && scanned < MAX_SCAN; dx++) {
          const rx = cxb + dx
          if (rx < 0 || rx >= cols) continue
          const bin = bins[rowBase + rx]
          if (!bin || bin.length === 0) continue
          for (let k = 0; k < bin.length; k++) {
            if (scanned >= MAX_SCAN) break
            const j = bin[k]
            if (j === i) continue
            scanned++
            const ddx = px[j * 3] - xi
            const ddy = px[j * 3 + 1] - yi
            const d2 = ddx * ddx + ddy * ddy
            if (d2 < 1e-9) continue
            if (knnCount < K_NEIGHBORS) {
              knnIdx[knnCount] = j
              knnD2[knnCount] = d2
              knnCount++
              if (knnCount === K_NEIGHBORS) {
                // Find the current worst once the buffer is full
                worstD2 = -1
                for (let m = 0; m < K_NEIGHBORS; m++) {
                  if (knnD2[m] > worstD2) { worstD2 = knnD2[m]; worstPos = m }
                }
              }
            } else if (d2 < worstD2) {
              // Replace the worst, then rescan for the new worst
              knnIdx[worstPos] = j
              knnD2[worstPos] = d2
              worstD2 = -1
              for (let m = 0; m < K_NEIGHBORS; m++) {
                if (knnD2[m] > worstD2) { worstD2 = knnD2[m]; worstPos = m }
              }
            }
          }
        }
      }

      // --- Accumulate the 3 topological rules over the K nearest ---
      let sepX = 0, sepY = 0
      let alignX = 0, alignY = 0
      let cohX = 0, cohY = 0
      const personal2 = personal * personal
      for (let m = 0; m < knnCount; m++) {
        const j = knnIdx[m]
        const j3 = j * 3
        const ddx = px[j3] - xi
        const ddy = px[j3 + 1] - yi
        const d2 = knnD2[m]
        // Cohesion → toward each neighbour (summed then normalised = toward centroid)
        cohX += ddx
        cohY += ddy
        // Alignment → sum unit headings
        const jvx = vx[j * 2], jvy = vx[j * 2 + 1]
        const js = Math.sqrt(jvx * jvx + jvy * jvy)
        if (js > 1e-5) { alignX += jvx / js; alignY += jvy / js }
        // Separation → push away from any neighbour inside personal space
        if (d2 < personal2) {
          const d = Math.sqrt(d2)
          const w = (personal - d) / personal   // 0 at edge → 1 at contact
          const inv = 1 / d
          sepX -= ddx * inv * w
          sepY -= ddy * inv * w
        }
      }

      // Compose the desired steering direction
      let dirX = 0, dirY = 0
      if (knnCount > 0) {
        // Separation has priority weight — keeps the flock from collapsing
        dirX += sepX * p.separation * 1.6
        dirY += sepY * p.separation * 1.6
        // Alignment (this is what propagates waves through the flock)
        const am = Math.sqrt(alignX * alignX + alignY * alignY)
        if (am > 1e-5) {
          dirX += (alignX / am) * p.alignment
          dirY += (alignY / am) * p.alignment
        }
        // Cohesion toward the local centroid
        const cm = Math.sqrt(cohX * cohX + cohY * cohY)
        if (cm > 1e-5) {
          dirX += (cohX / cm) * p.cohesion
          dirY += (cohY / cm) * p.cohesion
        }
      }

      // --- Roost attractor : gentle pull toward origin (keeps flock centred) ---
      const rDistX = -xi
      const rDistY = -yi
      const rDist = Math.sqrt(rDistX * rDistX + rDistY * rDistY)
      if (rDist > 0.3) {
        const rInv = 1 / rDist
        const roostF = ROOST_STRENGTH * Math.min(1, (rDist - 0.3) / 0.7)
        dirX += rDistX * rInv * roostF
        dirY += rDistY * rInv * roostF
      }

      // --- Swirl : tangential component of the roost pull → orbital signature ---
      if (p.swirl > 0 && rDist > 0.1) {
        const rInv = 1 / rDist
        dirX += -rDistY * rInv * p.swirl * 0.3
        dirY +=  rDistX * rInv * p.swirl * 0.3
      }

      // --- Soft edge repulsion — nudge back toward the visible area ---
      const xMax = aspect - EDGE_MARGIN
      const yMax = 1 - EDGE_MARGIN
      if (xi > xMax)  dirX -= EDGE_STRENGTH * (xi - xMax)
      if (xi < -xMax) dirX -= EDGE_STRENGTH * (xi + xMax)
      if (yi > yMax)  dirY -= EDGE_STRENGTH * (yi - yMax)
      if (yi < -yMax) dirY -= EDGE_STRENGTH * (yi + yMax)

      // --- Predator (hand) — collective flee ---
      if (predatorActive) {
        const hdx = xi - handX
        const hdy = yi - handY
        const hd2 = hdx * hdx + hdy * hdy
        if (hd2 < danger2 && hd2 > 1e-5) {
          const hInv = 1 / Math.sqrt(hd2)
          const fall = 1 - Math.sqrt(hd2) / danger
          const f = predatorStrength * fall * 6
          dirX += hdx * hInv * f
          dirY += hdy * hInv * f
        }
      }

      // --- Obstacles ---
      if (this.obstacles && this.obstacles.length) {
        const o = solveObstacles(xi, yi, aspect, this.obstacles, sil)
        dirX += o.fx * 2.5
        dirY += o.fy * 2.5
      }

      // --- Scene flow field ---
      const fl = sampleFlow(xi, yi, this.t)
      dirX += fl.fx * 0.5
      dirY += fl.fy * 0.5

      // Desired unit direction (fallback : keep current heading)
      const dirMag = Math.sqrt(dirX * dirX + dirY * dirY)
      let desiredX: number, desiredY: number
      if (dirMag > 1e-4) {
        desiredX = dirX / dirMag
        desiredY = dirY / dirMag
      } else {
        const curSp = Math.sqrt(vxi * vxi + vyi * vyi)
        if (curSp > 1e-4) { desiredX = vxi / curSp; desiredY = vyi / curSp }
        else { desiredX = 1; desiredY = 0 }
      }

      // === TURN-RATE LIMIT ===
      // Rotate current heading toward desired by at most maxTurn·dt this frame.
      // This is what makes birds BANK smoothly instead of teleport-flipping —
      // the signature of real flocking, and the source of the shimmer waves.
      const curSpeed = Math.max(1e-4, Math.sqrt(vxi * vxi + vyi * vyi))
      const curDirX = vxi / curSpeed
      const curDirY = vyi / curSpeed
      let dot = curDirX * desiredX + curDirY * desiredY
      if (dot > 1) dot = 1; else if (dot < -1) dot = -1
      const angle = Math.acos(dot)
      const maxStep = maxTurn * cdt
      let newDirX = desiredX
      let newDirY = desiredY
      if (angle > maxStep) {
        const cross = curDirX * desiredY - curDirY * desiredX
        const sign = cross >= 0 ? 1 : -1
        const s = Math.sin(maxStep * sign)
        const c = Math.cos(maxStep)
        newDirX = curDirX * c - curDirY * s
        newDirY = curDirX * s + curDirY * c
      }

      // Constant-speed integration (with a floor so birds never stall)
      const spd = Math.max(minSpeed, cruiseSpeed)
      vx[i2]     = newDirX * spd
      vx[i2 + 1] = newDirY * spd

      px[i3]     = xi + vx[i2]     * cdt
      px[i3 + 1] = yi + vx[i2 + 1] * cdt

      // NaN guard on output
      if (!Number.isFinite(px[i3]) || !Number.isFinite(px[i3 + 1])) {
        px[i3] = 0; px[i3 + 1] = 0
        vx[i2] = cruiseSpeed; vx[i2 + 1] = 0
      }

      // --- Depth drift ---
      px[i3 + 2] += (Math.sin(this.t * 0.1 + i * 0.013) * 0.02 - px[i3 + 2] * 0.001) * cdt
      this.depths[i] = px[i3 + 2]
    }
    this.depthAttr.needsUpdate = true

    // ==================================================================
    // Write per-instance matrices
    // ==================================================================
    const baseSize = p.size * (0.8 + (audio.bass ?? 0) * 0.6)
    for (let i = 0; i < n; i++) {
      const i3 = i * 3
      const i2 = i * 2
      const heading = Math.atan2(vx[i2 + 1], vx[i2])
      const depthScale = 1 + this.depths[i] * 0.35
      const sz = baseSize * depthScale
      this.dummy.position.set(px[i3], px[i3 + 1], 0)
      this.dummy.rotation.z = heading - Math.PI / 2
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
