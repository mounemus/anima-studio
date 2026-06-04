/** WebMIDI — exposes CC + note state on senseBus.midi. Auto-discovers inputs. */
import { senseBus } from './SenseBus'

let access: MIDIAccess | null = null
let running = false

export async function startMIDI(): Promise<{ ok: boolean; error?: string; inputs: string[] }> {
  if (running && access) {
    return { ok: true, inputs: [...access.inputs.values()].map((i) => i.name || 'MIDI') }
  }
  if (!('requestMIDIAccess' in navigator)) {
    return { ok: false, error: 'WebMIDI non disponible dans ce navigateur (utilise Chrome/Edge).', inputs: [] }
  }
  try {
    access = await navigator.requestMIDIAccess({ sysex: false })
    running = true
    senseBus.midi.available = true
    const inputs: string[] = []
    for (const input of access.inputs.values()) {
      attach(input)
      inputs.push(input.name || 'MIDI')
    }
    access.onstatechange = (e) => {
      const port = (e as MIDIConnectionEvent).port
      if (port && port.type === 'input') {
        if (port.state === 'connected') attach(port as MIDIInput)
      }
      // Refresh the device name list whenever ports come and go — without this
      // the user sees "(aucun appareil)" even after they plug a controller in.
      refreshDeviceList()
    }
    refreshDeviceList()
    return { ok: true, inputs }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'WebMIDI refusé', inputs: [] }
  }
}

function refreshDeviceList() {
  if (!access) return
  const names: string[] = []
  for (const input of access.inputs.values()) {
    if (input.state === 'connected') names.push(input.name || 'MIDI')
  }
  senseBus.midi.device = names.length > 0
    ? names.join(', ')
    : '(aucun appareil — utilise le clavier virtuel ci-dessous)'
}

/**
 * Programmatic note-on / note-off — used by the on-screen virtual keyboard.
 *
 * Also unlocks the audio context lazily on first use, so notes played from
 * the virtual keyboard immediately produce sound through the synth without
 * requiring a separate user gesture on the volume button.
 */
import { soundEngine } from '../engine/SoundEngine'

export function virtualNoteOn(note: number, velocity = 0.8) {
  if (note < 0 || note >= 128) return
  // The first call here counts as the user's "audio gesture" — wake the engine.
  try { soundEngine.ensure() } catch { /* ignore (context creation may fail in iframes) */ }
  senseBus.midi.notes[note] = Math.max(0, Math.min(1, velocity))
  senseBus.midi.available = true   // even without a real device, the bus is live
}
export function virtualNoteOff(note: number) {
  if (note < 0 || note >= 128) return
  senseBus.midi.notes[note] = 0
}
/** Programmatic CC set — used by the on-screen XY pad and sliders. */
export function virtualCC(num: number, value0to1: number) {
  if (num < 0 || num >= 128) return
  try { soundEngine.ensure() } catch { /* ignore */ }
  const v = Math.max(0, Math.min(1, value0to1))
  senseBus.midi.cc[num] = v
  if (num === 1) senseBus.midi.mod = v
  senseBus.midi.available = true
}

function attach(input: MIDIInput) {
  input.onmidimessage = (e) => {
    const data = e.data
    if (!data) return
    const status = data[0]
    const d1 = data[1]
    const d2 = data[2]
    const cmd = status & 0xf0
    if (cmd === 0x90 && d2 > 0) {
      senseBus.midi.notes[d1] = d2 / 127
    } else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) {
      senseBus.midi.notes[d1] = 0
    } else if (cmd === 0xb0) {
      senseBus.midi.cc[d1] = d2 / 127
      if (d1 === 1) senseBus.midi.mod = d2 / 127
    }
  }
}

export function stopMIDI() {
  if (!access) return
  for (const input of access.inputs.values()) input.onmidimessage = null
  access = null
  running = false
  senseBus.midi.available = false
  senseBus.midi.device = ''
  senseBus.midi.cc.fill(0)
  senseBus.midi.notes.fill(0)
  senseBus.midi.mod = 0
}
