/**
 * Clavier MIDI virtuel — alternative à un contrôleur USB.
 *
 * Permet de :
 *  - Jouer des notes (2 octaves, mouse + clavier QWERTY/AZERTY)
 *  - Bouger 4 CCs principaux (CC1 mod / CC7 vol / CC11 expr / CC74 filter)
 *  - Manipuler un XY pad (envoie 2 CCs configurables simultanément)
 *
 * Écrit directement dans senseBus.midi via virtualNoteOn / virtualCC, qui sont
 * lus par le moteur (et par les bindings) exactement comme un device USB.
 *
 * Conçu pour le tactile : tous les éléments sont cliquables/glissables, le
 * tracking pointer fonctionne avec multitouch.
 */
import { useEffect, useRef, useState } from 'react'
import { virtualNoteOn, virtualNoteOff, virtualCC } from '../senses/MIDI'
import { soundEngine } from '../engine/SoundEngine'

// Keyboard mapping — same row pattern as Ableton / FL Studio
// White keys: A=C, S=D, D=E, F=F, G=G, H=A, J=B, K=C
// Black keys: W=C#, E=D#, T=F#, Y=G#, U=A#
const KEY_MAP: Record<string, number> = {
  'a': 0, 'w': 1, 's': 2, 'e': 3, 'd': 4,
  'f': 5, 't': 6, 'g': 7, 'y': 8, 'h': 9, 'u': 10, 'j': 11,
  'k': 12, 'o': 13, 'l': 14, 'p': 15, 'm': 16,
}

interface CCSlider {
  num: number
  label: string
  color: string
}
const CC_SLIDERS: CCSlider[] = [
  { num: 1, label: 'Mod CC1', color: 'var(--accent)' },
  { num: 7, label: 'Vol CC7', color: 'var(--accent-2)' },
  { num: 11, label: 'Expr CC11', color: 'var(--accent-3)' },
  { num: 74, label: 'Filtre CC74', color: '#ff6ba6' },
]

export function VirtualMidi() {
  const [octave, setOctave] = useState(4)  // C4 = MIDI 60
  const [held, setHeld] = useState<Set<number>>(new Set())
  const [ccValues, setCcValues] = useState<Record<number, number>>({ 1: 0, 7: 0.8, 11: 1, 74: 0.5 })
  const [xyCC, setXyCC] = useState<{ x: number; y: number }>({ x: 12, y: 13 })
  const [xyVal, setXyVal] = useState<{ x: number; y: number }>({ x: 0.5, y: 0.5 })
  const padRef = useRef<HTMLDivElement>(null)
  // Synth controls — mirror soundEngine.midiSynth into local state so sliders react
  const [synth, setSynth] = useState({ ...soundEngine.midiSynth })
  const patchSynth = (p: Partial<typeof synth>) => {
    const next = { ...synth, ...p }
    setSynth(next)
    soundEngine.ensure()
    soundEngine.setMidiSynth(next)
  }

  // Press a note → senseBus + visual state
  const press = (note: number) => {
    if (held.has(note)) return
    virtualNoteOn(note, 0.85)
    setHeld((s) => new Set(s).add(note))
  }
  const release = (note: number) => {
    if (!held.has(note)) return
    virtualNoteOff(note)
    setHeld((s) => { const n = new Set(s); n.delete(note); return n })
  }

  // Computer-keyboard input (QWERTY mapping)
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.repeat) return
      const k = e.key.toLowerCase()
      if (k === 'z') { setOctave((o) => Math.max(0, o - 1)); return }
      if (k === 'x') { setOctave((o) => Math.min(8, o + 1)); return }
      const offset = KEY_MAP[k]
      if (offset !== undefined) {
        e.preventDefault()
        press(octave * 12 + offset)
      }
    }
    const onUp = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase()
      const offset = KEY_MAP[k]
      if (offset !== undefined) release(octave * 12 + offset)
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [octave])

  // Build the keyboard: 2 octaves starting at `octave`
  const baseNote = octave * 12
  const whiteOffsets = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19, 21, 23]  // 14 white keys = 2 octaves
  const blackOffsets = [1, 3, 6, 8, 10, 13, 15, 18, 20, 22]                // 10 black keys

  // CC slider drag
  const onSliderChange = (num: number, v: number) => {
    const clamped = Math.max(0, Math.min(1, v))
    setCcValues((s) => ({ ...s, [num]: clamped }))
    virtualCC(num, clamped)
  }

  // XY pad drag
  const onPadPointer = (e: React.PointerEvent) => {
    if (!padRef.current) return
    if (e.buttons === 0 && e.type !== 'pointerdown') return
    const r = padRef.current.getBoundingClientRect()
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
    const y = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height))
    setXyVal({ x, y })
    virtualCC(xyCC.x, x)
    virtualCC(xyCC.y, y)
  }

  return (
    <div style={{ padding: 8, background: 'var(--bg-elev-2)', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)', marginTop: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <strong style={{ fontSize: 12 }}>🎹 Clavier virtuel</strong>
        <span style={{ fontSize: 10, color: 'var(--text-mute)', marginLeft: 'auto' }}>
          Octave {octave} · clavier <kbd style={kbdStyle}>A</kbd>…<kbd style={kbdStyle}>J</kbd> · <kbd style={kbdStyle}>Z</kbd>/<kbd style={kbdStyle}>X</kbd> octave
        </span>
        <button onClick={() => setOctave((o) => Math.max(0, o - 1))} style={{ fontSize: 10, padding: '2px 6px' }}>◀</button>
        <button onClick={() => setOctave((o) => Math.min(8, o + 1))} style={{ fontSize: 10, padding: '2px 6px' }}>▶</button>
      </div>

      {/* Synth controls (audible output) */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: '4px 6px', marginBottom: 6, background: synth.enabled ? 'rgba(0,255,163,0.06)' : 'rgba(255,255,255,0.02)', border: `1px solid ${synth.enabled ? 'rgba(0,255,163,0.3)' : 'var(--line)'}`, borderRadius: 'var(--radius-sm)' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, cursor: 'pointer' }}>
          <input type="checkbox" checked={synth.enabled} onChange={(e) => patchSynth({ enabled: e.target.checked })} />
          🔊 Synth audio
        </label>
        <select
          value={synth.waveform}
          onChange={(e) => patchSynth({ waveform: e.target.value as any })}
          style={{ fontSize: 11, padding: '1px 4px' }}
          title="Forme d'onde"
        >
          <option value="sine">Sine</option>
          <option value="triangle">Triangle</option>
          <option value="sawtooth">Sawtooth</option>
          <option value="square">Square</option>
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: 'var(--text-dim)' }}>
          Vol
          <input
            type="range" min={0} max={1} step={0.02} value={synth.volume}
            onChange={(e) => patchSynth({ volume: parseFloat(e.target.value) })}
            style={{ width: 70 }}
          />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: 'var(--text-dim)' }}>
          Filtre
          <input
            type="range" min={200} max={8000} step={50} value={synth.filterCutoff}
            onChange={(e) => patchSynth({ filterCutoff: parseFloat(e.target.value) })}
            style={{ width: 70 }}
          />
          <span style={{ fontFamily: 'var(--mono)', minWidth: 38, textAlign: 'right' }}>{Math.round(synth.filterCutoff)}Hz</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: 'var(--text-dim)' }}>
          Release
          <input
            type="range" min={0.05} max={2} step={0.02} value={synth.release}
            onChange={(e) => patchSynth({ release: parseFloat(e.target.value) })}
            style={{ width: 60 }}
          />
        </label>
        {soundEngine.isMuted() && (
          <span style={{ fontSize: 10, color: 'var(--warn)' }}>⚠ Master coupé (icône 🔊 en haut)</span>
        )}
      </div>

      {/* Piano */}
      <div style={{ position: 'relative', height: 64, marginBottom: 8, touchAction: 'none' }}>
        {/* White keys */}
        <div style={{ position: 'absolute', inset: 0, display: 'grid', gridTemplateColumns: 'repeat(14, 1fr)', gap: 1 }}>
          {whiteOffsets.map((off) => {
            const note = baseNote + off
            const isHeld = held.has(note)
            return (
              <div
                key={off}
                onPointerDown={(e) => { (e.currentTarget as any).setPointerCapture?.(e.pointerId); press(note) }}
                onPointerUp={() => release(note)}
                onPointerLeave={() => release(note)}
                style={{
                  background: isHeld ? 'var(--accent)' : '#f0f4f8',
                  borderRadius: '0 0 3px 3px',
                  cursor: 'pointer',
                  transition: 'background 0.04s',
                  display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
                  paddingBottom: 4, fontSize: 9, color: isHeld ? '#001110' : '#5b6075',
                  fontFamily: 'var(--mono)',
                  userSelect: 'none',
                }}
              >
                {off === 0 || off === 12 ? `C${octave + (off >= 12 ? 1 : 0)}` : ''}
              </div>
            )
          })}
        </div>
        {/* Black keys overlay */}
        {blackOffsets.map((off) => {
          const note = baseNote + off
          const isHeld = held.has(note)
          // Position relative to whites
          const whiteIdx = whiteOffsets.findIndex((w) => w > off)
          const left = (whiteIdx === -1 ? 14 : whiteIdx) / 14
          return (
            <div
              key={off}
              onPointerDown={(e) => { (e.currentTarget as any).setPointerCapture?.(e.pointerId); press(note) }}
              onPointerUp={() => release(note)}
              onPointerLeave={() => release(note)}
              style={{
                position: 'absolute', top: 0,
                left: `calc(${left * 100}% - ${100 / 14 / 2.6}%)`,
                width: `${100 / 14 / 1.3}%`, height: '62%',
                background: isHeld ? 'var(--accent-2)' : '#1a1d28',
                border: '1px solid #232633',
                borderRadius: '0 0 3px 3px', cursor: 'pointer',
                transition: 'background 0.04s', userSelect: 'none',
              }}
            />
          )
        })}
      </div>

      {/* CC sliders */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 6, marginBottom: 8 }}>
        {CC_SLIDERS.map((cc) => (
          <div key={cc.num} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <input
              type="range" min={0} max={1} step={0.005}
              value={ccValues[cc.num] ?? 0}
              onChange={(e) => onSliderChange(cc.num, parseFloat(e.target.value))}
              style={{
                writingMode: 'vertical-lr' as any,
                WebkitAppearance: 'slider-vertical' as any,
                width: 20, height: 70,
                accentColor: cc.color as any,
              }}
            />
            <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2, fontFamily: 'var(--mono)' }}>{cc.label}</div>
            <div style={{ fontSize: 9, color: 'var(--text-mute)', fontFamily: 'var(--mono)' }}>
              {Math.round((ccValues[cc.num] ?? 0) * 127)}
            </div>
          </div>
        ))}
      </div>

      {/* XY pad */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, fontSize: 10, color: 'var(--text-dim)' }}>
          <strong>XY pad</strong>
          <span>X →</span>
          <input
            type="number" min={0} max={127} value={xyCC.x}
            onChange={(e) => setXyCC({ ...xyCC, x: Math.max(0, Math.min(127, parseInt(e.target.value) || 0)) })}
            style={{ width: 48, fontSize: 10, fontFamily: 'var(--mono)' }}
          />
          <span>Y →</span>
          <input
            type="number" min={0} max={127} value={xyCC.y}
            onChange={(e) => setXyCC({ ...xyCC, y: Math.max(0, Math.min(127, parseInt(e.target.value) || 0)) })}
            style={{ width: 48, fontSize: 10, fontFamily: 'var(--mono)' }}
          />
          <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)' }}>
            ({Math.round(xyVal.x * 127)}, {Math.round(xyVal.y * 127)})
          </span>
        </div>
        <div
          ref={padRef}
          onPointerDown={(e) => { (e.currentTarget as any).setPointerCapture?.(e.pointerId); onPadPointer(e) }}
          onPointerMove={onPadPointer}
          style={{
            position: 'relative', height: 110,
            background: 'radial-gradient(circle at 50% 50%, rgba(0,212,255,0.08), transparent 70%), var(--bg)',
            border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)',
            cursor: 'crosshair', touchAction: 'none', userSelect: 'none',
          }}
        >
          {/* Crosshair grid */}
          <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'var(--line)', opacity: 0.5 }} />
          <div style={{ position: 'absolute', top: '50%', left: 0, right: 0, height: 1, background: 'var(--line)', opacity: 0.5 }} />
          {/* Cursor */}
          <div style={{
            position: 'absolute',
            left: `${xyVal.x * 100}%`,
            top: `${(1 - xyVal.y) * 100}%`,
            width: 14, height: 14,
            transform: 'translate(-50%, -50%)',
            borderRadius: '50%',
            background: 'var(--accent)',
            boxShadow: '0 0 12px var(--accent)',
            pointerEvents: 'none',
          }} />
        </div>
      </div>
    </div>
  )
}

const kbdStyle: React.CSSProperties = {
  fontFamily: 'var(--mono)', fontSize: 9,
  padding: '0 4px', background: 'var(--bg)',
  border: '1px solid var(--line)', borderRadius: 2,
  color: 'var(--text-dim)',
}
