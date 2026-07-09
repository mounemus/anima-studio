/**
 * SoundEngine — sonifies obstacles via Web Audio.
 * Each obstacle gets a continuous oscillator routed through gain + lowpass.
 * Density (organisms inside) modulates gain (and slightly cutoff).
 *
 * Pentatonic auto-assigned scale: C3, D3, E3, G3, A3, C4, D4, E4, G4, A4, ...
 */
import type { Obstacle, SoundConfig, Waveform } from '../types/scene'
import { obstacleCounters } from './Obstacles'
import { senseBus } from '../senses/SenseBus'

const PENTA = [60, 62, 64, 67, 69, 72, 74, 76, 79, 81, 84]   // C, D, E, G, A
function noteFreq(midi: number): number { return 440 * Math.pow(2, (midi - 69) / 12) }

interface Voice {
  osc: OscillatorNode
  gain: GainNode
  filter: BiquadFilterNode
  cfg: SoundConfig
  lastDensity: number
}

// ---------------- MIDI polysynth (notes from senseBus.midi.notes) ----------------

interface MidiVoice {
  osc: OscillatorNode
  gain: GainNode
  releaseTimer: number | null
  note: number
}

export interface MidiSynthConfig {
  enabled: boolean
  waveform: Waveform
  /** 0..1 — overall mix into the master bus */
  volume: number
  /** Attack time (s). */
  attack: number
  /** Release time (s). */
  release: number
  /** Filter cutoff in Hz (modulated up by mod wheel). */
  filterCutoff: number
  /** Resonance. */
  filterQ: number
}

const MIDI_SYNTH_DEFAULT: MidiSynthConfig = {
  enabled: true, waveform: 'triangle', volume: 0.5,
  attack: 0.008, release: 0.35,
  filterCutoff: 2200, filterQ: 1.5,
}

export class SoundEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private recDest: MediaStreamAudioDestinationNode | null = null
  private voices = new Map<string, Voice>()
  private muted = false
  private masterVolume = 0.6
  /** Used to estimate density (count / typical normalizer). */
  totalAgents = 1
  // MIDI synth state
  private midiBus: GainNode | null = null
  private midiFilter: BiquadFilterNode | null = null
  private midiVoices = new Map<number, MidiVoice>()  // note → voice
  private prevNoteOn = new Float32Array(128)         // edge-detect note on/off
  midiSynth: MidiSynthConfig = { ...MIDI_SYNTH_DEFAULT }

  ensure() {
    if (this.ctx) {
      // The context can fall into 'suspended' after a tab is backgrounded or
      // when first created from a non-gesture path. resume() is a no-op if it's
      // already running; without it the whole app goes silent with no error.
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {})
      return this.ctx
    }
    this.ctx = new AudioContext()
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {})
    this.master = this.ctx.createGain()
    this.master.gain.value = this.muted ? 0 : this.masterVolume
    this.master.connect(this.ctx.destination)
    // MIDI synth bus: dedicated GainNode + shared filter routed into master
    this.midiBus = this.ctx.createGain()
    this.midiBus.gain.value = this.midiSynth.volume
    this.midiFilter = this.ctx.createBiquadFilter()
    this.midiFilter.type = 'lowpass'
    this.midiFilter.frequency.value = this.midiSynth.filterCutoff
    this.midiFilter.Q.value = this.midiSynth.filterQ
    this.midiBus.connect(this.midiFilter)
    this.midiFilter.connect(this.master)
    return this.ctx
  }

  isReady() { return !!this.ctx }
  isMuted() { return this.muted }

  /** Returns a live MediaStream of the master audio bus for video recording.
   *  Lazily taps the master gain via a MediaStreamAudioDestinationNode so the
   *  recorded WebM carries the sonified obstacles + MIDI synth, not silence.
   *  Returns null if audio was never started (ensure() not called yet). */
  getRecordingAudioStream(): MediaStream | null {
    if (!this.ctx || !this.master) return null
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {})
    if (!this.recDest) {
      this.recDest = this.ctx.createMediaStreamDestination()
      this.master.connect(this.recDest)   // tap, doesn't affect speaker output
    }
    return this.recDest.stream
  }

  setMuted(m: boolean) {
    this.muted = m
    if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {})
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
    const bass = senseBus.audio.bass
    const high = senseBus.audio.high
    for (const [id, v] of this.voices) {
      const count = obstacleCounters.get(id) ?? 0
      const density = Math.min(1, count / normalizer)
      v.lastDensity = density
      // Audio reactivity: bass boosts volume, highs open cutoff
      const ar = v.cfg.audioReactivity ?? 0
      const audioBoost = 1 + ar * bass * 1.8
      // Drone mode (density: false) → constant tone at configured volume so the
      // user hears the obstacle as soon as "Sonifier" is enabled, even when no
      // organism is inside. Density mode (default) → volume scales with how
      // many agents are currently passing through the obstacle.
      // Always keep a small floor so the voice doesn't feel "dead" — empirically
      // 12% of the configured volume is audible but not intrusive.
      const droneMode = v.cfg.density === false
      const densityFactor = droneMode ? 1 : Math.max(0.12, density)
      const target = v.cfg.volume * densityFactor * audioBoost
      v.gain.gain.setTargetAtTime(target, now, 0.08)
      if (ar > 0) {
        const liveCutoff = v.cfg.cutoff * (1 + ar * high * 2.5)
        v.filter.frequency.setTargetAtTime(Math.min(12000, liveCutoff), now, 0.05)
      }
    }
  }

  /** Read-only density per obstacle id (0..1) for UI feedback. */
  density(id: string): number {
    return this.voices.get(id)?.lastDensity ?? 0
  }

  /** Update MIDI synth config (waveform / volume / envelopes / filter). */
  setMidiSynth(patch: Partial<MidiSynthConfig>) {
    this.midiSynth = { ...this.midiSynth, ...patch }
    if (this.midiBus) this.midiBus.gain.setTargetAtTime(this.midiSynth.volume, this.ctx!.currentTime, 0.05)
    if (this.midiFilter) {
      this.midiFilter.frequency.setTargetAtTime(this.midiSynth.filterCutoff, this.ctx!.currentTime, 0.05)
      this.midiFilter.Q.setTargetAtTime(this.midiSynth.filterQ, this.ctx!.currentTime, 0.05)
    }
  }

  /** Poll senseBus.midi.notes and trigger/release voices. Call once per frame. */
  tickMidi() {
    if (!this.ctx || !this.midiBus || !this.midiFilter) return
    if (!this.midiSynth.enabled) {
      // Kill any sustaining voices
      if (this.midiVoices.size > 0) {
        for (const note of Array.from(this.midiVoices.keys())) this.releaseNote(note)
      }
      this.prevNoteOn.fill(0)
      return
    }
    const now = this.ctx.currentTime
    const notes = senseBus.midi.notes
    // Mod wheel modulates the filter cutoff smoothly
    const modAmount = senseBus.midi.mod
    const cutoff = Math.min(12000, this.midiSynth.filterCutoff * (1 + modAmount * 4))
    this.midiFilter.frequency.setTargetAtTime(cutoff, now, 0.04)
    // Edge-detect each note
    for (let n = 21; n < 109; n++) {  // 88-key piano range
      const v = notes[n] ?? 0
      const wasOn = this.prevNoteOn[n] > 0
      const isOn = v > 0
      if (isOn && !wasOn) this.triggerNote(n, v)
      else if (!isOn && wasOn) this.releaseNote(n)
      this.prevNoteOn[n] = v
    }
  }

  /** Pluck a note : note-on then auto-release after holdMs → a struck/plucked
   *  sound for the hand-played instrument. Ensures + resumes the audio context. */
  pluckNote(note: number, velocity = 0.7, holdMs = 90) {
    this.ensure()
    if (!this.ctx) return
    if (!this.midiSynth.enabled) return
    this.triggerNote(note, velocity)
    window.setTimeout(() => this.releaseNote(note), Math.max(20, holdMs))
  }

  /** Enable/disable + reach the MIDI polysynth so an instrument organism can play it. */
  enableSynth(on: boolean) { this.midiSynth.enabled = on }

  private triggerNote(note: number, velocity: number) {
    if (!this.ctx || !this.midiBus) return
    // If a voice for this note already exists (re-trigger), kill it first
    const existing = this.midiVoices.get(note)
    if (existing) {
      try { existing.osc.stop() } catch {}
      existing.osc.disconnect(); existing.gain.disconnect()
      if (existing.releaseTimer) clearTimeout(existing.releaseTimer)
      this.midiVoices.delete(note)
    }
    // Polyphony cap: kill oldest if we hit 24 voices
    if (this.midiVoices.size >= 24) {
      const oldestKey = this.midiVoices.keys().next().value
      if (oldestKey !== undefined) this.releaseNote(oldestKey)
    }
    const now = this.ctx.currentTime
    const osc = this.ctx.createOscillator()
    const gain = this.ctx.createGain()
    osc.type = this.midiSynth.waveform
    osc.frequency.value = noteFreq(note)
    // ADSR-ish: 0 → velocity*0.5 over attack, sustain
    const peak = Math.max(0.05, Math.min(1, velocity)) * 0.5
    gain.gain.setValueAtTime(0, now)
    gain.gain.linearRampToValueAtTime(peak, now + this.midiSynth.attack)
    osc.connect(gain)
    gain.connect(this.midiBus)
    osc.start(now)
    this.midiVoices.set(note, { osc, gain, releaseTimer: null, note })
  }

  private releaseNote(note: number) {
    const v = this.midiVoices.get(note)
    if (!v || !this.ctx) return
    const now = this.ctx.currentTime
    const rel = Math.max(0.02, this.midiSynth.release)
    try {
      v.gain.gain.cancelScheduledValues(now)
      v.gain.gain.setValueAtTime(v.gain.gain.value, now)
      v.gain.gain.linearRampToValueAtTime(0, now + rel)
    } catch { /* ignore */ }
    // Stop + disconnect after release ends
    if (v.releaseTimer) clearTimeout(v.releaseTimer)
    v.releaseTimer = window.setTimeout(() => {
      try { v.osc.stop() } catch {}
      v.osc.disconnect(); v.gain.disconnect()
      this.midiVoices.delete(note)
    }, Math.ceil((rel + 0.02) * 1000))
  }

  destroy() {
    for (const v of this.voices.values()) {
      try { v.osc.stop() } catch {}
      v.osc.disconnect(); v.filter.disconnect(); v.gain.disconnect()
    }
    this.voices.clear()
    // Tear down the MIDI synth side too — previously these leaked on every
    // destroy(): sustaining oscillators kept running, release timers fired
    // callbacks against a closed context, and the midiBus/filter were orphaned.
    for (const v of this.midiVoices.values()) {
      if (v.releaseTimer) clearTimeout(v.releaseTimer)
      try { v.osc.stop() } catch {}
      try { v.osc.disconnect(); v.gain.disconnect() } catch {}
    }
    this.midiVoices.clear()
    this.prevNoteOn.fill(0)
    try { this.midiBus?.disconnect(); this.midiFilter?.disconnect() } catch {}
    this.midiBus = null
    this.midiFilter = null
    try { this.recDest?.disconnect() } catch {}
    this.recDest = null
    this.master?.disconnect()
    this.ctx?.close()
    this.ctx = null
    this.master = null
  }
}

export const soundEngine = new SoundEngine()
