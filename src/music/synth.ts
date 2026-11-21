/**
 * Lutherie d'air : les sons. Cordes pincées (Karplus-Strong calculé d'avance, un tampon par note),
 * clochettes (sinus inharmoniques) et tambours (peau + souffle), dans une réverbération commune.
 * Tout passe par `out`, qui alimente à la fois les haut-parleurs et l'enregistrement.
 */
import { karplus, type PluckTone } from './theory'

export type Timbre = 'guitar' | 'harp' | 'bass'
export const TIMBRES: Record<Timbre, { label: string; hue: number; octave: number; tone: PluckTone }> = {
  guitar: { label: 'Guitare', hue: 38, octave: 0, tone: { bright: 0.75, pick: 0.22, sustain: 2.4 } },
  harp: { label: 'Harpe', hue: 185, octave: 1, tone: { bright: 0.45, pick: 0.5, sustain: 3.6 } },
  bass: { label: 'Basse', hue: 320, octave: -1, tone: { bright: 0.35, pick: 0.3, sustain: 2.8 } },
}

export class Synth {
  readonly ctx: AudioContext
  private out: GainNode
  private send: GainNode
  private echo: DelayNode
  private echoGain: GainNode
  private rec: MediaStreamAudioDestinationNode
  private cache = new Map<string, AudioBuffer>()
  private noise: AudioBuffer

  constructor() {
    this.ctx = new AudioContext()
    const c = this.ctx
    this.out = c.createGain(); this.out.gain.value = 0.8
    const comp = c.createDynamicsCompressor()            // plusieurs cordes à la fois ne saturent pas
    this.out.connect(comp); comp.connect(c.destination)
    this.rec = c.createMediaStreamDestination(); comp.connect(this.rec)
    // réverbération : une salle fabriquée (bruit qui s'éteint en 2,4 s)
    const len = Math.floor(c.sampleRate * 2.4), ir = c.createBuffer(2, len, c.sampleRate)
    for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3 }
    const verb = c.createConvolver(); verb.buffer = ir
    this.send = c.createGain(); this.send.gain.value = 0.25
    this.send.connect(verb); verb.connect(this.out)
    // écho calé sur le tempo
    this.echo = c.createDelay(2); this.echoGain = c.createGain(); this.echoGain.gain.value = 0
    const fb = c.createGain(); fb.gain.value = 0.35
    this.echoGain.connect(this.echo); this.echo.connect(fb); fb.connect(this.echo); this.echo.connect(this.out)
    this.noise = c.createBuffer(1, c.sampleRate, c.sampleRate)
    const nd = this.noise.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1
  }

  /** Le navigateur ne laisse sortir du son qu'après un vrai clic : à appeler depuis un bouton. */
  resume() { return this.ctx.resume() }
  get running() { return this.ctx.state === 'running' }
  get stream() { return this.rec.stream }
  set volume(v: number) { this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03) }
  set reverb(v: number) { this.send.gain.setTargetAtTime(v * 0.6, this.ctx.currentTime, 0.05) }
  /** Écho : `amount` 0..1, répété tous les trois quarts de temps au tempo donné. */
  setEcho(amount: number, bpm: number) { this.echoGain.gain.setTargetAtTime(amount * 0.5, this.ctx.currentTime, 0.05); this.echo.delayTime.setTargetAtTime(Math.min(1.9, 45 / bpm), this.ctx.currentTime, 0.05) }

  private voice(gain: number): GainNode {
    const g = this.ctx.createGain(); g.gain.value = gain
    g.connect(this.out); g.connect(this.send); g.connect(this.echoGain)
    return g
  }

  /** Corde pincée. `vel` 0..1 = force ; `pos` 0..1 = endroit du pincement (près d'un bout = plus nasillard). */
  pluck(hz: number, vel: number, timbre: Timbre, pos = 0.25) {
    if (!this.running) return
    const T = TIMBRES[timbre], pick = Math.round(Math.max(0.06, Math.min(0.5, Math.min(pos, 1 - pos) || T.tone.pick)) * 8) / 8
    const key = `${timbre}|${hz.toFixed(1)}|${pick}`
    let buf = this.cache.get(key)
    if (!buf) {
      const data = karplus(this.ctx.sampleRate, hz, Math.min(4, T.tone.sustain + 0.4), { ...T.tone, pick })
      buf = this.ctx.createBuffer(1, data.length, this.ctx.sampleRate); buf.getChannelData(0).set(data)
      this.cache.set(key, buf)
      if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value as string)   // les plus anciens tampons s'en vont
    }
    const src = this.ctx.createBufferSource(); src.buffer = buf
    src.connect(this.voice(0.15 + 0.75 * Math.max(0, Math.min(1, vel)))); src.start()
  }

  /** Clochette : quatre sinus aux rapports d'une cloche, qui s'éteignent d'autant plus vite qu'ils sont aigus. */
  bell(hz: number, vel: number) {
    if (!this.running) return
    const t = this.ctx.currentTime, v = this.voice(0.1 + 0.35 * vel)
    ;[[1, 1, 2.6], [2.76, 0.5, 1.6], [5.4, 0.25, 0.9], [8.93, 0.12, 0.5]].forEach(([ratio, amp, dur]) => {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain()
      o.frequency.value = hz * ratio
      g.gain.setValueAtTime(amp, t); g.gain.exponentialRampToValueAtTime(0.0005, t + dur)
      o.connect(g); g.connect(v); o.start(t); o.stop(t + dur + 0.05)
    })
  }

  /** Tambour : une peau (sinus qui descend) et un souffle. Charleston = souffle aigu seul. */
  drum(kind: 'kick' | 'tom' | 'hat', hz: number, vel: number) {
    if (!this.running) return
    const t = this.ctx.currentTime, v = this.voice(0.25 + 0.75 * vel)
    const n = this.ctx.createBufferSource(), ng = this.ctx.createGain(), f = this.ctx.createBiquadFilter()
    n.buffer = this.noise; n.connect(f); f.connect(ng); ng.connect(v)
    if (kind === 'hat') { f.type = 'highpass'; f.frequency.value = 6500; ng.gain.setValueAtTime(0.5, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 0.09) }
    else {
      f.type = 'bandpass'; f.frequency.value = hz * 4; ng.gain.setValueAtTime(kind === 'kick' ? 0.15 : 0.3, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 0.12)
      const o = this.ctx.createOscillator(), g = this.ctx.createGain(), dur = kind === 'kick' ? 0.5 : 0.32
      o.frequency.setValueAtTime(hz * 2.6, t); o.frequency.exponentialRampToValueAtTime(hz, t + 0.07)
      g.gain.setValueAtTime(1, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur)
      o.connect(g); g.connect(v); o.start(t); o.stop(t + dur + 0.05)
    }
    n.start(t); n.stop(t + 0.2)
  }

  close() { void this.ctx.close() }
}
