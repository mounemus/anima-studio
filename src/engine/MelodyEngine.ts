/**
 * MelodyEngine — sequencer monophonique/polyphonique qui joue une mélodie JSON
 * via le polysynth interne du SoundEngine.
 *
 * Schéma Melody : voir types/scene.ts
 *  - tempo (BPM)
 *  - loop  (bool)
 *  - notes : liste de { note (MIDI 21-108), time (beats), dur (beats), vel (0-1) }
 *
 * Lifecycle :
 *  - loadMelody(m) : charge + reset position
 *  - play() / pause() / stop()
 *  - tick() : appelé à chaque frame depuis Engine.loop, déclenche virtualNoteOn /
 *    virtualNoteOff aux bons instants (look-ahead 60ms pour éviter le jitter)
 *
 * État global (runtime singleton) pour pouvoir piloter depuis l'UI sans Zustand.
 */
import type { Melody, MelodyNote } from '../types/scene'
import { virtualNoteOn, virtualNoteOff } from '../senses/MIDI'

interface RuntimeState {
  melody: Melody | null
  playing: boolean
  /** Position courante en BEATS (pas secondes). */
  beat: number
  /** Wall-clock (ms) au moment où `beat` a été ancré. */
  anchorMs: number
  /** Notes déjà déclenchées dans le cycle courant (id index dans melody.notes). */
  fired: Set<number>
  /** Notes actuellement actives (note → timeout pour off). */
  active: Map<number, number>
  /** Callbacks listeners pour la UI. */
  listeners: Set<() => void>
}

export const runtime: RuntimeState = {
  melody: null,
  playing: false,
  beat: 0,
  anchorMs: 0,
  fired: new Set(),
  active: new Map(),
  listeners: new Set(),
}

function emit() { runtime.listeners.forEach((l) => l()) }
export function subscribe(fn: () => void): () => void {
  runtime.listeners.add(fn)
  return () => { runtime.listeners.delete(fn) }
}

/** Loop length = max end-time across all notes, rounded up to next beat. */
function loopLength(m: Melody): number {
  let end = 0
  for (const n of m.notes) end = Math.max(end, (n.time ?? 0) + (n.dur ?? 0.25))
  return Math.max(1, Math.ceil(end))
}

export function loadMelody(m: Melody | null) {
  // Stop any currently-playing notes from the previous melody
  for (const [note, t] of runtime.active) {
    clearTimeout(t)
    virtualNoteOff(note)
  }
  runtime.active.clear()
  runtime.fired.clear()
  runtime.melody = m
  runtime.beat = 0
  runtime.playing = false
  runtime.anchorMs = performance.now()
  emit()
}

export function play() {
  if (!runtime.melody) return
  if (runtime.playing) return
  runtime.playing = true
  runtime.anchorMs = performance.now()
  emit()
}

export function pause() {
  if (!runtime.playing) return
  // Bake elapsed beats into runtime.beat
  const m = runtime.melody
  if (m) {
    const bps = m.tempo / 60
    runtime.beat += ((performance.now() - runtime.anchorMs) / 1000) * bps
  }
  runtime.playing = false
  emit()
}

export function stop() {
  runtime.playing = false
  runtime.beat = 0
  runtime.fired.clear()
  for (const [note, t] of runtime.active) {
    clearTimeout(t)
    virtualNoteOff(note)
  }
  runtime.active.clear()
  emit()
}

export function currentBeat(): number {
  if (!runtime.melody) return 0
  if (!runtime.playing) return runtime.beat
  const bps = runtime.melody.tempo / 60
  return runtime.beat + ((performance.now() - runtime.anchorMs) / 1000) * bps
}

/** Called once per frame from Engine.loop. Triggers due notes. */
export function tick() {
  const m = runtime.melody
  if (!m || !runtime.playing) return
  const total = loopLength(m)
  let beat = currentBeat()
  // Loop wrap
  if (beat >= total) {
    if (m.loop) {
      // Reset fired set and re-anchor
      runtime.fired.clear()
      runtime.beat = beat % total
      runtime.anchorMs = performance.now()
      beat = runtime.beat
    } else {
      // End of melody — stop cleanly
      stop()
      return
    }
  }
  // Fire any notes whose time <= current beat and not yet fired this cycle
  const bps = m.tempo / 60
  for (let i = 0; i < m.notes.length; i++) {
    if (runtime.fired.has(i)) continue
    const n = m.notes[i]
    if ((n.time ?? 0) <= beat) {
      fireNote(n)
      runtime.fired.add(i)
    }
  }
  // touch bps to keep TS happy
  void bps
}

function fireNote(n: MelodyNote) {
  const m = runtime.melody
  if (!m) return
  const note = Math.max(21, Math.min(108, Math.round(n.note)))
  const vel = Math.max(0.05, Math.min(1, n.vel ?? 0.7))
  virtualNoteOn(note, vel)
  // Schedule note-off after dur beats
  const bps = m.tempo / 60
  const durMs = Math.max(40, ((n.dur ?? 0.25) / bps) * 1000)
  // If the same note is already active, cancel its old off timer
  const prev = runtime.active.get(note)
  if (prev) clearTimeout(prev)
  const t = window.setTimeout(() => {
    virtualNoteOff(note)
    runtime.active.delete(note)
  }, durMs)
  runtime.active.set(note, t)
}

/** Quick info for the UI (no React subscriptions needed). */
export function info() {
  const m = runtime.melody
  return {
    hasMelody: !!m,
    playing: runtime.playing,
    beat: m ? currentBeat() : 0,
    totalBeats: m ? loopLength(m) : 0,
    tempo: m?.tempo ?? 120,
    notesCount: m?.notes.length ?? 0,
    key: m?.key,
    scale: m?.scale,
  }
}
