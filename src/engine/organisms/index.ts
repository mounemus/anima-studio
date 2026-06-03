export { BoidsOrganism } from './Boids'
export { ParticlesOrganism } from './Particles'
export { TendrilsOrganism } from './Tendrils'
export { CellsOrganism } from './Cells'

export interface OrganismLike {
  mesh: import('three').Object3D
  setAspect(a: number): void
  update(dt: number): void
  applyVisual(v: import('../../types/scene').VisualParams): void
  updateParams(p: any): void
  dispose(): void
}
