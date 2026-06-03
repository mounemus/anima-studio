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
    }
    senseBus.midi.device = inputs.join(', ') || 'MIDI (en attente d\'appareil)'
    return { ok: true, inputs }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'WebMIDI refusé', inputs: [] }
  }
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
