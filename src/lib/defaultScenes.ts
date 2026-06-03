import { defaultMapping, type Scene } from '../types/scene'

const now = () => Date.now()

const baseSenseBindings = () => [
  { source: 'hand.index' as const, target: 'organism.speed', range: [0.5, 2.0] as [number, number] },
  { source: 'audio.bass' as const, target: 'organism.size', range: [0.5, 2.5] as [number, number] },
]

export const defaultScenes: Scene[] = [
  {
    id: 'plankton',
    name: '🌊 Plancton bioluminescent',
    createdAt: now(),
    updatedAt: now(),
    organism: {
      kind: 'boids',
      values: { count: 1800, cohesion: 0.6, separation: 0.7, alignment: 0.5, speed: 0.7, vision: 0.4, size: 0.015, trail: 0.92 },
    },
    visual: {
      palette: { bg: '#020611', primary: '#00ffa3', secondary: '#00d4ff', glow: '#7c3aed' },
      bloom: 0.6, feedback: 0.93, blendMode: 'add',
    },
    senses: { hands: true, audio: true, light: false, bindings: baseSenseBindings() },
    evolution: { enabled: true, driftSpeed: 0.05, amplitude: 0.15 },
    mapping: defaultMapping(),
    notes: 'Inspiré du plancton bioluminescent. La main attire le banc, les graves font respirer les agents.',
  },
  {
    id: 'mycelium',
    name: '🍄 Mycélium pulsé',
    createdAt: now(),
    updatedAt: now(),
    organism: {
      kind: 'tendrils',
      values: { count: 32, length: 48, speed: 0.45, twist: 1.6, thickness: 0.01, trail: 0.95 },
    },
    visual: {
      palette: { bg: '#080205', primary: '#ff6ba6', secondary: '#7c3aed', glow: '#ffd54f' },
      bloom: 0.5, feedback: 0.95, blendMode: 'add',
    },
    senses: { hands: true, audio: true, light: false, bindings: [] },
    evolution: { enabled: false, driftSpeed: 0.02, amplitude: 0.1 },
    mapping: defaultMapping(),
    notes: 'Tendrils qui s\'enroulent et se cherchent. La main les attire ; les médiums modulent leur vitesse.',
  },
  {
    id: 'stardust',
    name: '✨ Poussière d\'étoiles',
    createdAt: now(),
    updatedAt: now(),
    organism: {
      kind: 'particles',
      values: { count: 4000, speed: 0.6, size: 1.2, spread: 1.2, trail: 0.88, gravity: -0.2, turbulence: 0.7 },
    },
    visual: {
      palette: { bg: '#010013', primary: '#ffffff', secondary: '#9be7ff', glow: '#ffe5a8' },
      bloom: 0.4, feedback: 0.88, blendMode: 'add',
    },
    senses: { hands: true, audio: true, light: false, bindings: [] },
    evolution: { enabled: true, driftSpeed: 0.08, amplitude: 0.2 },
    mapping: defaultMapping(),
    notes: 'Particules génératives. Le main attire/pousse selon le pinch.',
  },
  {
    id: 'colony',
    name: '🧫 Colonie cellulaire',
    createdAt: now(),
    updatedAt: now(),
    organism: {
      kind: 'cells',
      values: { count: 60, pulse: 1.2, size: 1.4, attraction: 0.6, repulsion: 0.7, trail: 0.85 },
    },
    visual: {
      palette: { bg: '#030610', primary: '#7c3aed', secondary: '#00d4ff', glow: '#ff6ba6' },
      bloom: 0.5, feedback: 0.85, blendMode: 'add',
    },
    senses: { hands: true, audio: true, light: true, bindings: [] },
    evolution: { enabled: true, driftSpeed: 0.03, amplitude: 0.1 },
    mapping: defaultMapping(),
    notes: 'Colonie de cellules qui pulsent au rythme des basses.',
  },
]
