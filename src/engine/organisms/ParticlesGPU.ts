/**
 * ParticlesGPU — nuage de particules génératif sur GPU (scale 100k+).
 *
 * Contrairement à Boids/Murmuration, les particules N'INTERAGISSENT PAS entre
 * elles → PAS de passe « champ ». Une seule passe sim par frame : turbulence
 * (bruit), gravité, attraction main, champ de flux, amortissement, intégration,
 * puis bord (wrap torique) ou respawn.
 *
 * Astuce « vie sans état » : le respawn périodique (mode respawn/kill) est dérivé
 * de uTime + une phase par particule (hash de l'index), sans stocker de timer —
 * on détecte le passage du sawtooth par zéro entre (t-dt) et t. Ça libère les 4
 * canaux RGBA pour position+vitesse uniquement.
 *
 * Alpha adaptatif à la densité : l'alpha des points baisse quand le nombre monte,
 * pour éviter la saturation blanche du blending additif à 50k+.
 */
import * as THREE from 'three'
import type { VisualParams, Obstacle } from '../../types/scene'
import { senseBus } from '../../senses/SenseBus'
import { flowState } from '../Flow'
import { OBSTACLE_GLSL, makeObstacleUniforms, packObstacles } from '../GPUObstacles'
import { MODIFIER_GLSL, makeModifierUniforms, packModifiers, SPRITE_TEX_GLSL, makeSpriteTexUniforms } from '../GPUModifiers'
import type { Modifier } from '../Modifiers'

export interface ParticlesGPUParams {
  count: number
  speed: number
  size: number
  spread: number
  trail: number
  gravity: number
  turbulence: number
  boundary?: 'wrap' | 'kill' | 'respawn'
}

const MAX_PARTICLES = 262144

const QUAD_VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position,1.0); }`

const HASH = `
  float hash11(float p){ return fract(sin(p*127.1)*43758.5453); }
  // spawn position for particle idx (disc of radius uSpread, or uniform if wrap)
  vec2 spawnPos(float idx){
    float a = hash11(idx*1.7) * 6.2831853;
    if (uWrap > 0.5) {
      return vec2((hash11(idx*2.3)-0.5)*2.0*uAspect*1.4, (hash11(idx*3.1)-0.5)*2.0*1.4);
    }
    float r = hash11(idx*2.9) * uSpread;
    return vec2(cos(a)*r*uAspect, sin(a)*r);
  }
  vec2 spawnVel(float idx){
    float v = uSpeed * 0.3;
    return vec2((hash11(idx*5.1)-0.5)*v, (hash11(idx*6.7)-0.5)*v);
  }
`

const SEED_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform float uTexDim, uAspect, uSpread, uSpeed, uWrap;
  ${HASH}
  void main(){
    float idx = floor(vUv.y*uTexDim)*uTexDim + floor(vUv.x*uTexDim);
    gl_FragColor = vec4(spawnPos(idx), spawnVel(idx));
  }
`

const SIM_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uPrev;
  uniform float uTexDim, uCount, uAspect, uDt, uTime;
  uniform float uSpeed, uGravity, uTurb, uAudioMid;
  uniform vec2 uHand; uniform float uHandPull;
  uniform vec2 uFlow; uniform float uFlowTurb;
  uniform float uWrap, uSpread, uLifePeriod;
  ${HASH}
  ${OBSTACLE_GLSL}
  ${MODIFIER_GLSL}
  void main(){
    float idx = floor(vUv.y*uTexDim)*uTexDim + floor(vUv.x*uTexDim);
    if (idx >= uCount) { gl_FragColor = vec4(999.0,999.0,0.0,0.0); return; }
    vec4 st = texture2D(uPrev, vUv);
    vec2 pos = st.xy; vec2 vel = st.zw;
    if (!(pos.x==pos.x)||!(pos.y==pos.y)||abs(pos.x)>50.0||abs(pos.y)>50.0){
      gl_FragColor = vec4(spawnPos(idx), spawnVel(idx)); return;
    }
    // Stateless periodic respawn (respawn/kill modes only)
    if (uWrap < 0.5) {
      float ph = hash11(idx*0.37);
      float aNow  = fract(uTime/uLifePeriod + ph);
      float aPrev = fract((uTime-uDt)/uLifePeriod + ph);
      if (aNow < aPrev) { gl_FragColor = vec4(spawnPos(idx), spawnVel(idx)); return; }
    }
    // turbulence
    float t = uTime;
    float nx = sin(pos.x*3.0 + t*0.7) + cos(pos.y*2.3 - t*0.5);
    float ny = cos(pos.x*2.1 - t*0.6) + sin(pos.y*3.1 + t*0.4);
    vel.x += nx * uTurb * 0.4 * uDt;
    vel.y += ny * uTurb * 0.4 * uDt;
    vel.y -= uGravity * uDt * 0.5;
    if (uHandPull > 0.0) {
      vec2 d = uHand - pos; float dl = max(0.05, length(d));
      vel += (d/dl) * uHandPull * uDt;
    }
    vec2 flow = uFlow;
    flow.x += sin(pos.x*2.0 + t*0.4) * uFlowTurb * 0.6;
    flow.y += cos(pos.y*2.3 - t*0.3) * uFlowTurb * 0.6;
    vel += flow * uDt;
    // Physical obstacles + map walls
    float _kill; vec2 _of = obstacleForce(pos, _kill);
    if (_kill > 0.5) { gl_FragColor = vec4(spawnPos(idx), spawnVel(idx)); return; }
    vel += _of * uDt;
    vel += modifierForce(pos) * uDt;       // vortex / gravity well / magnetic bands
    vel *= uPulseVelScale;                 // pulseGate beat
    vel *= pow(0.985, uDt*60.0);           // dt-independent damping
    float aBoost = 1.0 + uAudioMid*1.5;
    pos += vel * uSpeed * aBoost * uDt;
    // boundary
    float xMax = uAspect*1.5, yMax = 1.5;
    if (uWrap > 0.5) {
      if (pos.x> xMax) pos.x -= xMax*2.0; if (pos.x<-xMax) pos.x += xMax*2.0;
      if (pos.y> yMax) pos.y -= yMax*2.0; if (pos.y<-yMax) pos.y += yMax*2.0;
    } else if (abs(pos.x)>xMax || abs(pos.y)>yMax) {
      pos = spawnPos(idx); vel = spawnVel(idx);
    }
    pos = silhouetteClamp(pos);   // hard no-penetration of the body silhouette
    gl_FragColor = vec4(pos, vel);
  }
`

const RENDER_VERT = `
  precision highp float;
  attribute float aIndex;
  uniform sampler2D uState;
  uniform float uTexDim, uCount, uPointPx;
  uniform vec3 uColorA, uColorB;
  varying vec3 vColor;
  void main(){
    float u=(mod(aIndex,uTexDim)+0.5)/uTexDim, v=(floor(aIndex/uTexDim)+0.5)/uTexDim;
    vec4 st = texture2D(uState, vec2(u,v));
    float tcol = (sin(aIndex*0.013)+1.0)*0.5;
    vColor = mix(uColorA, uColorB, tcol);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(st.xy, 0.0, 1.0);
    gl_PointSize = uPointPx;
  }
`
const RENDER_FRAG = `
  precision highp float;
  uniform float uAlpha;
  varying vec3 vColor;
  ${SPRITE_TEX_GLSL}
  void main(){
    if (uUseTex > 0.5) {
      vec4 s = texSprite(vColor, uAlpha);
      if (s.a < 0.01) discard;
      gl_FragColor = s;
      return;
    }
    vec2 c = gl_PointCoord - 0.5;
    float d2 = dot(c,c);
    if (d2 > 0.25) discard;
    float a = smoothstep(0.25, 0.0, d2) * uAlpha;
    gl_FragColor = vec4(vColor, a);
  }
`

export class ParticlesGPUOrganism {
  mesh: THREE.Points
  count = 0
  obstacles: Obstacle[] | undefined
  modifiers: Modifier[] | undefined
  mapBounds: [number, number, number, number] | null = null
  renderer: THREE.WebGLRenderer | null = null

  private params: ParticlesGPUParams
  private aspect = 1
  private t = 0
  private texDim = 64
  private stateA: THREE.WebGLRenderTarget
  private stateB: THREE.WebGLRenderTarget
  private current: THREE.WebGLRenderTarget
  private simMat: THREE.ShaderMaterial
  private renderMat: THREE.ShaderMaterial
  private simScene = new THREE.Scene()
  private simCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private fullQuad: THREE.Mesh
  private _seeded = false
  private _sizeV2 = new THREE.Vector2()

  constructor(params: ParticlesGPUParams, visual: VisualParams) {
    this.params = params
    this.count = Math.min(Math.max(1, params.count | 0), MAX_PARTICLES)
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

    const wrap = (params.boundary ?? 'respawn') === 'wrap' ? 1 : 0
    this.simMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT, fragmentShader: SIM_FRAG,
      uniforms: {
        uPrev: { value: this.stateA.texture },
        uTexDim: { value: this.texDim }, uCount: { value: this.count },
        uAspect: { value: this.aspect }, uDt: { value: 1 / 60 }, uTime: { value: 0 },
        uSpeed: { value: params.speed }, uGravity: { value: params.gravity },
        uTurb: { value: params.turbulence }, uAudioMid: { value: 0 },
        uHand: { value: new THREE.Vector2(0, 0) }, uHandPull: { value: 0 },
        uFlow: { value: new THREE.Vector2(0, 0) }, uFlowTurb: { value: 0 },
        uWrap: { value: wrap }, uSpread: { value: params.spread ?? 0.5 },
        uLifePeriod: { value: 4.0 },
        ...makeObstacleUniforms(),
        ...makeModifierUniforms(),
      },
      depthTest: false, depthWrite: false,
    })
    this.fullQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.simMat)
    this.simScene.add(this.fullQuad)

    const slots = this.texDim * this.texDim
    const indices = new Float32Array(slots)
    for (let i = 0; i < slots; i++) indices[i] = i
    const renderGeo = new THREE.BufferGeometry()
    renderGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(slots * 3), 3))
    renderGeo.setAttribute('aIndex', new THREE.BufferAttribute(indices, 1))
    renderGeo.setDrawRange(0, this.count)
    this.renderMat = new THREE.ShaderMaterial({
      vertexShader: RENDER_VERT, fragmentShader: RENDER_FRAG,
      uniforms: {
        uState: { value: this.stateA.texture }, uTexDim: { value: this.texDim },
        uCount: { value: this.count }, uPointPx: { value: 4 }, uAlpha: { value: 0.85 },
        uColorA: { value: new THREE.Color(visual.palette.primary) },
        uColorB: { value: new THREE.Color(visual.palette.glow) },
        ...makeSpriteTexUniforms(),
      },
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    })
    this.mesh = new THREE.Points(renderGeo, this.renderMat)
    this.mesh.frustumCulled = false
  }

  private pickTexDim(count: number): number { let d = 16; while (d * d < count && d < 512) d *= 2; return d }

  setAspect(a: number) { this.aspect = a; this.simMat.uniforms.uAspect.value = a }

  updateParams(p: ParticlesGPUParams) {
    const newCount = Math.min(Math.max(1, p.count | 0), MAX_PARTICLES)
    const newDim = this.pickTexDim(newCount)
    if (newDim !== this.texDim) {
      this.texDim = newDim
      this.stateA.setSize(newDim, newDim); this.stateB.setSize(newDim, newDim)
      const slots = newDim * newDim
      const indices = new Float32Array(slots)
      for (let i = 0; i < slots; i++) indices[i] = i
      this.mesh.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(slots * 3), 3))
      this.mesh.geometry.setAttribute('aIndex', new THREE.BufferAttribute(indices, 1))
      this.simMat.uniforms.uTexDim.value = newDim
      this.renderMat.uniforms.uTexDim.value = newDim
      this._seeded = false
    }
    this.count = newCount
    this.mesh.geometry.setDrawRange(0, newCount)
    this.params = p
    this.simMat.uniforms.uCount.value = newCount
    this.simMat.uniforms.uSpeed.value = p.speed
    this.simMat.uniforms.uGravity.value = p.gravity
    this.simMat.uniforms.uTurb.value = p.turbulence
    this.simMat.uniforms.uSpread.value = p.spread ?? 0.5
    this.simMat.uniforms.uWrap.value = (p.boundary ?? 'respawn') === 'wrap' ? 1 : 0
    this.renderMat.uniforms.uCount.value = newCount
  }

  applyVisual(visual: VisualParams) {
    ;(this.renderMat.uniforms.uColorA.value as THREE.Color).set(visual.palette.primary)
    ;(this.renderMat.uniforms.uColorB.value as THREE.Color).set(visual.palette.glow)
    this.renderMat.blending = visual.blendMode === 'normal' ? THREE.NormalBlending : THREE.AdditiveBlending
  }

  setTexture(tex: THREE.Texture | null) {
    this.renderMat.uniforms.uTex.value = tex
    this.renderMat.uniforms.uUseTex.value = tex ? 1 : 0
  }

  private seed() {
    if (!this.renderer) return
    const seedMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT, fragmentShader: SEED_FRAG,
      uniforms: {
        uTexDim: { value: this.texDim }, uAspect: { value: this.aspect },
        uSpread: { value: this.params.spread ?? 0.5 }, uSpeed: { value: this.params.speed },
        uWrap: { value: (this.params.boundary ?? 'respawn') === 'wrap' ? 1 : 0 },
      },
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

    this.simMat.uniforms.uTime.value = this.t
    this.simMat.uniforms.uDt.value = cdt
    this.simMat.uniforms.uAudioMid.value = audio.mid ?? 0
    if (hand.detected) {
      this.simMat.uniforms.uHand.value.set((hand.indexTip.x - 0.5) * 2 * this.aspect, -(hand.indexTip.y - 0.5) * 2)
      this.simMat.uniforms.uHandPull.value = 0.5 + (hand.pinch ?? 0) * 2.0
    } else {
      this.simMat.uniforms.uHandPull.value = 0
    }
    if (flowState.enabled) {
      this.simMat.uniforms.uFlow.value.set(flowState.vx, flowState.vy)
      this.simMat.uniforms.uFlowTurb.value = flowState.turbulence
    } else {
      this.simMat.uniforms.uFlow.value.set(0, 0)
      this.simMat.uniforms.uFlowTurb.value = 0
    }

    // sim ping-pong (single pass — no field)
    packObstacles(this.simMat.uniforms, this.obstacles, this.aspect, this.mapBounds)
    packModifiers(this.simMat.uniforms, this.modifiers, this.aspect, this.t)
    const src = this.current
    const dst = src === this.stateA ? this.stateB : this.stateA
    this.simMat.uniforms.uPrev.value = src.texture
    this.renderer.setRenderTarget(dst)
    this.renderer.render(this.simScene, this.simCam)
    this.current = dst
    this.renderer.setRenderTarget(null)

    // render uniforms
    const dpr = this.renderer.getPixelRatio()
    this.renderer.getSize(this._sizeV2)
    const pxPerWorld = (this._sizeV2.y * dpr) / 2
    const worldDiam = p.size * 0.08 * (0.5 + (audio.bass ?? 0) * 0.75) * 2.0
    this.renderMat.uniforms.uPointPx.value = Math.max(1, Math.min(48, worldDiam * pxPerWorld))
    // density-adaptive alpha → no additive white-out at high counts
    this.renderMat.uniforms.uAlpha.value = Math.max(0.05, Math.min(0.9, 45 / Math.sqrt(this.count)))
    this.renderMat.uniforms.uState.value = this.current.texture
  }

  dispose() {
    this.stateA.dispose(); this.stateB.dispose()
    this.simMat.dispose(); this.renderMat.dispose()
    this.fullQuad.geometry.dispose()
    this.mesh.geometry.dispose()
  }
}
