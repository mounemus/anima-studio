/**
 * BoidsGPU — bancs de boids « continuum » sur GPU (scale 100k+).
 *
 * Même architecture GPGPU que [[MurmurationGPU.ts]] (état pos/vel en textures
 * ping-pong + champ vitesse/densité bilinéaire + sim shader O(N)), mais avec le
 * comportement classique des boids de ce projet :
 *   - bords TORIQUES (wrap) au lieu d'un perchoir,
 *   - la main est un ATTRACTEUR (pas un prédateur),
 *   - champ de flux de scène (Flow) pris en compte,
 *   - rendu en POINTS ronds additifs, dégradé primary→secondary par index.
 *
 * NB : la résolution d'obstacles CPU (solveObstacles/silhouette) n'est pas portée
 * sur GPU dans cette version — comme pour MurmurationGPU. Fallback CPU dispo via
 * gpu:0 pour les scènes qui ont besoin des obstacles physiques.
 */
import * as THREE from 'three'
import type { VisualParams, Obstacle } from '../../types/scene'
import { senseBus } from '../../senses/SenseBus'
import { flowState } from '../Flow'
import { OBSTACLE_GLSL, makeObstacleUniforms, packObstacles } from '../GPUObstacles'

export interface BoidsGPUParams {
  count: number
  cohesion: number
  separation: number
  alignment: number
  speed: number
  vision: number
  size: number
  trail: number
  edges?: 'wrap' | 'wall' | 'free'
}

/** wrap=0 (toroïdal) · wall=1 (rebond) · free=2 (aucun) */
export const edgeCode = (e?: string): number => (e === 'wall' ? 1 : e === 'free' ? 2 : 0)

const MAX_BOIDS = 262144
const FIELD_RES = 128

const QUAD_VERT = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
`

const SEED_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform float uAspect;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    float h1 = hash(vUv), h2 = hash(vUv + 3.17), h3 = hash(vUv + 7.31), h4 = hash(vUv + 1.13);
    vec2 pos = vec2((h1 - 0.5) * 2.0 * uAspect, (h2 - 0.5) * 2.0);
    vec2 vel = vec2((h3 - 0.5) * 0.4, (h4 - 0.5) * 0.4);
    gl_FragColor = vec4(pos, vel);
  }
`

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
    gl_Position = vec4(vec2(st.x / uAspect, st.y), 0.0, 1.0);
    gl_PointSize = uPointSize;
  }
`
const FIELD_FRAG = `
  precision highp float;
  varying vec2 vVel;
  varying float vActive;
  void main() {
    if (vActive < 0.5) discard;
    gl_FragColor = vec4(vVel, 1.0, 1.0);
  }
`

const SIM_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uPrev;
  uniform sampler2D uField;
  uniform float uTexDim;
  uniform float uCount;
  uniform float uAspect;
  uniform float uDt;
  uniform float uTime;
  uniform float uAlign;
  uniform float uCohesion;
  uniform float uSeparation;
  uniform float uSpeed;
  uniform float uFieldRes;
  uniform vec2  uHand;
  uniform float uHandForce;
  uniform vec2  uFlow;
  uniform float uFlowTurb;
  uniform float uEdge;

  vec2 worldToFieldUv(vec2 w) { return vec2(w.x / uAspect, w.y) * 0.5 + 0.5; }
  vec4 fieldAt(vec2 w) { return texture2D(uField, worldToFieldUv(w)); }
  ${OBSTACLE_GLSL}

  void main() {
    float idx = floor(vUv.y * uTexDim) * uTexDim + floor(vUv.x * uTexDim);
    vec4 st = texture2D(uPrev, vUv);
    vec2 pos = st.xy;
    vec2 vel = st.zw;
    if (idx >= uCount) { gl_FragColor = vec4(999.0, 999.0, 0.0, 0.0); return; }
    if (!(pos.x == pos.x) || !(pos.y == pos.y) || abs(pos.x) > 50.0 || abs(pos.y) > 50.0) {
      gl_FragColor = vec4(0.0, 0.0, 0.1, 0.0); return;
    }

    vec4 fc = fieldAt(pos);
    float dens = max(fc.b, 1.0);
    vec2 avgVel = fc.rg / dens;
    float e = 1.5 / uFieldRes * uAspect * 2.0;
    vec2 gradDens = vec2(fieldAt(pos + vec2(e,0.0)).b - fieldAt(pos - vec2(e,0.0)).b,
                         fieldAt(pos + vec2(0.0,e)).b - fieldAt(pos - vec2(0.0,e)).b);

    vec2 force = vec2(0.0);
    float am = length(avgVel);
    if (am > 1e-4) force += ((avgVel / am) - normalize(vel + 1e-5)) * uAlign * 0.8;
    float gm = length(gradDens);
    if (gm > 1e-4) {
      force += (gradDens / gm) * uCohesion * 0.9;                       // cohesion → denser
      force -= (gradDens / gm) * uSeparation * (0.3 + dens * 0.02);     // separation → away local
    }
    // Hand attractor
    if (uHandForce > 0.0) {
      vec2 d = uHand - pos;
      float dl = max(0.05, length(d));
      force += (d / dl) * uHandForce * 0.8;
    }
    // Scene flow field (matches CPU sampleFlow)
    vec2 flow = uFlow;
    flow.x += sin(pos.x * 2.0 + uTime * 0.4) * uFlowTurb * 0.6;
    flow.y += cos(pos.y * 2.3 - uTime * 0.3) * uFlowTurb * 0.6;
    force += flow;

    // Physical obstacles + map walls
    float _kill; vec2 _of = obstacleForce(pos, _kill);
    if (_kill > 0.5) { gl_FragColor = vec4((fract(idx*0.013)-0.5)*uAspect, (fract(idx*0.071)-0.5), 0.0, 0.0); return; }
    force += _of;

    // Integrate (accel) + speed clamp
    vel += force * uDt * 2.0;
    float maxSp = 1.2 * uSpeed;
    float sp = length(vel);
    if (sp > maxSp) vel = vel / sp * maxSp;

    pos += vel * uDt * uSpeed;

    // Edge behaviour : wrap (0) / wall bounce (1) / free (2)
    float ax = uAspect;
    if (uEdge < 0.5) {
      if (pos.x >  ax) pos.x -= 2.0 * ax; else if (pos.x < -ax) pos.x += 2.0 * ax;
      if (pos.y >  1.0) pos.y -= 2.0;     else if (pos.y < -1.0) pos.y += 2.0;
    } else if (uEdge < 1.5) {
      if (pos.x >  ax) { pos.x =  ax; vel.x = -abs(vel.x) * 0.6; } else if (pos.x < -ax) { pos.x = -ax; vel.x = abs(vel.x) * 0.6; }
      if (pos.y >  1.0) { pos.y =  1.0; vel.y = -abs(vel.y) * 0.6; } else if (pos.y < -1.0) { pos.y = -1.0; vel.y = abs(vel.y) * 0.6; }
    }
    // free (2) : no boundary handling
    pos = silhouetteClamp(pos);   // hard no-penetration of the body silhouette
    gl_FragColor = vec4(pos, vel);
  }
`

const RENDER_VERT = `
  precision highp float;
  attribute float aIndex;
  uniform sampler2D uState;
  uniform float uTexDim;
  uniform float uCount;
  uniform float uPointPx;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  varying vec3 vColor;
  void main() {
    float u = (mod(aIndex, uTexDim) + 0.5) / uTexDim;
    float v = (floor(aIndex / uTexDim) + 0.5) / uTexDim;
    vec4 st = texture2D(uState, vec2(u, v));
    vColor = mix(uColorA, uColorB, aIndex / max(uCount, 1.0));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(st.xy, 0.0, 1.0);
    gl_PointSize = uPointPx;
  }
`
const RENDER_FRAG = `
  precision highp float;
  uniform float uAlpha;
  varying vec3 vColor;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d2 = dot(c, c);
    if (d2 > 0.25) discard;
    float a = smoothstep(0.25, 0.02, d2) * uAlpha;
    gl_FragColor = vec4(vColor, a);
  }
`

export class BoidsGPUOrganism {
  mesh: THREE.Points
  count = 0
  obstacles: Obstacle[] | undefined
  mapBounds: [number, number, number, number] | null = null
  renderer: THREE.WebGLRenderer | null = null

  private params: BoidsGPUParams
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
  private _sizeV2 = new THREE.Vector2()

  constructor(params: BoidsGPUParams, visual: VisualParams) {
    this.params = params
    this.count = Math.min(Math.max(1, params.count | 0), MAX_BOIDS)
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

    this.simMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT, fragmentShader: SIM_FRAG,
      uniforms: {
        uPrev: { value: this.stateA.texture },
        uField: { value: this.fieldRT.texture },
        uTexDim: { value: this.texDim }, uCount: { value: this.count },
        uAspect: { value: this.aspect }, uDt: { value: 1 / 60 }, uTime: { value: 0 },
        uAlign: { value: params.alignment }, uCohesion: { value: params.cohesion },
        uSeparation: { value: params.separation }, uSpeed: { value: params.speed },
        uFieldRes: { value: FIELD_RES },
        uHand: { value: new THREE.Vector2(0, 0) }, uHandForce: { value: 0 },
        uFlow: { value: new THREE.Vector2(0, 0) }, uFlowTurb: { value: 0 },
        uEdge: { value: edgeCode(params.edges) },
        ...makeObstacleUniforms(),
      },
      depthTest: false, depthWrite: false,
    })
    this.fullQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.simMat)
    this.simScene.add(this.fullQuad)

    const slots = this.texDim * this.texDim
    const indices = new Float32Array(slots)
    for (let i = 0; i < slots; i++) indices[i] = i

    const fieldGeo = new THREE.BufferGeometry()
    fieldGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(slots * 3), 3))
    fieldGeo.setAttribute('aIndex', new THREE.BufferAttribute(indices, 1))
    this.fieldMat = new THREE.ShaderMaterial({
      vertexShader: FIELD_VERT, fragmentShader: FIELD_FRAG,
      uniforms: {
        uState: { value: this.stateA.texture }, uTexDim: { value: this.texDim },
        uAspect: { value: this.aspect }, uCount: { value: this.count }, uPointSize: { value: 3 },
      },
      transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false,
    })
    this.fieldPoints = new THREE.Points(fieldGeo, this.fieldMat)
    this.fieldPoints.frustumCulled = false
    this.fieldScene.add(this.fieldPoints)

    const renderGeo = new THREE.BufferGeometry()
    renderGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(slots * 3), 3))
    renderGeo.setAttribute('aIndex', new THREE.BufferAttribute(indices, 1))
    renderGeo.setDrawRange(0, this.count)
    this.renderMat = new THREE.ShaderMaterial({
      vertexShader: RENDER_VERT, fragmentShader: RENDER_FRAG,
      uniforms: {
        uState: { value: this.stateA.texture }, uTexDim: { value: this.texDim },
        uCount: { value: this.count }, uPointPx: { value: 6 }, uAlpha: { value: 0.9 },
        uColorA: { value: new THREE.Color(visual.palette.primary) },
        uColorB: { value: new THREE.Color(visual.palette.secondary) },
      },
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    })
    this.mesh = new THREE.Points(renderGeo, this.renderMat)
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

  updateParams(p: BoidsGPUParams) {
    const newCount = Math.min(Math.max(1, p.count | 0), MAX_BOIDS)
    const newDim = this.pickTexDim(newCount)
    if (newDim !== this.texDim) {
      this.texDim = newDim
      this.stateA.setSize(newDim, newDim)
      this.stateB.setSize(newDim, newDim)
      this.rebuildIndices()
      this.simMat.uniforms.uTexDim.value = newDim
      this.fieldMat.uniforms.uTexDim.value = newDim
      this.renderMat.uniforms.uTexDim.value = newDim
      this._seeded = false
    }
    this.count = newCount
    this.mesh.geometry.setDrawRange(0, newCount)
    this.params = p
    this.simMat.uniforms.uCount.value = newCount
    this.simMat.uniforms.uAlign.value = p.alignment
    this.simMat.uniforms.uCohesion.value = p.cohesion
    this.simMat.uniforms.uSeparation.value = p.separation
    this.simMat.uniforms.uSpeed.value = p.speed
    this.simMat.uniforms.uEdge.value = edgeCode(p.edges)
    this.fieldMat.uniforms.uCount.value = newCount
    this.renderMat.uniforms.uCount.value = newCount
  }

  private rebuildIndices() {
    const slots = this.texDim * this.texDim
    const indices = new Float32Array(slots)
    for (let i = 0; i < slots; i++) indices[i] = i
    const fg = this.fieldPoints.geometry
    fg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(slots * 3), 3))
    fg.setAttribute('aIndex', new THREE.BufferAttribute(indices, 1))
    const rg = this.mesh.geometry
    rg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(slots * 3), 3))
    rg.setAttribute('aIndex', new THREE.BufferAttribute(indices, 1))
  }

  applyVisual(visual: VisualParams) {
    ;(this.renderMat.uniforms.uColorA.value as THREE.Color).set(visual.palette.primary)
    ;(this.renderMat.uniforms.uColorB.value as THREE.Color).set(visual.palette.secondary)
    this.renderMat.blending = visual.blendMode === 'normal' ? THREE.NormalBlending : THREE.AdditiveBlending
  }

  private seed() {
    if (!this.renderer) return
    const seedMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT, fragmentShader: SEED_FRAG,
      uniforms: { uAspect: { value: this.aspect } }, depthTest: false, depthWrite: false,
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

    this.simMat.uniforms.uTime.value = this.t
    this.simMat.uniforms.uDt.value = cdt
    this.simMat.uniforms.uSpeed.value = p.speed * (0.4 + (audio.high ?? 0) * 0.6) + 0.05
    if (hand.detected) {
      this.simMat.uniforms.uHand.value.set((hand.indexTip.x - 0.5) * 2 * this.aspect, -(hand.indexTip.y - 0.5) * 2)
      this.simMat.uniforms.uHandForce.value = 0.7 + (hand.pinch ?? 0) * 1.5
    } else {
      this.simMat.uniforms.uHandForce.value = 0
    }
    // Scene flow field
    if (flowState.enabled) {
      this.simMat.uniforms.uFlow.value.set(flowState.vx, flowState.vy)
      this.simMat.uniforms.uFlowTurb.value = flowState.turbulence
    } else {
      this.simMat.uniforms.uFlow.value.set(0, 0)
      this.simMat.uniforms.uFlowTurb.value = 0
    }

    // 1) field scatter
    this.fieldMat.uniforms.uState.value = this.current.texture
    this.renderer.setRenderTarget(this.fieldRT)
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.clear(true, false, false)
    this.renderer.render(this.fieldScene, this.simCam)

    // 2) sim ping-pong
    packObstacles(this.simMat.uniforms, this.obstacles, this.aspect, this.mapBounds)
    const src = this.current
    const dst = src === this.stateA ? this.stateB : this.stateA
    this.simMat.uniforms.uPrev.value = src.texture
    this.simMat.uniforms.uField.value = this.fieldRT.texture
    this.renderer.setRenderTarget(dst)
    this.renderer.render(this.simScene, this.simCam)
    this.current = dst
    this.renderer.setRenderTarget(null)

    // 3) render uniforms — point size in framebuffer px from world size
    const dpr = this.renderer.getPixelRatio()
    this.renderer.getSize(this._sizeV2)
    const pxPerWorld = (this._sizeV2.y * dpr) / 2
    const worldDiam = p.size * (1.2 + (audio.bass ?? 0) * 2.5) * 2.0
    this.renderMat.uniforms.uPointPx.value = Math.max(1, Math.min(64, worldDiam * pxPerWorld))
    // density-adaptive alpha → no additive white-out at high counts
    this.renderMat.uniforms.uAlpha.value = Math.max(0.06, Math.min(0.9, 45 / Math.sqrt(this.count)))
    this.renderMat.uniforms.uState.value = this.current.texture
  }

  dispose() {
    this.stateA.dispose(); this.stateB.dispose(); this.fieldRT.dispose()
    this.simMat.dispose(); this.fieldMat.dispose(); this.renderMat.dispose()
    this.fullQuad.geometry.dispose()
    this.fieldPoints.geometry.dispose()
    this.mesh.geometry.dispose()
  }
}
