import * as THREE from 'three'
import type { Scene as ArtScene, VisualParams, MappingShape, OrganismKind } from '../types/scene'
import type { OrganismLike } from './organisms'
import { MappingPass } from './MappingPass'
import { senseBus, readSense } from '../senses/SenseBus'
import { loadTexture } from '../lib/textureLoader'
import type { Obstacle } from '../types/scene'
import { resetCounters } from './Obstacles'
import { soundEngine } from './SoundEngine'
import { setFlow } from './Flow'
import { setTrackers, stopColorTracking } from './ColorTracker'
import { resolveShapeTexture, pruneShapeTextures, setUseMaskedBody, disposeAllContentSources } from './ContentSources'
import { startMaskedWebcam, stopMaskedWebcam } from './MaskedWebcam'
import { createOrganism, ORGANISM_DEFAULTS } from './OrganismFactory'
import { tick as timelineTick, loadTimeline } from './Timeline'
import { tick as melodyTick, loadMelody } from './MelodyEngine'
import { applyModifiers, type Modifier } from './Modifiers'

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
  /** Per-zone independent organism instances. */
  private zoneOrganisms = new Map<string, {
    kind: OrganismKind
    organism: OrganismLike
    rt: THREE.WebGLRenderTarget
    scene: THREE.Scene
  }>()

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
    this.organism = createOrganism(s.organism.kind, s.organism.values, s.visual)
    if (this.organism) {
      this.organism.setAspect(aspect)
      ;(this.organism as any).obstacles = s.obstacles ?? []
      // Some organisms (ReactionDiffusion, CellularAutomata) need access to the
      // engine renderer to run their own offscreen ping-pong simulation passes.
      ;(this.organism as any).renderer = this.renderer
      this.scene.add(this.organism.mesh)
    }
    // snapshot base values for evolution drift
    this.baseValues = { ...(s.organism.values as unknown as Record<string, number>) }
    this.evolutionT = 0
    // Load the scene's timeline (or default empty one) into the runtime
    loadTimeline(s.timeline as any)
    // Same for the AI-generated melody, if any
    loadMelody((s as any).melody ?? null)
    this.applyVisual(s.visual)
    this.mapping.apply(s.mapping)
    // Sync sonification voices to the scene's obstacles — without this the first
    // scene-load doesn't reach the SoundEngine and "Sonifier cet obstacle" stays
    // silent until the user touches an obstacle field.
    soundEngine.sync(s.obstacles ?? [])
    // Same for color trackers: scene-load should hand them to ColorTracker
    // immediately, otherwise tracker-obstacles only fire after the user re-saves.
    const trackerCfgs = (s.obstacles ?? [])
      .filter((o) => o.enabled && o.kind === 'tracker' && o.tracker)
      .map((o) => ({ id: o.id, h: o.tracker!.h, s: o.tracker!.s, v: o.tracker!.v, tolerance: o.tracker!.tolerance }))
    setTrackers(trackerCfgs)
    // And the flow field — the scene declares it but the Flow module needs it
    setFlow(s.flow)
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
    // Sync per-zone organisms BEFORE resolving textures so the zone RT exists
    this.syncZoneOrganisms(shapes)
    const ids = new Set<string>()
    for (const s of shapes) {
      ids.add(s.id)
      // If this zone has its own organism, use its RT as the source texture.
      // Otherwise fall back to the standard content (video/image/webcam/main organism).
      const zoneOrg = this.zoneOrganisms.get(s.id)
      if (zoneOrg) {
        this.mapping.setShapeTexture(s.id, zoneOrg.rt.texture)
      } else {
        const tex = resolveShapeTexture(s.id, s.content)
        this.mapping.setShapeTexture(s.id, tex)
      }
    }
    pruneShapeTextures(ids)
  }

  private syncZoneOrganisms(shapes: MappingShape[]) {
    const aspect = this.width / this.height
    const wanted = new Map<string, { kind: OrganismKind; values: any }>()
    for (const s of shapes) {
      if (s.content?.type === 'organism' && s.content.organismKind) {
        wanted.set(s.id, {
          kind: s.content.organismKind,
          values: s.content.organismValues ?? ORGANISM_DEFAULTS[s.content.organismKind],
        })
      }
    }
    // Dispose removed — IMPORTANT: clear the mapping's per-shape texture reference
    // BEFORE disposing the RT, otherwise the GPU texture is freed while MappingPass
    // still holds a stale reference and the next sample reads undefined memory.
    for (const [id, entry] of this.zoneOrganisms) {
      if (!wanted.has(id) || wanted.get(id)!.kind !== entry.kind) {
        this.mapping.setShapeTexture(id, null)
        entry.scene.remove(entry.organism.mesh)
        entry.organism.dispose()
        entry.rt.dispose()
        this.zoneOrganisms.delete(id)
      }
    }
    // Create / update
    for (const [id, params] of wanted) {
      let entry = this.zoneOrganisms.get(id)
      if (!entry) {
        const rt = new THREE.WebGLRenderTarget(512, 512, { type: THREE.HalfFloatType })
        const sc = new THREE.Scene()
        const visual = this.currentScene?.visual ?? {
          palette: { bg: '#000000', primary: '#00ffa3', secondary: '#00d4ff', glow: '#7c3aed' },
          bloom: 0.5, feedback: 0.92, blendMode: 'add' as const, texture: null,
        }
        const org = createOrganism(params.kind, params.values, visual)
        org.setAspect(1)
        sc.add(org.mesh)
        entry = { kind: params.kind, organism: org, rt, scene: sc }
        this.zoneOrganisms.set(id, entry)
      }
      entry.organism.updateParams(params.values)
      // Inherit scene-level obstacles for interaction within the zone organism too
      ;(entry.organism as any).obstacles = this.currentScene?.obstacles ?? []
    }
    // Touch aspect to avoid stale warning
    void aspect
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

    // Timeline tick: sample every track at the current playhead time and route the
    // resulting patches to the right subsystem WITHOUT going through the React store
    // (which would persist them to localStorage — we only want the visual effect).
    const tPatches = timelineTick()
    if (tPatches.length > 0) this.applyTimelinePatches(tPatches)

    // Sense bindings: read each binding's source, scale to [min,max], and route as a
    // patch (same path scheme as the timeline). Same no-persist semantics.
    const bindings = this.currentScene.senses?.bindings ?? []
    if (bindings.length > 0) {
      const patches: { path: string; value: number | string }[] = []
      for (const b of bindings) {
        let v = readSense(b.source)
        if (b.invert) v = 1 - v
        v = Math.max(0, Math.min(1, v))
        const min = b.range?.[0] ?? 0
        const max = b.range?.[1] ?? 1
        patches.push({ path: b.target, value: min + (max - min) * v })
      }
      this.applyTimelinePatches(patches)
    }

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

    if (this.organism) {
      this.organism.update(dt)
      // Layer behavior modifiers on top of the base organism update.
      // The organism owns its position/velocity Float32Arrays; we expose them via
      // duck-typed access so modifiers can mutate in place without knowing the
      // specific organism class. Modifiers no-op if the arrays aren't present.
      const mods = (this.currentScene.modifiers ?? []) as Modifier[]
      if (mods.length > 0) {
        const o = this.organism as any
        const positions: Float32Array | undefined = o.positions ?? o.heads?.array
        const velocities: Float32Array | null = o.velocities ?? null
        const count: number = o.count ?? (positions ? positions.length / 3 : 0)
        if (positions && count > 0) {
          applyModifiers(positions, velocities, count, dt, this.width / this.height, mods)
          // Mark the GPU geometry dirty so the next draw picks up modifier-written positions
          const geom = (this.organism.mesh as any).geometry
          if (geom?.attributes?.position) geom.attributes.position.needsUpdate = true
        }
      }
    }
    // Update + render per-zone organisms FIRST so their RTs are fresh for the mapping pass.
    // Clear with TRANSPARENT (alpha=0) instead of the scene bg color — otherwise the bg color
    // is baked into the zone texture and the mapping shader can't blend cleanly in AR mode.
    const zoneClear = new THREE.Color(0x000000)
    for (const entry of this.zoneOrganisms.values()) {
      entry.organism.update(dt)
      this.renderer.setRenderTarget(entry.rt)
      this.renderer.setClearColor(zoneClear, 0)
      this.renderer.clear()
      this.renderer.render(entry.scene, this.camera)
    }
    // After organisms moved, push counters → audio
    soundEngine.tick()
    // AI-generated melody sequencer — fires virtual notes; the polysynth
    // tick that follows turns them into audio in the same frame.
    melodyTick()
    // Polysynth: poll MIDI notes (USB or virtual) and trigger/release voices
    soundEngine.tickMidi()

    // render main organism to mainRT
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

  /** Apply timeline-driven patches to the live engine subsystems. Routes by path prefix
   *  so we don't waste cycles re-running expensive pipelines for unrelated keyframes. */
  private applyTimelinePatches(patches: { path: string; value: number | string }[]) {
    if (!this.currentScene || !this.organism) return
    let visualDirty = false
    let flowDirty = false
    const orgPatch: Record<string, number> = {}
    for (const p of patches) {
      const parts = p.path.split('.')
      if (parts[0] === 'organism' && parts[1] === 'values' && parts[2] && typeof p.value === 'number') {
        orgPatch[parts[2]] = p.value
      } else if (parts[0] === 'visual') {
        // Mutate scene.visual in place (visual is small + applyVisual rebuilds all the right state)
        const v: any = this.currentScene.visual
        if (parts[1] === 'palette' && parts[2]) {
          v.palette = { ...v.palette, [parts[2]]: p.value }
        } else if (parts[1]) {
          v[parts[1]] = p.value
        }
        visualDirty = true
      } else if (parts[0] === 'flow') {
        const f: any = this.currentScene.flow ?? { enabled: true, angle: 0, strength: 0, turbulence: 0 }
        if (parts[1]) f[parts[1]] = p.value
        this.currentScene.flow = f
        flowDirty = true
      }
    }
    if (Object.keys(orgPatch).length > 0) {
      this.organism.updateParams({ ...(this.currentScene.organism.values as any), ...orgPatch })
    }
    if (visualDirty) this.applyVisual(this.currentScene.visual)
    if (flowDirty && this.currentScene.flow) setFlow(this.currentScene.flow)
  }

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
    for (const e of this.zoneOrganisms.values()) { e.organism.dispose(); e.rt.dispose() }
    this.zoneOrganisms.clear()
    this.mapping.dispose()
    this.mainRT.dispose(); this.feedbackRT.dispose(); this.feedbackRT2.dispose()
    // Release any module-level singletons that would otherwise leak across HMR
    stopMaskedWebcam()
    stopColorTracking()
    disposeAllContentSources()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
