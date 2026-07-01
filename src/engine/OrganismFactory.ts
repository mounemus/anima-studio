/** Centralized organism creation + default values per kind. */
import type { OrganismKind, VisualParams } from '../types/scene'
import {
  BoidsOrganism, BoidsGPUOrganism, ParticlesOrganism, ParticlesGPUOrganism, TendrilsOrganism, CellsOrganism, CellsGPUOrganism, WormsOrganism, SporesOrganism,
  PsychedelicOrganism, MandalaOrganism, FractalOrganism, MathCurveOrganism,
  ReactionDiffusionOrganism, CellularAutomataOrganism, HilbertCurveOrganism,
  MengerSpongeOrganism, SuperShape3DOrganism,
  ParticleSwarm3DOrganism, CrystalGrowthOrganism,
  MurmurationOrganism, MurmurationGPUOrganism,
} from './organisms'
import type { OrganismLike } from './organisms'

export const ORGANISM_DEFAULTS: Record<OrganismKind, Record<string, number>> = {
  boids: { count: 1500, cohesion: 0.5, separation: 0.5, alignment: 0.5, speed: 0.7, vision: 0.4, size: 0.015, trail: 0.92, gpu: 1 },
  particles: { count: 3000, speed: 0.6, size: 1.0, spread: 1.0, trail: 0.88, gravity: 0, turbulence: 0.5, gpu: 1 },
  tendrils: { count: 30, length: 48, speed: 0.5, twist: 1.5, thickness: 0.01, trail: 0.95 },
  cells: { count: 50, pulse: 1.0, size: 1.2, attraction: 0.5, repulsion: 0.5, trail: 0.85, gpu: 1 },
  worms: { count: 18, segments: 36, speed: 0.7, twist: 1.3, thickness: 0.01, trail: 0.93, segLen: 0.025 },
  spores: { count: 800, speed: 0.5, size: 0.012, bloomGain: 0.7, bloomDecay: 1.2, reactToObstacles: 1, trail: 0.9 },
  psychedelic: { count: 4000, speed: 1.0, freq: 5.0, scale: 1.0, trail: 0.94, size: 2.5 },
  mandala: { arms: 8, pointsPerArm: 64, outerRadius: 0.85, innerRadius: 0.05, waves: 3, freq: 1.0, rotation: 0.3, thickness: 0.008, layers: 2, connectors: 2, connectorOpacity: 0.4 },
  fractal: { iterations: 120, zoom: 1.0, cx: -0.7, cy: 0.27, followHand: 0.6, bailout: 4, brightness: 1.0, orbitSpeed: 0.3, orbitRadius: 0.12, rotation: 0.15, zoomBreath: 0.08 },
  mathcurve: { samples: 800, cycles: 1, a: 3, b: 5, c: 1, d: 0, scale: 0.8, speed: 0.5, thickness: 0.005, lineOpacity: 0.6 } as any,
  reactiondiffusion: { F: 0.029, k: 0.057, du: 1.0, dv: 0.5, resolution: 512, stepsPerFrame: 8, splatSize: 0.04, splatStrength: 0.9, contrast: 1.5 } as any,
  cellularautomata: { resolution: 256, ticksPerSec: 12, ageDecay: 0.92, brushSize: 0.03, brushStrength: 0.6, autoReseed: 0.5 } as any,
  hilbert: { order: 5, scale: 1, progress: 1, autoProgress: 0.15, rotation: 0.1, thickness: 0.005, handPull: 0.5, showPoints: 1, hueAlongCurve: 0.5 } as any,
  menger: { depth: 3, autoOrbitSpeed: 0.4, fov: 55, twistAmount: 0.3, cubeSize: 0.95, ambient: 0.3, bloom: 0.3 } as any,
  supershape3d: { m1: 6, n1: 0.6, n2: 0.5, n3: 1.5, m2: 8, n4: 0.6, n5: 0.5, n6: 1.5, resolution: 64, scale: 1, autoOrbitSpeed: 0.3, fov: 55, morphSpeed: 0.3, pointSize: 2, wireframe: 1 } as any,
  swarm3d: { count: 600, speed: 1.2, cohesion: 0.6, separation: 0.8, alignment: 0.5, vision: 0.18, bounds: 1, pointSize: 2, autoOrbitSpeed: 0.25, fov: 55, trail: 0.5 } as any,
  crystal: { maxCubes: 1500, growthRate: 12, cubeSize: 0.95, gridResolution: 28, autoOrbitSpeed: 0.3, fov: 55, ambient: 0.4, emissive: 0.2 } as any,
  murmuration: { count: 3000, cohesion: 0.6, separation: 1.0, alignment: 2.2, swirl: 0.4, speed: 1.2, vision: 0.18, size: 0.015, flapSpeed: 14, flapAmplitude: 0.6, predatorResponse: 1.5, depthSpread: 0.7, trail: 0.92, gpu: 1 } as any,
}

export function createOrganism(kind: OrganismKind, values: any, visual: VisualParams): OrganismLike {
  switch (kind) {
    case 'boids': {
      const v = { count: 1500, cohesion: 0.5, separation: 0.5, alignment: 0.5, speed: 0.7, vision: 0.4, size: 0.015, trail: 0.92, gpu: 1, ...values }
      // GPU path (continuum flocking, 100k+) unless gpu:0. Fallback CPU keeps the
      // physical-obstacle response (solveObstacles/silhouette) the GPU path omits.
      if (v.gpu !== 0) return new BoidsGPUOrganism(v, visual) as OrganismLike
      return new BoidsOrganism(v, visual) as OrganismLike
    }
    case 'particles': {
      const v = { count: 3000, speed: 0.6, size: 1.0, spread: 1.0, trail: 0.88, gravity: 0, turbulence: 0.5, boundary: 'respawn', gpu: 1, ...values }
      if (v.gpu !== 0) return new ParticlesGPUOrganism(v, visual) as OrganismLike
      return new ParticlesOrganism(v, visual) as OrganismLike
    }
    case 'tendrils': return new TendrilsOrganism(values, visual) as OrganismLike
    case 'cells': {
      const v = { count: 50, pulse: 1.0, size: 1.2, attraction: 0.5, repulsion: 0.5, trail: 0.85, gpu: 1, ...values }
      // GPU "particle life" (4 species, 50k+) unless gpu:0. Fallback CPU keeps the
      // O(N²) pairwise + obstacle bounce physics for small dense colonies.
      if (v.gpu !== 0) return new CellsGPUOrganism(v, visual) as OrganismLike
      return new CellsOrganism(v, visual) as OrganismLike
    }
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
    case 'menger': {
      const v = { depth: 3, autoOrbitSpeed: 0.4, fov: 55, twistAmount: 0.3, cubeSize: 0.95, ambient: 0.3, bloom: 0.3, ...values }
      return new MengerSpongeOrganism(v, visual) as OrganismLike
    }
    case 'supershape3d': {
      const v = { m1: 6, n1: 0.6, n2: 0.5, n3: 1.5, m2: 8, n4: 0.6, n5: 0.5, n6: 1.5, resolution: 64, scale: 1, autoOrbitSpeed: 0.3, fov: 55, morphSpeed: 0.3, pointSize: 2, wireframe: 1, ...values }
      return new SuperShape3DOrganism(v, visual) as OrganismLike
    }
    case 'swarm3d': {
      const v = { count: 600, speed: 1.2, cohesion: 0.6, separation: 0.8, alignment: 0.5, vision: 0.18, bounds: 1, pointSize: 2, autoOrbitSpeed: 0.25, fov: 55, trail: 0.5, ...values }
      return new ParticleSwarm3DOrganism(v, visual) as OrganismLike
    }
    case 'crystal': {
      const v = { maxCubes: 1500, growthRate: 12, cubeSize: 0.95, gridResolution: 28, autoOrbitSpeed: 0.3, fov: 55, ambient: 0.4, emissive: 0.2, ...values }
      return new CrystalGrowthOrganism(v, visual) as OrganismLike
    }
    case 'murmuration': {
      const v = { count: 3000, cohesion: 0.6, separation: 1.0, alignment: 2.2, swirl: 0.4, speed: 1.2, vision: 0.18, size: 0.015, flapSpeed: 14, flapAmplitude: 0.6, predatorResponse: 1.5, depthSpread: 0.7, trail: 0.92, gpu: 1, ...values }
      // GPU path (continuum flocking, scales to 100k+) unless explicitly disabled
      // with gpu:0. The GPU organism runs its sim in shaders using the engine
      // renderer (attached after construction), like ReactionDiffusion.
      if (v.gpu !== 0) return new MurmurationGPUOrganism(v, visual) as OrganismLike
      return new MurmurationOrganism(v, visual) as OrganismLike
    }
  }
}
