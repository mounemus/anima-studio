/**
 * CellsGPU — "particle life" continuum sur GPU (scale 50k+).
 *
 * Le CPU [[Cells.ts]] est en O(N²) plafonné à 250. Ici : 4 espèces (dérivées de
 * l'index, sans stockage), une matrice de forces 4×4 inter-espèces, et un champ
 * de densité par espèce empaqueté dans UN SEUL RT RGBA (R/G/B/A = densité des
 * espèces 0/1/2/3). Chaque particule ressent, par espèce s, une force
 * matrix[self][s] le long du gradient de densité_s (positif = attirée, négatif =
 * repoussée) + une répulsion de contact depuis la densité totale.
 *
 * C'est une APPROXIMATION continuum de la vraie particle-life (pas de forces
 * paire-à-paire exactes), mais elle produit la même émergence : cellules, amas,
 * chaînes, dynamiques de poursuite. O(N) sur GPU.
 */
import * as THREE from 'three'
import type { VisualParams, Obstacle } from '../../types/scene'
import { senseBus } from '../../senses/SenseBus'
import { flowState } from '../Flow'
import { OBSTACLE_GLSL, makeObstacleUniforms, packObstacles } from '../GPUObstacles'

export interface CellsGPUParams {
  count: number
  pulse: number
  size: number
  attraction: number
  repulsion: number
  trail: number
  boundary?: 'wrap' | 'bounce'
}

const MAX_CELLS = 262144
const FIELD_RES = 128

const QUAD_VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position,1.0); }`

const SEED_FRAG = `
  precision highp float; varying vec2 vUv;
  uniform float uTexDim, uAspect;
  float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
  void main(){
    float h1=h(vUv), h2=h(vUv+3.17), h3=h(vUv+7.31), h4=h(vUv+1.13);
    vec2 pos = vec2((h1-0.5)*2.0*uAspect, (h2-0.5)*2.0);
    vec2 vel = vec2((h3-0.5)*0.2, (h4-0.5)*0.2);
    gl_FragColor = vec4(pos, vel);
  }
`

// Scatter: each particle adds 1.0 into its species' channel (species = mod(idx,4))
const FIELD_VERT = `
  precision highp float;
  attribute float aIndex;
  uniform sampler2D uState; uniform float uTexDim, uAspect, uCount, uPointSize;
  varying float vSpecies; varying float vActive;
  void main(){
    if (aIndex >= uCount){ vActive=0.0; gl_Position=vec4(2.0,2.0,2.0,1.0); gl_PointSize=0.0; return; }
    vActive=1.0; vSpecies = mod(aIndex, 4.0);
    float u=(mod(aIndex,uTexDim)+0.5)/uTexDim, v=(floor(aIndex/uTexDim)+0.5)/uTexDim;
    vec4 st = texture2D(uState, vec2(u,v));
    gl_Position = vec4(vec2(st.x/uAspect, st.y), 0.0, 1.0);
    gl_PointSize = uPointSize;
  }
`
const FIELD_FRAG = `
  precision highp float;
  varying float vSpecies; varying float vActive;
  void main(){
    if (vActive < 0.5) discard;
    vec4 c = vec4(0.0);
    if (vSpecies < 0.5) c.r = 1.0;
    else if (vSpecies < 1.5) c.g = 1.0;
    else if (vSpecies < 2.5) c.b = 1.0;
    else c.a = 1.0;
    gl_FragColor = c;
  }
`

const SIM_FRAG = `
  precision highp float; varying vec2 vUv;
  uniform sampler2D uPrev, uField;
  uniform float uTexDim, uCount, uAspect, uDt, uTime, uFieldRes;
  uniform float uAttract, uRepulse, uPulse;
  uniform vec4 uRow0, uRow1, uRow2, uRow3;   // 4x4 inter-species force matrix (rows)
  uniform vec2 uHand; uniform float uHandForce;
  uniform vec2 uFlow; uniform float uFlowTurb;
  uniform float uWrap;

  vec2 fUv(vec2 w){ return vec2(w.x/uAspect, w.y)*0.5 + 0.5; }
  vec4 fld(vec2 w){ return texture2D(uField, fUv(w)); }
  vec2 sn(vec2 g){ float m=length(g); return m>1e-4 ? g/m : vec2(0.0); }
  ${OBSTACLE_GLSL}

  void main(){
    float idx = floor(vUv.y*uTexDim)*uTexDim + floor(vUv.x*uTexDim);
    vec4 st = texture2D(uPrev, vUv);
    vec2 pos = st.xy, vel = st.zw;
    if (idx >= uCount){ gl_FragColor = vec4(999.0,999.0,0.0,0.0); return; }
    if (!(pos.x==pos.x)||!(pos.y==pos.y)||abs(pos.x)>50.0||abs(pos.y)>50.0){
      gl_FragColor = vec4((fract(idx*0.013)-0.5)*uAspect, (fract(idx*0.071)-0.5), 0.0, 0.0); return;
    }
    float sp = mod(idx, 4.0);
    vec4 row = sp<0.5 ? uRow0 : sp<1.5 ? uRow1 : sp<2.5 ? uRow2 : uRow3;

    float e = 1.5/uFieldRes*uAspect*2.0;
    vec4 cR=fld(pos+vec2(e,0.0)), cL=fld(pos-vec2(e,0.0));
    vec4 cU=fld(pos+vec2(0.0,e)), cD=fld(pos-vec2(0.0,e));
    // per-species density gradients
    vec2 g0=vec2(cR.r-cL.r,cU.r-cD.r);
    vec2 g1=vec2(cR.g-cL.g,cU.g-cD.g);
    vec2 g2=vec2(cR.b-cL.b,cU.b-cD.b);
    vec2 g3=vec2(cR.a-cL.a,cU.a-cD.a);

    vec2 force = vec2(0.0);
    force += row.x * sn(g0);
    force += row.y * sn(g1);
    force += row.z * sn(g2);
    force += row.w * sn(g3);
    force *= uAttract;
    // contact repulsion from total local density (keeps cells from fusing)
    vec2 gTot = g0+g1+g2+g3;
    vec4 dHere = fld(pos);
    float tot = dHere.r+dHere.g+dHere.b+dHere.a;
    force -= sn(gTot) * uRepulse * (0.4 + tot*0.03);
    // hand
    if (uHandForce > 0.0){ vec2 d=uHand-pos; float dl=max(0.05,length(d)); force += (d/dl)*uHandForce*0.4; }
    // flow
    vec2 flow = uFlow;
    flow.x += sin(pos.x*2.0 + uTime*0.4)*uFlowTurb*0.6;
    flow.y += cos(pos.y*2.3 - uTime*0.3)*uFlowTurb*0.6;
    force += flow*0.5;
    // Physical obstacles + map walls
    float _kill; vec2 _of = obstacleForce(pos, _kill);
    if (_kill > 0.5) { gl_FragColor = vec4((fract(idx*0.013)-0.5)*uAspect, (fract(idx*0.071)-0.5), 0.0, 0.0); return; }
    force += _of;

    vel = vel * pow(0.9, uDt*60.0) + force * uDt;
    float maxSp = 1.2;
    float s = length(vel); if (s>maxSp) vel = vel/s*maxSp;
    pos += vel * uDt;

    float ax=uAspect;
    if (uWrap>0.5){
      if(pos.x>ax)pos.x-=2.0*ax; if(pos.x<-ax)pos.x+=2.0*ax;
      if(pos.y>1.0)pos.y-=2.0; if(pos.y<-1.0)pos.y+=2.0;
    } else {
      if(pos.x>ax){pos.x=ax;vel.x*=-0.5;} if(pos.x<-ax){pos.x=-ax;vel.x*=-0.5;}
      if(pos.y>1.0){pos.y=1.0;vel.y*=-0.5;} if(pos.y<-1.0){pos.y=-1.0;vel.y*=-0.5;}
    }
    pos = silhouetteClamp(pos);   // hard no-penetration of the body silhouette
    gl_FragColor = vec4(pos, vel);
  }
`

const RENDER_VERT = `
  precision highp float;
  attribute float aIndex;
  uniform sampler2D uState; uniform float uTexDim, uCount, uPointPx, uTime, uPulse;
  uniform vec3 uCol0, uCol1, uCol2, uCol3;
  varying vec3 vColor; varying float vFade;
  void main(){
    float u=(mod(aIndex,uTexDim)+0.5)/uTexDim, v=(floor(aIndex/uTexDim)+0.5)/uTexDim;
    vec4 st = texture2D(uState, vec2(u,v));
    float sp = mod(aIndex,4.0);
    vColor = sp<0.5?uCol0: sp<1.5?uCol1: sp<2.5?uCol2: uCol3;
    // gentle pulse in size per particle
    float pulse = 1.0 + sin(uTime*(0.8+uPulse) + aIndex*0.3)*0.25*uPulse;
    vFade = 1.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(st.xy, 0.0, 1.0);
    gl_PointSize = uPointPx * pulse;
  }
`
const RENDER_FRAG = `
  precision highp float;
  uniform float uAlpha;
  varying vec3 vColor;
  void main(){
    vec2 c = gl_PointCoord - 0.5;
    float d2 = dot(c,c);
    if (d2 > 0.25) discard;
    float a = smoothstep(0.25, 0.0, d2) * uAlpha;   // soft cell
    gl_FragColor = vec4(vColor, a);
  }
`

// A pleasing asymmetric 4x4 base matrix (self-attract + mixed cross terms →
// clusters that chase each other). Scaled by the attraction slider at runtime.
const BASE_MATRIX: [number, number, number, number][] = [
  [ 0.7, -0.4,  0.1,  0.5],
  [ 0.5,  0.7, -0.4,  0.0],
  [-0.3,  0.5,  0.7, -0.3],
  [ 0.2, -0.2,  0.5,  0.7],
]

export class CellsGPUOrganism {
  mesh: THREE.Points
  count = 0
  obstacles: Obstacle[] | undefined
  mapBounds: [number, number, number, number] | null = null
  renderer: THREE.WebGLRenderer | null = null

  private params: CellsGPUParams
  private aspect = 1
  private t = 0
  private texDim = 32
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

  constructor(params: CellsGPUParams, visual: VisualParams) {
    this.params = params
    this.count = Math.min(Math.max(1, params.count | 0), MAX_CELLS)
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

    const wrap = (params.boundary ?? 'bounce') === 'wrap' ? 1 : 0
    const m = BASE_MATRIX
    this.simMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT, fragmentShader: SIM_FRAG,
      uniforms: {
        uPrev: { value: this.stateA.texture }, uField: { value: this.fieldRT.texture },
        uTexDim: { value: this.texDim }, uCount: { value: this.count },
        uAspect: { value: this.aspect }, uDt: { value: 1 / 60 }, uTime: { value: 0 },
        uFieldRes: { value: FIELD_RES },
        uAttract: { value: params.attraction }, uRepulse: { value: params.repulsion }, uPulse: { value: params.pulse },
        uRow0: { value: new THREE.Vector4(...m[0]) }, uRow1: { value: new THREE.Vector4(...m[1]) },
        uRow2: { value: new THREE.Vector4(...m[2]) }, uRow3: { value: new THREE.Vector4(...m[3]) },
        uHand: { value: new THREE.Vector2(0, 0) }, uHandForce: { value: 0 },
        uFlow: { value: new THREE.Vector2(0, 0) }, uFlowTurb: { value: 0 },
        uWrap: { value: wrap },
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
    const cols = this.speciesColors(visual)
    this.renderMat = new THREE.ShaderMaterial({
      vertexShader: RENDER_VERT, fragmentShader: RENDER_FRAG,
      uniforms: {
        uState: { value: this.stateA.texture }, uTexDim: { value: this.texDim },
        uCount: { value: this.count }, uPointPx: { value: 8 }, uAlpha: { value: 0.6 },
        uTime: { value: 0 }, uPulse: { value: params.pulse },
        uCol0: { value: cols[0] }, uCol1: { value: cols[1] }, uCol2: { value: cols[2] }, uCol3: { value: cols[3] },
      },
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    })
    this.mesh = new THREE.Points(renderGeo, this.renderMat)
    this.mesh.frustumCulled = false
  }

  private speciesColors(v: VisualParams): THREE.Color[] {
    const a = new THREE.Color(v.palette.primary)
    const b = new THREE.Color(v.palette.secondary)
    const c = new THREE.Color(v.palette.glow)
    return [a, b, c, a.clone().lerp(c, 0.5)]
  }

  private pickTexDim(count: number): number { let d = 16; while (d * d < count && d < 512) d *= 2; return d }

  setAspect(a: number) { this.aspect = a; this.simMat.uniforms.uAspect.value = a; this.fieldMat.uniforms.uAspect.value = a }

  updateParams(p: CellsGPUParams) {
    const newCount = Math.min(Math.max(1, p.count | 0), MAX_CELLS)
    const newDim = this.pickTexDim(newCount)
    if (newDim !== this.texDim) {
      this.texDim = newDim
      this.stateA.setSize(newDim, newDim); this.stateB.setSize(newDim, newDim)
      const slots = newDim * newDim
      const indices = new Float32Array(slots)
      for (let i = 0; i < slots; i++) indices[i] = i
      for (const g of [this.fieldPoints.geometry, this.mesh.geometry]) {
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(slots * 3), 3))
        g.setAttribute('aIndex', new THREE.BufferAttribute(indices, 1))
      }
      this.simMat.uniforms.uTexDim.value = newDim
      this.fieldMat.uniforms.uTexDim.value = newDim
      this.renderMat.uniforms.uTexDim.value = newDim
      this._seeded = false
    }
    this.count = newCount
    this.mesh.geometry.setDrawRange(0, newCount)
    this.params = p
    this.simMat.uniforms.uCount.value = newCount
    this.simMat.uniforms.uAttract.value = p.attraction
    this.simMat.uniforms.uRepulse.value = p.repulsion
    this.simMat.uniforms.uPulse.value = p.pulse
    this.simMat.uniforms.uWrap.value = (p.boundary ?? 'bounce') === 'wrap' ? 1 : 0
    this.fieldMat.uniforms.uCount.value = newCount
    this.renderMat.uniforms.uCount.value = newCount
    this.renderMat.uniforms.uPulse.value = p.pulse
  }

  applyVisual(visual: VisualParams) {
    const cols = this.speciesColors(visual)
    ;(this.renderMat.uniforms.uCol0.value as THREE.Color).copy(cols[0])
    ;(this.renderMat.uniforms.uCol1.value as THREE.Color).copy(cols[1])
    ;(this.renderMat.uniforms.uCol2.value as THREE.Color).copy(cols[2])
    ;(this.renderMat.uniforms.uCol3.value as THREE.Color).copy(cols[3])
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
    this.renderer.setRenderTarget(this.stateA); this.renderer.render(this.simScene, this.simCam)
    this.renderer.setRenderTarget(this.stateB); this.renderer.render(this.simScene, this.simCam)
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
    this.simMat.uniforms.uPulse.value = p.pulse * (1 + (audio.bass ?? 0) * 2)
    if (hand.detected) {
      this.simMat.uniforms.uHand.value.set((hand.indexTip.x - 0.5) * 2 * this.aspect, -(hand.indexTip.y - 0.5) * 2)
      this.simMat.uniforms.uHandForce.value = 0.3 + (hand.pinch ?? 0) * 1.2
    } else this.simMat.uniforms.uHandForce.value = 0
    if (flowState.enabled) {
      this.simMat.uniforms.uFlow.value.set(flowState.vx, flowState.vy)
      this.simMat.uniforms.uFlowTurb.value = flowState.turbulence
    } else { this.simMat.uniforms.uFlow.value.set(0, 0); this.simMat.uniforms.uFlowTurb.value = 0 }

    // 1) per-species density field
    this.fieldMat.uniforms.uState.value = this.current.texture
    this.renderer.setRenderTarget(this.fieldRT)
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.clear(true, false, false)
    this.renderer.render(this.fieldScene, this.simCam)
    // 2) sim
    packObstacles(this.simMat.uniforms, this.obstacles, this.aspect, this.mapBounds)
    const src = this.current
    const dst = src === this.stateA ? this.stateB : this.stateA
    this.simMat.uniforms.uPrev.value = src.texture
    this.simMat.uniforms.uField.value = this.fieldRT.texture
    this.renderer.setRenderTarget(dst)
    this.renderer.render(this.simScene, this.simCam)
    this.current = dst
    this.renderer.setRenderTarget(null)
    // 3) render uniforms
    const dpr = this.renderer.getPixelRatio()
    this.renderer.getSize(this._sizeV2)
    const pxPerWorld = (this._sizeV2.y * dpr) / 2
    const worldDiam = p.size * 0.06 * (1 + (audio.bass ?? 0) * 0.5) * 2.0
    this.renderMat.uniforms.uPointPx.value = Math.max(2, Math.min(64, worldDiam * pxPerWorld))
    this.renderMat.uniforms.uAlpha.value = Math.max(0.06, Math.min(0.7, 40 / Math.sqrt(this.count)))
    this.renderMat.uniforms.uTime.value = this.t
    this.renderMat.uniforms.uState.value = this.current.texture
  }

  dispose() {
    this.stateA.dispose(); this.stateB.dispose(); this.fieldRT.dispose()
    this.simMat.dispose(); this.fieldMat.dispose(); this.renderMat.dispose()
    this.fullQuad.geometry.dispose(); this.fieldPoints.geometry.dispose(); this.mesh.geometry.dispose()
  }
}
