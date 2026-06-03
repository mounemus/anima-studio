import * as THREE from 'three'
import type { Scene as ArtScene, VisualParams } from '../types/scene'
import { BoidsOrganism, ParticlesOrganism, TendrilsOrganism, CellsOrganism } from './organisms'
import type { OrganismLike } from './organisms'
import { MappingPass } from './MappingPass'
import { senseBus } from '../senses/SenseBus'

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
  private stats = { fps: 0, frame: 0, fpsAcc: 0, fpsT: performance.now() }

  constructor(container: HTMLElement) {
    this.container = container
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: false,
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
    }
    if (this.organism) {
      this.organism.setAspect(aspect)
      this.scene.add(this.organism.mesh)
    }
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
  }

  applyVisual(v: VisualParams) {
    this.bg.set(v.palette.bg)
    if (this.organism) this.organism.applyVisual(v)
    this.feedbackQuadMat.uniforms.uFade.value = v.feedback
  }

  updateMapping() {
    if (this.currentScene) this.mapping.apply(this.currentScene.mapping)
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

    if (this.organism) this.organism.update(dt)

    // render organisms to mainRT
    this.renderer.setRenderTarget(this.mainRT)
    this.renderer.setClearColor(this.bg, 1)
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
    this.renderer.setClearColor(0x000000, 1)
    this.renderer.clear()
    this.renderer.render(this.mapping.scene, this.mapping.camera)
  }

  getStats() { return { fps: this.stats.fps, sense: { ...senseBus.hands } } }

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
