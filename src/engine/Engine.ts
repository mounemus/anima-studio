import * as THREE from 'three'
import type { Scene as ArtScene, VisualParams } from '../types/scene'
import { BoidsOrganism, ParticlesOrganism, TendrilsOrganism, CellsOrganism, WormsOrganism, SporesOrganism } from './organisms'
import type { OrganismLike } from './organisms'
import { MappingPass } from './MappingPass'
import { senseBus } from '../senses/SenseBus'
import { loadTexture } from '../lib/textureLoader'
import type { Obstacle } from '../types/scene'
import { resetCounters } from './Obstacles'
import { soundEngine } from './SoundEngine'
import { setFlow } from './Flow'
import { setTrackers } from './ColorTracker'
import { resolveShapeTexture, pruneShapeTextures, setUseMaskedBody } from './ContentSources'
import { startMaskedWebcam, stopMaskedWebcam } from './MaskedWebcam'

export class Engine {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.OrthographicCamera()
  private organism: OrganismLike | null = null
  private feedbackRT: THREE.WebGLRenderTarget
  private feedbackRT2: THREE.WebGLRenderTarget
  private feedbackQuadScene = new THREE.Scene()
  private feedbackQuadMat: THREE.ShaderMaterial
  private mapping = new MappingPass()
  private mainRT: THREE.WebGLRenderTarget
  private currentScene: ArtScene | null = null
  private lastT = performance.now()
  private rafId = 0
  private container: HTMLElement
  private width = 1; private height = 1
  private bg = new THREE.Color(0x06070d)
  private bgAlpha = 1
  private stats = { fps: 0, frame: 0, fpsAcc: 0, fpsT: performance.now() }
  private currentTextureUrl: string | null = null
  private evolutionT = 0
  private baseValues: Record<string, number> = {}

  constructor(container: HTMLElement) {
    this.container = container
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: true,                  // allow transparent canvas for AR/mirror mode
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,  // for screenshot
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setClearColor(this.bg, 1)
    container.appendChild(this.renderer.domElement)
    const canvas = this.renderer.domElement
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.style.display = 'block'

    this.camera.left = -1; this.camera.right = 1
    this.camera.top = 1; this.camera.bottom = -1
    this.camera.near = -1; this.camera.far = 1
    this.camera.updateProjectionMatrix()

    this.mainRT = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType })
    this.feedbackRT = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType })
    this.feedbackRT2 = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType })

    this.feedbackQuadMat = new THREE.ShaderMaterial({
      uniforms: {
        uPrev: { value: null },
        uCurr: { value: null },
        uFade: { value: 0.92 },
      },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position,1.0); }`,
      fragmentShader: `
        varying vec2 vUv;
        uniform sampler2D uPrev;
        uniform sampler2D uCurr;
        uniform float uFade;
        void main() {
          vec3 prev = texture2D(uPrev, vUv).rgb * uFade;
          vec3 curr = texture2D(uCurr, vUv).rgb;
          gl_FragColor = vec4(max(prev, curr), 1.0);
        }
      `,
    })
    const fbMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.feedbackQuadMat)
    this.feedbackQuadScene.add(fbMesh)

    this.resize()
    window.addEventListener('resize', this.resize)
    this.loop()
  }

  resize = () => {
    const r = this.container.getBoundingClientRect()
    const w = Math.max(2, Math.floor(r.width))
    const h = Math.max(2, Math.floor(r.height))
    if (w === this.width && h === this.height) return
    this.width = w; this.height = h
    this.renderer.setSize(w, h, false)
    const dpr = this.renderer.getPixelRatio()
    const rtW = Math.floor(w * dpr)
    const rtH = Math.floor(h * dpr)
    this.mainRT.setSize(rtW, rtH)
    this.feedbackRT.setSize(rtW, rtH)
    this.feedbackRT2.setSize(rtW, rtH)
    const aspect = w / h
    this.camera.left = -aspect; this.camera.right = aspect
    this.camera.updateProjectionMatrix()
    if (this.organism) this.organism.setAspect(aspect)
  }

  loadScene(s: ArtScene) {
    this.currentScene = s
    if (this.organism) {
      this.scene.remove(this.organism.mesh)
      this.organism.dispose()
      this.organism = null
    }
    const aspect = this.width / this.height
    switch (s.organism.kind) {
      case 'boids': this.organism = new BoidsOrganism(s.organism.values, s.visual); break
      case 'particles': this.organism = new ParticlesOrganism(s.organism.values, s.visual); break
      case 'tendrils': this.organism = new TendrilsOrganism(s.organism.values, s.visual); break
      case 'cells': this.organism = new CellsOrganism(s.organism.values, s.visual); break
      case 'worms': this.organism = new WormsOrganism(s.organism.values, s.visual); break
      case 'spores': this.organism = new SporesOrganism(s.organism.values, s.visual); break
    }
    if (this.organism) {
      this.organism.setAspect(aspect)
      ;(this.organism as any).obstacles = s.obstacles ?? []
      this.scene.add(this.organism.mesh)
    }
    // snapshot base values for evolution drift
    this.baseValues = { ...(s.organism.values as unknown as Record<string, number>) }
    this.evolutionT = 0
    this.applyVisual(s.visual)
    this.mapping.apply(s.mapping)
    // clear feedback
    this.renderer.setRenderTarget(this.feedbackRT)
    this.renderer.clear()
    this.renderer.setRenderTarget(this.feedbackRT2)
    this.renderer.clear()
    this.renderer.setRenderTarget(null)
  }

  updateOrganismParams(p: any) {
    if (this.organism) this.organism.updateParams(p)
    this.baseValues = { ...(p as unknown as Record<string, number>) }
  }

  applyVisual(v: VisualParams) {
    if (this.currentScene) this.currentScene = { ...this.currentScene, visual: v }
    this.bg.set(v.palette.bg)
    if (this.organism) this.organism.applyVisual(v)
    this.feedbackQuadMat.uniforms.uFade.value = v.feedback
    // texture sync
    const newUrl = v.texture?.url ?? null
    if (newUrl !== this.currentTextureUrl) {
      this.currentTextureUrl = newUrl
      if (newUrl) {
        loadTexture(newUrl).then((tex) => {
          if (this.currentTextureUrl === newUrl && this.organism?.setTexture) {
            this.organism.setTexture(tex)
          }
        }).catch((e) => console.warn('Texture load failed', e))
      } else {
        this.organism?.setTexture?.(null)
      }
    }
  }


  updateObstacles(obs: Obstacle[]) {
    if (this.currentScene) this.currentScene = { ...this.currentScene, obstacles: obs }
    if (this.organism) (this.organism as any).obstacles = obs
    soundEngine.sync(obs)
    // Sync color trackers
    const trackers = obs
      .filter((o) => o.enabled && o.kind === 'tracker' && o.tracker)
      .map((o) => ({ id: o.id, h: o.tracker!.h, s: o.tracker!.s, v: o.tracker!.v, tolerance: o.tracker!.tolerance }))
    setTrackers(trackers)
  }

  updateFlow(flow: import('../types/scene').FlowField | undefined) {
    if (this.currentScene) this.currentScene = { ...this.currentScene, flow }
    setFlow(flow)
  }

  updateMapping(cfg?: import('../types/scene').MappingConfig) {
    if (cfg) {
      if (this.currentScene) this.currentScene = { ...this.currentScene, mapping: cfg }
      this.mapping.apply(cfg)
    } else if (this.currentScene) {
      this.mapping.apply(this.currentScene.mapping)
    }
    // Sync per-shape content textures
    const c = cfg ?? this.currentScene?.mapping
    const shapes = c?.shapes ?? []
    // Update the masked-body flag BEFORE resolving textures so webcam zones get the right one
    setUseMaskedBody(!!c?.arMaskBody)
    if (c?.arMaskBody) startMaskedWebcam(); else stopMaskedWebcam()
    const ids = new Set<string>()
    for (const s of shapes) {
      ids.add(s.id)
      const tex = resolveShapeTexture(s.id, s.content)
      this.mapping.setShapeTexture(s.id, tex)
    }
    pruneShapeTextures(ids)
  }

  loop = () => {
    this.rafId = requestAnimationFrame(this.loop)
    const now = performance.now()
    const dt = Math.min(0.05, (now - this.lastT) / 1000)
    this.lastT = now

    // stats
    this.stats.frame++
    this.stats.fpsAcc++
    if (now - this.stats.fpsT > 500) {
      this.stats.fps = Math.round(this.stats.fpsAcc * 1000 / (now - this.stats.fpsT))
      this.stats.fpsAcc = 0
      this.stats.fpsT = now
    }

    if (!this.currentScene) return

    // Reset per-frame obstacle counters; record total population for density normalization
    resetCounters()
    soundEngine.totalAgents = (this.currentScene.organism.values as any).count ?? 0

    // Evolution: organic drift of organism params via low-freq noise (in-engine, no React loop)
    if (this.currentScene.evolution.enabled && this.organism) {
      this.evolutionT += dt * this.currentScene.evolution.driftSpeed
      const amp = this.currentScene.evolution.amplitude
      const evolved: Record<string, number> = { ...this.baseValues }
      let idx = 0
      for (const k in this.baseValues) {
        const base = this.baseValues[k]
        if (typeof base !== 'number' || k === 'count' || k === 'length') continue
        const n = Math.sin(this.evolutionT * (0.7 + idx * 0.3) + idx * 1.7) * 0.7
                + Math.sin(this.evolutionT * 2.3 + idx * 0.9) * 0.3
        evolved[k] = Math.max(0, base * (1 + n * amp))
        idx++
      }
      this.organism.updateParams(evolved)
    }

    if (this.organism) this.organism.update(dt)
    // After organisms moved, push counters → audio
    soundEngine.tick()

    // render organisms to mainRT
    this.renderer.setRenderTarget(this.mainRT)
    this.renderer.setClearColor(this.bg, this.bgAlpha)
    this.renderer.clear()
    this.renderer.render(this.scene, this.camera)

    // feedback blend mainRT into feedbackRT
    this.feedbackQuadMat.uniforms.uPrev.value = this.feedbackRT.texture
    this.feedbackQuadMat.uniforms.uCurr.value = this.mainRT.texture
    this.renderer.setRenderTarget(this.feedbackRT2)
    this.renderer.render(this.feedbackQuadScene, this.camera)
    // swap
    const tmp = this.feedbackRT
    this.feedbackRT = this.feedbackRT2
    this.feedbackRT2 = tmp

    // final draw: mapping (always-on; identity quad if no mapping)
    this.mapping.setSource(this.feedbackRT.texture)
    this.renderer.setRenderTarget(null)
    this.renderer.setClearColor(0x000000, this.bgAlpha)
    this.renderer.clear()
    this.renderer.render(this.mapping.scene, this.mapping.camera)
  }

  getStats() { return { fps: this.stats.fps, sense: { ...senseBus.hands } } }

  /** Switch between opaque rendering (with bg color) and transparent (for AR mirror overlay). */
  setTransparent(transparent: boolean) {
    this.bgAlpha = transparent ? 0 : 1
    this.mapping.setTransparent(transparent)
  }

  /** Expose renderer for advanced integrations (WebXR session). */
  getRenderer() { return this.renderer }

  getCanvas() { return this.renderer.domElement }

  destroy() {
    cancelAnimationFrame(this.rafId)
    window.removeEventListener('resize', this.resize)
    this.organism?.dispose()
    this.mapping.dispose()
    this.mainRT.dispose(); this.feedbackRT.dispose(); this.feedbackRT2.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
