export { BoidsOrganism } from './Boids'
export { ParticlesOrganism } from './Particles'
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

export interface OrganismLike {
  mesh: import('three').Object3D
  setAspect(a: number): void
  update(dt: number): void
  applyVisual(v: import('../../types/scene').VisualParams): void
  updateParams(p: any): void
  setTexture?(tex: import('three').Texture | null): void
  dispose(): void
}
