import type { Obstacle, Waveform } from '../types/scene'

export interface SoundPreset {
  id: string
  name: string
  emoji: string
  description: string
  waveform: Waveform
  cutoff: number
  notes: number[]
  density: boolean
  volume: number
  audioReactivity: number
}

export const SOUND_PRESETS: SoundPreset[] = [
  {
    id: 'drone',
    emoji: '🌬️',
    name: 'Drone ambient',
    description: 'Quartes parfaites, doux et infini',
    waveform: 'sine',
    cutoff: 1200,
    notes: [48, 55, 60, 67],
    density: true,
    volume: 0.55,
    audioReactivity: 0.1,
  },
  {
    id: 'penta',
    emoji: '🎵',
    name: 'Pentatonique haute',
    description: 'Gamme japonaise lumineuse',
    waveform: 'triangle',
    cutoff: 2400,
    notes: [60, 62, 64, 67, 69, 72, 74],
    density: true,
    volume: 0.5,
    audioReactivity: 0.2,
  },
  {
    id: 'bass',
    emoji: '🔊',
    name: 'Bass machine',
    description: 'Sub-bass et quintes, organique',
    waveform: 'sawtooth',
    cutoff: 800,
    notes: [36, 43, 48, 55, 36, 43],
    density: true,
    volume: 0.4,
    audioReactivity: 0.6,
  },
  {
    id: 'bell',
    emoji: '🔔',
    name: 'Carillon cristal',
    description: 'Cloches diaphanes, mode majeur',
    waveform: 'sine',
    cutoff: 4000,
    notes: [60, 64, 67, 72, 76, 79, 84],
    density: true,
    volume: 0.45,
    audioReactivity: 0.4,
  },
  {
    id: 'glitch',
    emoji: '⚡',
    name: 'Cluster glitch',
    description: 'Demi-tons rapprochés, électrique',
    waveform: 'square',
    cutoff: 1500,
    notes: [60, 61, 63, 66, 67, 68, 70],
    density: true,
    volume: 0.35,
    audioReactivity: 0.5,
  },
  {
    id: 'orient',
    emoji: '🌙',
    name: 'Orientale (hijaz)',
    description: 'Mode arabe, intervalles augmentés',
    waveform: 'triangle',
    cutoff: 2200,
    notes: [60, 61, 64, 65, 67, 68, 71],
    density: true,
    volume: 0.5,
    audioReactivity: 0.3,
  },
  {
    id: 'whale',
    emoji: '🐋',
    name: 'Chant baleine',
    description: 'Notes basses très longues, sub-mer',
    waveform: 'sine',
    cutoff: 600,
    notes: [29, 31, 34, 36, 41],
    density: true,
    volume: 0.6,
    audioReactivity: 0.7,
  },
  {
    id: 'arcade',
    emoji: '👾',
    name: 'Arcade 8-bit',
    description: 'Carrés rapides, jeu vidéo',
    waveform: 'square',
    cutoff: 3000,
    notes: [60, 64, 67, 72, 64, 67],
    density: true,
    volume: 0.3,
    audioReactivity: 0.4,
  },
]

/** Returns a new obstacles array with the preset applied across enabled obstacles. */
export function applyPreset(obstacles: Obstacle[], preset: SoundPreset): Obstacle[] {
  return obstacles.map((o, i) => ({
    ...o,
    sound: {
      enabled: true,
      note: preset.notes[i % preset.notes.length],
      waveform: preset.waveform,
      volume: preset.volume,
      density: preset.density,
      cutoff: preset.cutoff,
      audioReactivity: preset.audioReactivity,
    },
  }))
}
