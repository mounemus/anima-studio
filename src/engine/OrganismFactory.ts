/** Centralized organism creation + default values per kind. */
import type { OrganismKind, VisualParams } from '../types/scene'
import { BoidsOrganism, ParticlesOrganism, TendrilsOrganism, CellsOrganism, WormsOrganism, SporesOrganism } from './organisms'
import type { OrganismLike } from './organisms'

export const ORGANISM_DEFAULTS: Record<OrganismKind, Record<string, number>> = {
  boids: { count: 1500, cohesion: 0.5, separation: 0.5, alignment: 0.5, speed: 0.7, vision: 0.4, size: 0.015, trail: 0.92 },
  particles: { count: 3000, speed: 0.6, size: 1.0, spread: 1.0, trail: 0.88, gravity: 0, turbulence: 0.5 },
  tendrils: { count: 30, length: 48, speed: 0.5, twist: 1.5, thickness: 0.01, trail: 0.95 },
  cells: { count: 50, pulse: 1.0, size: 1.2, attraction: 0.5, repulsion: 0.5, trail: 0.85 },
  worms: { count: 18, segments: 36, speed: 0.7, twist: 1.3, thickness: 0.01, trail: 0.93, segLen: 0.025 },
  spores: { count: 800, speed: 0.5, size: 0.012, bloomGain: 0.7, bloomDecay: 1.2, reactToObstacles: 1, trail: 0.9 },
}

export function createOrganism(kind: OrganismKind, values: any, visual: VisualParams): OrganismLike {
  switch (kind) {
    case 'boids': return new BoidsOrganism(values, visual) as OrganismLike
    case 'particles': return new ParticlesOrganism(values, visual) as OrganismLike
    case 'tendrils': return new TendrilsOrganism(values, visual) as OrganismLike
    case 'cells': return new CellsOrganism(values, visual) as OrganismLike
    case 'worms': return new WormsOrganism(values, visual) as OrganismLike
    case 'spores': return new SporesOrganism(values, visual) as OrganismLike
  }
}
