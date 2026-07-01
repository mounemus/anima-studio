/**
 * MurmurationGPU — flocking « continuum » sur GPU, passe à 100 000+ oiseaux.
 *
 * Le modèle topologique CPU ([[Murmuration.ts]]) plafonne vers 8000 (coût CPU).
 * Ici tout l'état vit dans des textures et la simulation est un shader → O(N)
 * sur le GPU, indépendant du CPU.
 *
 * État : une texture RGBA half-float, 1 texel = 1 oiseau. RG = position (monde),
 * BA = vitesse. Ping-pong stateA/stateB.
 *
 * 3 passes par frame :
 *   1) CHAMP — on « scatter » tous les oiseaux en points additifs dans une petite
 *      RT (fieldRes²). rg = somme des vitesses, b = densité (compte). Filtrage
 *      LINÉAIRE → échantillonnage bilinéaire lisse (pas d'artefact de grille).
 *   2) SIM — pour chaque oiseau : alignement sur la vitesse moyenne locale
 *      (champ), cohésion = remontée du gradient de densité, séparation = descente
 *      du gradient local, + vent curl cohérent + perchoir + swirl + bords +
 *      prédateur (main). Puis limite de rotation (banking) + vitesse ~constante.
 *   3) RENDU — InstancedMesh de triangles ; le vertex shader lit l'état de
 *      l'oiseau dans la texture (vertex texture fetch) et le place + oriente +
 *      anime le battement d'ailes.
 *
 * C'est une approximation SPH/continuum du flocking : cohérente, scalable, et
 * les curseurs Alignement / Cohésion / Séparation restent parlants.
 */
import * as THREE from 'three'
import type { VisualParams, Obstacle } from '../../types/scene'
import { senseBus } from '../../senses/SenseBus'
import { OBSTACLE_GLSL, makeObstacleUniforms, packObstacles } from '../GPUObstacles'
import { edgeCode } from './BoidsGPU'

export interface MurmurationParams {
  count: number
  cohesion: number
  separation: number
  alignment: number
  swirl: number
  speed: number
  vision: number
  size: number
  flapSpeed: number
  flapAmplitude: number
  predatorResponse: number
  depthSpread: number
  trail: number
  edges?: 'wrap' | 'wall' | 'free'
}

const MAX_BIRDS = 262144      // 512×512 texture cap
const FIELD_RES = 128         // velocity+density field resolution

// ---- Shared GLSL helpers ----
const CURL = `
  // Cheap coherent regional flow (approx curl) — birds in the same area drift
  // together, giving the flowing-ribbon signature without true neighbour cost.
  vec2 curlWind(vec2 p, float t) {
    float s = 1.25;
    float a = sin(p.x * s + t * 0.31) + cos(p.y * s * 0.8 - t * 0.24);
    float b = cos(p.x * s * 0.73 - t * 0.21) + sin(p.y * s + t * 0.27);
    return vec2(a, b) * 0.5;
  }
`

// ---- Full-screen quad vertex (sim + seed) ----
const QUAD_VERT = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
`

// ---- Seed shader : writes initial pos/vel from the texel (agent) index ----
const SEED_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform float uTexDim;
  uniform float uAspect;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    float h1 = hash(vUv);
    float h2 = hash(vUv + 3.17);
    float ang = h1 * 6.2831853;
    float r = sqrt(h2) * 0.6 * uAspect;
    vec2 pos = vec2(cos(ang) * r, sin(ang) * r * (1.0 / max(uAspect, 0.001)));
    // tangential initial velocity → natural swirl
    vec2 vel = vec2(cos(ang + 1.5708), sin(ang + 1.5708)) * 0.6;
    gl_FragColor = vec4(pos, vel);
  }
`

// ---- Field scatter : point per bird, additive into (sumVel.xy, count) ----
const FIELD_VERT = `
  precision highp float;
  attribute float aIndex;
  uniform sampler2D uState;
  uniform float uTexDim;
  uniform float uAspect;
  uniform float uCount;
  uniform float uPointSize;
  varying vec2 vVel;
  varying float vActive;
  void main() {
    if (aIndex >= uCount) { vActive = 0.0; gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
    vActive = 1.0;
    float u = (mod(aIndex, uTexDim) + 0.5) / uTexDim;
    float v = (floor(aIndex / uTexDim) + 0.5) / uTexDim;
    vec4 st = texture2D(uState, vec2(u, v));
    vVel = st.zw;
    // world → field clip space [-1,1] (x normalised by aspect so the square fills)
    vec2 f = vec2(st.x / uAspect, st.y);
    gl_Position = vec4(f, 0.0, 1.0);
    gl_PointSize = uPointSize;
  }
`
const FIELD_FRAG = `
  precision highp float;
  varying vec2 vVel;
  varying float vActive;
  void main() {
    if (vActive < 0.5) discard;
    gl_FragColor = vec4(vVel, 1.0, 1.0);   // rg = velocity, b = 1 (count)
  }
`

// ---- Sim pass ----
const SIM_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uPrev;
  uniform sampler2D uField;
  uniform float uTexDim;
  uniform float uCount;
  uniform float uAspect;
  uniform float uTime;
  uniform float uDt;
  uniform float uAlign;
  uniform float uCohesion;
  uniform float uSeparation;
  uniform float uSwirl;
  uniform float uSpeed;
  uniform float uMaxTurn;
  uniform float uFieldRes;
  uniform vec2  uHand;
  uniform float uHandActive;
  uniform float uPredator;
  uniform float uDanger;
  uniform float uEdge;
  ${CURL}
  ${OBSTACLE_GLSL}

  vec2 worldToFieldUv(vec2 w) { return vec2(w.x / uAspect, w.y) * 0.5 + 0.5; }
  vec4 fieldAt(vec2 w) { return texture2D(uField, worldToFieldUv(w)); }

  void main() {
    float col = floor(vUv.x * uTexDim);
    float row = floor(vUv.y * uTexDim);
    float idx = row * uTexDim + col;
    vec4 st = texture2D(uPrev, vUv);
    vec2 pos = st.xy;
    vec2 vel = st.zw;

    // Park inactive texels far away (never drawn, never in field)
    if (idx >= uCount) { gl_FragColor = vec4(999.0, 999.0, 0.0, 0.0); return; }
    // NaN / runaway guard → reseed near origin
    if (!(pos.x == pos.x) || !(pos.y == pos.y) || abs(pos.x) > 50.0 || abs(pos.y) > 50.0) {
      gl_FragColor = vec4(0.0, 0.0, uSpeed, 0.0); return;
    }

    vec4 fc = fieldAt(pos);
    float dens = max(fc.b, 1.0);
    vec2 avgVel = fc.rg / dens;

    // density gradient (central differences on the count channel)
    float e = 1.5 / uFieldRes * uAspect * 2.0;   // world-space step ~1.5 field texels
    float dR = fieldAt(pos + vec2(e, 0.0)).b;
    float dL = fieldAt(pos - vec2(e, 0.0)).b;
    float dU = fieldAt(pos + vec2(0.0, e)).b;
    float dD = fieldAt(pos - vec2(0.0, e)).b;
    vec2 gradDens = vec2(dR - dL, dU - dD);

    vec2 dir = vec2(0.0);

    // Alignment — match the local mean heading (waves propagate through this)
    float am = length(avgVel);
    if (am > 1e-4) dir += (avgVel / am) * uAlign;

    // Cohesion — climb toward denser neighbourhood (topological-like: pull to flock)
    float gm = length(gradDens);
    if (gm > 1e-4) dir += (gradDens / gm) * uCohesion * 0.9;

    // Separation — push down the local density (anti-collision), stronger up close
    if (gm > 1e-4) dir -= (gradDens / gm) * uSeparation * (0.25 + dens * 0.02);

    // Roost attractor — gentle pull to origin so the flock stays framed
    float rDist = length(pos);
    if (rDist > 0.3) {
      float roostF = 0.28 * min(1.0, (rDist - 0.3) / 0.7);
      dir += (-pos / rDist) * roostF;
    }
    // Swirl — tangential component → orbital vortex signature
    if (uSwirl > 0.0 && rDist > 0.1) {
      dir += vec2(-(-pos.y), (-pos.x)) / rDist * 0.0; // no-op placeholder (kept explicit)
      dir += vec2(pos.y, -pos.x) / rDist * uSwirl * 0.3;
    }
    // Coherent wind
    dir += curlWind(pos, uTime) * 0.28;

    // Soft edge repulsion — only in 'wall' mode (uEdge==1)
    if (uEdge > 0.5 && uEdge < 1.5) {
      float xMax = uAspect - 0.15;
      if (pos.x >  xMax) dir.x -= 3.5 * (pos.x - xMax);
      if (pos.x < -xMax) dir.x -= 3.5 * (pos.x + xMax);
      if (pos.y >  0.85) dir.y -= 3.5 * (pos.y - 0.85);
      if (pos.y < -0.85) dir.y -= 3.5 * (pos.y + 0.85);
    }

    // Predator (hand) — collective flee
    if (uHandActive > 0.5) {
      vec2 hd = pos - uHand;
      float hd2 = dot(hd, hd);
      if (hd2 < uDanger * uDanger && hd2 > 1e-5) {
        float d = sqrt(hd2);
        float fall = 1.0 - d / uDanger;
        dir += (hd / d) * uPredator * fall * 6.0;
      }
    }

    // Physical obstacles (circles/polygon) + map-zone walls
    float _kill; vec2 _of = obstacleForce(pos, _kill);
    if (_kill > 0.5) { gl_FragColor = vec4(0.0, 0.0, uSpeed, 0.0); return; }
    dir += _of * 2.5;

    // Desired unit direction (fallback : keep current heading)
    float dm = length(dir);
    vec2 desired;
    if (dm > 1e-4) desired = dir / dm;
    else { float sp = length(vel); desired = sp > 1e-4 ? vel / sp : vec2(1.0, 0.0); }

    // Turn-rate limit → smooth banking
    float cs = max(1e-4, length(vel));
    vec2 cur = vel / cs;
    float dt2 = clamp(dot(cur, desired), -1.0, 1.0);
    float angle = acos(dt2);
    float maxStep = uMaxTurn * uDt;
    vec2 nd = desired;
    if (angle > maxStep) {
      float cross = cur.x * desired.y - cur.y * desired.x;
      float sgn = cross >= 0.0 ? 1.0 : -1.0;
      float sA = sin(maxStep * sgn);
      float cA = cos(maxStep);
      nd = vec2(cur.x * cA - cur.y * sA, cur.x * sA + cur.y * cA);
    }
    vec2 nvel = nd * uSpeed;
    vec2 npos = pos + nvel * uDt;
    // Toroidal wrap in 'wrap' mode (uEdge==0); wall repulsion handled above; free = nothing.
    if (uEdge < 0.5) {
      float ax = uAspect;
      if (npos.x >  ax) npos.x -= 2.0 * ax; else if (npos.x < -ax) npos.x += 2.0 * ax;
      if (npos.y >  1.0) npos.y -= 2.0;     else if (npos.y < -1.0) npos.y += 2.0;
    }
    gl_FragColor = vec4(npos, nvel);
  }
`

// ---- Render (instanced birds) ----
const RENDER_VERT = `
  precision highp float;
  attribute float aIndex;
  attribute float aVertexType;
  uniform sampler2D uState;
  uniform float uTexDim;
  uniform float uSize;
  uniform float uTime;
  uniform float uFlapSpeed;
  uniform float uFlapAmplitude;
  uniform float uAudioBass;
  uniform float uDepthSpread;
  varying float vWing;
  varying float vDepth;
  void main() {
    float u = (mod(aIndex, uTexDim) + 0.5) / uTexDim;
    float vv = (floor(aIndex / uTexDim) + 0.5) / uTexDim;
    vec4 st = texture2D(uState, vec2(u, vv));
    vec2 wpos = st.xy;
    vec2 vel = st.zw;
    float heading = atan(vel.y, vel.x);

    // pseudo-depth from index → parallax in size + colour
    float depth = (fract(sin(aIndex * 12.9898) * 43758.5453) - 0.5) * 2.0 * uDepthSpread;
    vDepth = depth;

    vec3 p = position;
    if (aVertexType > 0.5) {
      float amp = uFlapAmplitude * (1.0 + uAudioBass * 0.5);
      float flap = sin(uTime * uFlapSpeed + aIndex * 0.7);
      p.y += flap * amp;
      p.z += abs(flap) * 0.1 * amp;
      vWing = abs(flap);
    } else {
      vWing = 0.0;
    }
    float sz = uSize * (1.0 + depth * 0.35);
    p.xy *= sz;
    float a = heading - 1.5707963;
    float ca = cos(a), sa = sin(a);
    vec2 rp = vec2(p.x * ca - p.y * sa, p.x * sa + p.y * ca);
    vec2 world = wpos + rp;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 0.0, 1.0);
  }
`
const RENDER_FRAG = `
  precision highp float;
  uniform vec3 uColorNear;
  uniform vec3 uColorFar;
  uniform vec3 uColorGlow;
  uniform float uAlpha;
  varying float vWing;
  varying float vDepth;
  void main() {
    float t = (vDepth + 1.0) * 0.5;
    vec3 col = mix(uColorFar, uColorNear, t);
    col = mix(col, uColorGlow, vWing * 0.45);
    gl_FragColor = vec4(col, uAlpha);
  }
`

export class MurmurationGPUOrganism {
  mesh: THREE.Mesh
  count = 0
  obstacles: Obstacle[] | undefined
  mapBounds: [number, number, number, number] | null = null
  renderer: THREE.WebGLRenderer | null = null

  private params: MurmurationParams
  private aspect = 1
  private t = 0
  private texDim = 64
  private stateA: THREE.WebGLRenderTarget
  private stateB: THREE.WebGLRenderTarget
  private current: THREE.WebGLRenderTarget
  private fieldRT: THREE.WebGLRenderTarget
  private simMat: THREE.ShaderMaterial
  private fieldMat: THREE.ShaderMaterial
  private renderMat: THREE.ShaderMaterial
  private simScene = new THREE.Scene()
  private simCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private fullQuad: THREE.Mesh
  private fieldScene = new THREE.Scene()
  private fieldPoints: THREE.Points
  private _seeded = false

  constructor(params: MurmurationParams, visual: VisualParams) {
    this.params = params
    this.count = Math.min(Math.max(1, params.count | 0), MAX_BIRDS)
    this.texDim = this.pickTexDim(this.count)

    const rtOpts: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: false, stencilBuffer: false,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
    }
    this.stateA = new THREE.WebGLRenderTarget(this.texDim, this.texDim, rtOpts)
    this.stateB = new THREE.WebGLRenderTarget(this.texDim, this.texDim, rtOpts)
    this.current = this.stateA

    this.fieldRT = new THREE.WebGLRenderTarget(FIELD_RES, FIELD_RES, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
    })

    // Sim quad
    this.simMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT, fragmentShader: SIM_FRAG,
      uniforms: {
        uPrev: { value: this.stateA.texture },
        uField: { value: this.fieldRT.texture },
        uTexDim: { value: this.texDim },
        uCount: { value: this.count },
        uAspect: { value: this.aspect },
        uTime: { value: 0 },
        uDt: { value: 1 / 60 },
        uAlign: { value: params.alignment },
        uCohesion: { value: params.cohesion },
        uSeparation: { value: params.separation },
        uSwirl: { value: params.swirl },
        uSpeed: { value: params.speed },
        uMaxTurn: { value: 4.5 },
        uFieldRes: { value: FIELD_RES },
        uHand: { value: new THREE.Vector2(0, 0) },
        uHandActive: { value: 0 },
        uPredator: { value: params.predatorResponse },
        uDanger: { value: 0.4 },
        uEdge: { value: edgeCode(params.edges ?? 'wall') },
        ...makeObstacleUniforms(),
      },
      depthTest: false, depthWrite: false,
    })
    this.fullQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.simMat)
    this.simScene.add(this.fullQuad)

    // Field scatter points (one per bird slot). aIndex 0..texDim²-1
    const slots = this.texDim * this.texDim
    const indices = new Float32Array(slots)
    for (let i = 0; i < slots; i++) indices[i] = i
    const fieldGeo = new THREE.BufferGeometry()
    fieldGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(slots * 3), 3))
    fieldGeo.setAttribute('aIndex', new THREE.BufferAttribute(indices, 1))
    this.fieldMat = new THREE.ShaderMaterial({
      vertexShader: FIELD_VERT, fragmentShader: FIELD_FRAG,
      uniforms: {
        uState: { value: this.stateA.texture },
        uTexDim: { value: this.texDim },
        uAspect: { value: this.aspect },
        uCount: { value: this.count },
        uPointSize: { value: 3 },
      },
      transparent: true, blending: THREE.AdditiveBlending,
      depthTest: false, depthWrite: false,
    })
    this.fieldPoints = new THREE.Points(fieldGeo, this.fieldMat)
    this.fieldPoints.frustumCulled = false
    this.fieldScene.add(this.fieldPoints)

    // Render mesh — triangle bird, instanced. Vertex shader reads state texture.
    const triGeo = new THREE.BufferGeometry()
    triGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      0, 0.4, 0, -1, -0.15, 0, 1, -0.15, 0,
    ]), 3))
    triGeo.setAttribute('aVertexType', new THREE.BufferAttribute(new Float32Array([0, 1, 1]), 1))
    triGeo.setIndex([0, 1, 2])
    const instGeo = new THREE.InstancedBufferGeometry()
    instGeo.index = triGeo.index
    instGeo.attributes.position = triGeo.attributes.position
    instGeo.attributes.aVertexType = triGeo.attributes.aVertexType
    instGeo.setAttribute('aIndex', new THREE.InstancedBufferAttribute(indices, 1))
    instGeo.instanceCount = this.count

    this.renderMat = new THREE.ShaderMaterial({
      vertexShader: RENDER_VERT, fragmentShader: RENDER_FRAG,
      uniforms: {
        uState: { value: this.stateA.texture },
        uTexDim: { value: this.texDim },
        uSize: { value: params.size },
        uTime: { value: 0 },
        uFlapSpeed: { value: params.flapSpeed },
        uFlapAmplitude: { value: params.flapAmplitude },
        uAudioBass: { value: 0 },
        uDepthSpread: { value: params.depthSpread ?? 0.6 },
        uColorNear: { value: new THREE.Color(visual.palette.primary) },
        uColorFar: { value: new THREE.Color(visual.palette.secondary) },
        uColorGlow: { value: new THREE.Color(visual.palette.glow) },
        uAlpha: { value: 0.95 },
      },
      transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide,
    })
    // Plain Mesh + InstancedBufferGeometry: three issues an instanced draw with
    // instanceCount birds. Positions come from the state texture in the vertex
    // shader, so no instanceMatrix buffer is needed. frustumCulled off (the
    // geometry bounding sphere is meaningless — real positions live on the GPU).
    this.mesh = new THREE.Mesh(instGeo, this.renderMat)
    this.mesh.frustumCulled = false
  }

  private pickTexDim(count: number): number {
    let d = 16
    while (d * d < count && d < 512) d *= 2
    return d
  }

  setAspect(a: number) {
    this.aspect = a
    this.simMat.uniforms.uAspect.value = a
    this.fieldMat.uniforms.uAspect.value = a
  }

  updateParams(p: MurmurationParams) {
    const newCount = Math.min(Math.max(1, p.count | 0), MAX_BIRDS)
    const newDim = this.pickTexDim(newCount)
    if (newDim !== this.texDim) {
      // Texture grid must grow/shrink — reallocate + reseed on next frame.
      this.texDim = newDim
      this.stateA.setSize(newDim, newDim)
      this.stateB.setSize(newDim, newDim)
      this.rebuildIndexAttributes()
      this.simMat.uniforms.uTexDim.value = newDim
      this.fieldMat.uniforms.uTexDim.value = newDim
      this.renderMat.uniforms.uTexDim.value = newDim
      this._seeded = false
    }
    this.count = newCount
    ;(this.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = newCount
    this.params = p
    this.simMat.uniforms.uCount.value = newCount
    this.simMat.uniforms.uAlign.value = p.alignment
    this.simMat.uniforms.uCohesion.value = p.cohesion
    this.simMat.uniforms.uSeparation.value = p.separation
    this.simMat.uniforms.uSwirl.value = p.swirl
    this.simMat.uniforms.uSpeed.value = p.speed
    this.simMat.uniforms.uPredator.value = p.predatorResponse
    this.simMat.uniforms.uDanger.value = Math.max(0.25, p.vision * 2.5)
    this.simMat.uniforms.uEdge.value = edgeCode(p.edges ?? 'wall')
    this.fieldMat.uniforms.uCount.value = newCount
    this.renderMat.uniforms.uSize.value = p.size
    this.renderMat.uniforms.uFlapSpeed.value = p.flapSpeed
    this.renderMat.uniforms.uFlapAmplitude.value = p.flapAmplitude
    this.renderMat.uniforms.uDepthSpread.value = p.depthSpread ?? 0.6
  }

  private rebuildIndexAttributes() {
    const slots = this.texDim * this.texDim
    const indices = new Float32Array(slots)
    for (let i = 0; i < slots; i++) indices[i] = i
    // Field points
    const fg = this.fieldPoints.geometry
    fg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(slots * 3), 3))
    fg.setAttribute('aIndex', new THREE.BufferAttribute(indices, 1))
    // Render instances
    const ig = this.mesh.geometry as THREE.InstancedBufferGeometry
    ig.setAttribute('aIndex', new THREE.InstancedBufferAttribute(indices, 1))
  }

  applyVisual(visual: VisualParams) {
    ;(this.renderMat.uniforms.uColorNear.value as THREE.Color).set(visual.palette.primary)
    ;(this.renderMat.uniforms.uColorFar.value as THREE.Color).set(visual.palette.secondary)
    ;(this.renderMat.uniforms.uColorGlow.value as THREE.Color).set(visual.palette.glow)
    this.renderMat.blending = visual.blendMode === 'normal' ? THREE.NormalBlending : THREE.AdditiveBlending
  }

  private seed() {
    if (!this.renderer) return
    const seedMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT, fragmentShader: SEED_FRAG,
      uniforms: { uTexDim: { value: this.texDim }, uAspect: { value: this.aspect } },
      depthTest: false, depthWrite: false,
    })
    const prev = this.fullQuad.material
    this.fullQuad.material = seedMat
    this.renderer.setRenderTarget(this.stateA)
    this.renderer.render(this.simScene, this.simCam)
    this.renderer.setRenderTarget(this.stateB)
    this.renderer.render(this.simScene, this.simCam)
    this.renderer.setRenderTarget(null)
    this.fullQuad.material = prev
    seedMat.dispose()
    this.current = this.stateA
  }

  update(dt: number) {
    if (!this.renderer) return
    if (!this._seeded) { this.seed(); this._seeded = true }
    const p = this.params
    const audio = senseBus.audio
    const hand = senseBus.hands
    this.t += dt
    const cdt = Math.min(dt, 1 / 30)

    // audio-reactive tweaks
    this.simMat.uniforms.uTime.value = this.t
    this.simMat.uniforms.uDt.value = cdt
    this.simMat.uniforms.uSpeed.value = p.speed * (0.85 + (audio.mid ?? 0) * 0.2)
    this.simMat.uniforms.uMaxTurn.value = 4.5 * (1 + (audio.high ?? 0) * 1.2)
    // predator
    if (hand.detected) {
      this.simMat.uniforms.uHand.value.set((hand.indexTip.x - 0.5) * 2 * this.aspect, -(hand.indexTip.y - 0.5) * 2)
      this.simMat.uniforms.uHandActive.value = 1
      this.simMat.uniforms.uPredator.value = p.predatorResponse * (0.6 + (hand.pinch ?? 0) * 1.4)
    } else {
      this.simMat.uniforms.uHandActive.value = 0
    }

    // 1) FIELD — scatter birds into the low-res velocity/density field (additive)
    this.fieldMat.uniforms.uState.value = this.current.texture
    this.renderer.setRenderTarget(this.fieldRT)
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.clear(true, false, false)
    this.renderer.render(this.fieldScene, this.simCam)

    // 2) SIM — advance state, ping-pong
    packObstacles(this.simMat.uniforms, this.obstacles, this.aspect, this.mapBounds)
    const src = this.current
    const dst = src === this.stateA ? this.stateB : this.stateA
    this.simMat.uniforms.uPrev.value = src.texture
    this.simMat.uniforms.uField.value = this.fieldRT.texture
    this.renderer.setRenderTarget(dst)
    this.renderer.render(this.simScene, this.simCam)
    this.current = dst
    this.renderer.setRenderTarget(null)

    // 3) hand render uniforms off to the render material
    this.renderMat.uniforms.uState.value = this.current.texture
    this.renderMat.uniforms.uTime.value = this.t
    this.renderMat.uniforms.uAudioBass.value = audio.bass ?? 0
    // density-adaptive alpha → clean look up to 100k (triangles overlap less than
    // points, so a gentler curve than the points organisms)
    this.renderMat.uniforms.uAlpha.value = Math.max(0.15, Math.min(0.95, 120 / Math.sqrt(this.count)))
  }

  dispose() {
    this.stateA.dispose(); this.stateB.dispose(); this.fieldRT.dispose()
    this.simMat.dispose(); this.fieldMat.dispose(); this.renderMat.dispose()
    this.fullQuad.geometry.dispose()
    this.fieldPoints.geometry.dispose()
    this.mesh.geometry.dispose()
  }
}
