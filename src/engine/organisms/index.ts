export { BoidsOrganism } from './Boids'
export { BoidsGPUOrganism } from './BoidsGPU'
export { ParticlesOrganism } from './Particles'
export { ParticlesGPUOrganism } from './ParticlesGPU'
export { TendrilsOrganism } from './Tendrils'
export { CellsOrganism } from './Cells'
export { WormsOrganism } from './Worms'
export { SporesOrganism } from './Spores'
export { PsychedelicOrganism } from './Psychedelic'
export { MandalaOrganism } from './Mandala'
export { FractalOrganism } from './Fractal'
export { MathCurveOrganism } from './MathCurve'
export { ReactionDiffusionOrganism } from './ReactionDiffusion'
export { CellularAutomataOrganism } from './CellularAutomata'
export { HilbertCurveOrganism } from './HilbertCurve'
export { MengerSpongeOrganism } from './MengerSponge'
export { SuperShape3DOrganism } from './SuperShape3D'
export { MurmurationOrganism } from './Murmuration'
export { MurmurationGPUOrganism } from './MurmurationGPU'
export { ParticleSwarm3DOrganism } from './ParticleSwarm3D'
export { CrystalGrowthOrganism } from './CrystalGrowth'

export interface OrganismLike {
  mesh: import('three').Object3D
  setAspect(a: number): void
  update(dt: number): void
  applyVisual(v: import('../../types/scene').VisualParams): void
  updateParams(p: any): void
  setTexture?(tex: import('three').Texture | null): void
  dispose(): void
  /** Optional mouse interaction — only implemented by 3D organisms (Menger,
   *  SuperShape3D, ParticleSwarm3D, CrystalGrowth). Engine forwards normalized
   *  mouse events from the stage canvas. dxNorm/dyNorm are in [-1,1] per drag,
   *  wheelDelta is in standard wheel units (positive = zoom out). */
  mouseInteract?(ev: MouseInteractEvent): void
}

export interface MouseInteractEvent {
  /** 'drag' = pointer moved while button down ; 'wheel' = scroll wheel. */
  kind: 'drag' | 'wheel' | 'pinch-end'
  /** Drag deltas in normalized screen units (-1 .. 1). */
  dxNorm?: number
  dyNorm?: number
  /** Wheel delta (positive = zoom out). */
  wheelDelta?: number
}
