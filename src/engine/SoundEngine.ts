/**
 * SoundEngine — sonifies obstacles via Web Audio.
 * Each obstacle gets a continuous oscillator routed through gain + lowpass.
 * Density (organisms inside) modulates gain (and slightly cutoff).
 *
 * Pentatonic auto-assigned scale: C3, D3, E3, G3, A3, C4, D4, E4, G4, A4, ...
 */
import type { Obstacle, SoundConfig, Waveform } from '../types/scene'
import { obstacleCounters } from './Obstacles'

const PENTA = [60, 62, 64, 67, 69, 72, 74, 76, 79, 81, 84]   // C, D, E, G, A
function noteFreq(midi: number): number { return 440 * Math.pow(2, (midi - 69) / 12) }

interface Voice {
  osc: OscillatorNode
  gain: GainNode
  filter: BiquadFilterNode
  cfg: SoundConfig
  lastDensity: number
}

export class SoundEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private voices = new Map<string, Voice>()
  private muted = false
  private masterVolume = 0.6
  /** Used to estimate density (count / typical normalizer). */
  totalAgents = 1

  ensure() {
    if (this.ctx) return this.ctx
    this.ctx = new AudioContext()
    this.master = this.ctx.createGain()
    this.master.gain.value = this.muted ? 0 : this.masterVolume
    this.master.connect(this.ctx.destination)
    return this.ctx
  }

  isReady() { return !!this.ctx }
  isMuted() { return this.muted }

  setMuted(m: boolean) {
    this.muted = m
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : this.masterVolume, this.ctx!.currentTime, 0.05)
  }

  setMasterVolume(v: number) {
    this.masterVolume = v
    if (!this.muted && this.master) this.master.gain.setTargetAtTime(v, this.ctx!.currentTime, 0.05)
  }

  /** Sync voices with the current obstacle list. */
  sync(obstacles: Obstacle[]) {
    if (!this.ctx || !this.master) return
    const activeIds = new Set<string>()
    let soundIdx = 0
    for (const o of obstacles) {
      if (!o.enabled || !o.sound?.enabled) continue
      activeIds.add(o.id)
      const targetNote = o.sound.note === 'auto' ? PENTA[soundIdx % PENTA.length] : (o.sound.note as number)
      soundIdx++
      let v = this.voices.get(o.id)
      if (!v) {
        const osc = this.ctx.createOscillator()
        const gain = this.ctx.createGain()
        const filter = this.ctx.createBiquadFilter()
        filter.type = 'lowpass'
        filter.Q.value = 1.2
        gain.gain.value = 0
        osc.type = o.sound.waveform
        osc.frequency.value = noteFreq(targetNote)
        filter.frequency.value = o.sound.cutoff
        osc.connect(filter)
        filter.connect(gain)
        gain.connect(this.master)
        osc.start()
        v = { osc, gain, filter, cfg: o.sound, lastDensity: 0 }
        this.voices.set(o.id, v)
      } else {
        // update changed config
        if (v.osc.type !== o.sound.waveform) v.osc.type = o.sound.waveform as Waveform
        const f = noteFreq(targetNote)
        if (Math.abs(v.osc.frequency.value - f) > 1) v.osc.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.05)
        if (Math.abs(v.filter.frequency.value - o.sound.cutoff) > 5) v.filter.frequency.setTargetAtTime(o.sound.cutoff, this.ctx.currentTime, 0.08)
        v.cfg = o.sound
      }
    }
    // Stop voices no longer present
    for (const [id, v] of this.voices) {
      if (!activeIds.has(id)) {
        try { v.gain.gain.cancelScheduledValues(this.ctx.currentTime); v.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05) } catch {}
        setTimeout(() => { try { v.osc.stop() } catch {} v.osc.disconnect(); v.filter.disconnect(); v.gain.disconnect() }, 200)
        this.voices.delete(id)
      }
    }
  }

  /** Pump density values to gains. Call once per frame after the obstacle solver. */
  tick() {
    if (!this.ctx) return
    const now = this.ctx.currentTime
    const normalizer = Math.max(50, this.totalAgents * 0.15)  // ~15% of agents = max volume
    for (const [id, v] of this.voices) {
      const count = obstacleCounters.get(id) ?? 0
      const density = Math.min(1, count / normalizer)
      v.lastDensity = density
      const target = v.cfg.volume * density
      v.gain.gain.setTargetAtTime(target, now, 0.08)
    }
  }

  /** Read-only density per obstacle id (0..1) for UI feedback. */
  density(id: string): number {
    return this.voices.get(id)?.lastDensity ?? 0
  }

  destroy() {
    for (const v of this.voices.values()) {
      try { v.osc.stop() } catch {}
      v.osc.disconnect(); v.filter.disconnect(); v.gain.disconnect()
    }
    this.voices.clear()
    this.master?.disconnect()
    this.ctx?.close()
    this.ctx = null
    this.master = null
  }
}

export const soundEngine = new SoundEngine()
