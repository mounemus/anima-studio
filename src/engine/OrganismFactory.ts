/** Centralized organism creation + default values per kind. */
import type { OrganismKind, VisualParams } from '../types/scene'
import {
  BoidsOrganism, ParticlesOrganism, TendrilsOrganism, CellsOrganism, WormsOrganism, SporesOrganism,
  PsychedelicOrganism, MandalaOrganism, FractalOrganism, MathCurveOrganism,
  ReactionDiffusionOrganism, CellularAutomataOrganism, HilbertCurveOrganism,
} from './organisms'
import type { OrganismLike } from './organisms'

export const ORGANISM_DEFAULTS: Record<OrganismKind, Record<string, number>> = {
  boids: { count: 1500, cohesion: 0.5, separation: 0.5, alignment: 0.5, speed: 0.7, vision: 0.4, size: 0.015, trail: 0.92 },
  particles: { count: 3000, speed: 0.6, size: 1.0, spread: 1.0, trail: 0.88, gravity: 0, turbulence: 0.5 },
  tendrils: { count: 30, length: 48, speed: 0.5, twist: 1.5, thickness: 0.01, trail: 0.95 },
  cells: { count: 50, pulse: 1.0, size: 1.2, attraction: 0.5, repulsion: 0.5, trail: 0.85 },
  worms: { count: 18, segments: 36, speed: 0.7, twist: 1.3, thickness: 0.01, trail: 0.93, segLen: 0.025 },
  spores: { count: 800, speed: 0.5, size: 0.012, bloomGain: 0.7, bloomDecay: 1.2, reactToObstacles: 1, trail: 0.9 },
  psychedelic: { count: 4000, speed: 1.0, freq: 5.0, scale: 1.0, trail: 0.94, size: 2.5 },
  mandala: { arms: 8, pointsPerArm: 64, outerRadius: 0.85, innerRadius: 0.05, waves: 3, freq: 1.0, rotation: 0.3, thickness: 0.008, layers: 2, connectors: 2, connectorOpacity: 0.4 },
  fractal: { iterations: 120, zoom: 1.0, cx: -0.7, cy: 0.27, followHand: 0.6, bailout: 4, brightness: 1.0, orbitSpeed: 0.3, orbitRadius: 0.12, rotation: 0.15, zoomBreath: 0.08 },
  mathcurve: { samples: 800, cycles: 1, a: 3, b: 5, c: 1, d: 0, scale: 0.8, speed: 0.5, thickness: 0.005, lineOpacity: 0.6 } as any,
  reactiondiffusion: { F: 0.029, k: 0.057, du: 1.0, dv: 0.5, resolution: 512, stepsPerFrame: 8, splatSize: 0.04, splatStrength: 0.9, contrast: 1.5 } as any,
  cellularautomata: { resolution: 256, ticksPerSec: 12, ageDecay: 0.92, brushSize: 0.03, brushStrength: 0.6, autoReseed: 0.5 } as any,
  hilbert: { order: 5, scale: 1, progress: 1, autoProgress: 0.15, rotation: 0.1, thickness: 0.005, handPull: 0.5, showPoints: 1, hueAlongCurve: 0.5 } as any,
}

export function createOrganism(kind: OrganismKind, values: any, visual: VisualParams): OrganismLike {
  switch (kind) {
    case 'boids': return new BoidsOrganism(values, visual) as OrganismLike
    case 'particles': return new ParticlesOrganism(values, visual) as OrganismLike
    case 'tendrils': return new TendrilsOrganism(values, visual) as OrganismLike
    case 'cells': return new CellsOrganism(values, visual) as OrganismLike
    case 'worms': return new WormsOrganism(values, visual) as OrganismLike
    case 'spores': return new SporesOrganism(values, visual) as OrganismLike
    case 'psychedelic': return new PsychedelicOrganism(values, visual) as OrganismLike
    case 'mandala': return new MandalaOrganism(values, visual) as OrganismLike
    case 'fractal': return new FractalOrganism(values, visual) as OrganismLike
    case 'mathcurve': {
      const v = { formula: 'lissajous', ...values }
      return new MathCurveOrganism(v, visual) as OrganismLike
    }
    case 'reactiondiffusion': {
      const v = { preset: 'coral', F: 0.029, k: 0.057, du: 1, dv: 0.5, resolution: 512, stepsPerFrame: 8, splatSize: 0.04, splatStrength: 0.9, contrast: 1.5, ...values }
      return new ReactionDiffusionOrganism(v, visual) as OrganismLike
    }
    case 'cellularautomata': {
      const v = { rule: 'conway', resolution: 256, ticksPerSec: 12, ageDecay: 0.92, brushSize: 0.03, brushStrength: 0.6, autoReseed: 0.5, ...values }
      return new CellularAutomataOrganism(v, visual) as OrganismLike
    }
    case 'hilbert': {
      const v = { order: 5, scale: 1, progress: 1, autoProgress: 0.15, rotation: 0.1, thickness: 0.005, handPull: 0.5, showPoints: 1, hueAlongCurve: 0.5, ...values }
      return new HilbertCurveOrganism(v, visual) as OrganismLike
    }
  }
}
