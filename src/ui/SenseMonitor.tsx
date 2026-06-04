import { useEffect, useState } from 'react'
import { senseBus } from '../senses/SenseBus'

export function SenseMonitor() {
  const [, tick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => tick((x) => x + 1), 80)
    return () => clearInterval(id)
  }, [])

  const h = senseBus.hands
  const a = senseBus.audio
  const l = senseBus.light
  const m = senseBus.midi
  // count active notes / cc
  let activeNotes = 0
  for (let i = 0; i < 128; i++) if (m.notes[i] > 0) activeNotes++
  const ccMax = Math.max(m.cc[1] ?? 0, m.cc[2] ?? 0, m.cc[7] ?? 0, m.cc[11] ?? 0, m.mod)

  return (
    <div className="sense-monitor">
      <div className="sense-row">
        <span><span className={`dot ${h.detected ? 'on' : 'off'}`} />Main</span>
        <div className="bar"><div className="bar-fill" style={{ width: `${h.pinch * 100}%` }} /></div>
      </div>
      <div className="sense-row">
        <span>Bass</span>
        <div className="bar"><div className="bar-fill" style={{ width: `${a.bass * 100}%` }} /></div>
      </div>
      <div className="sense-row">
        <span>Mid</span>
        <div className="bar"><div className="bar-fill" style={{ width: `${a.mid * 100}%` }} /></div>
      </div>
      <div className="sense-row">
        <span>High</span>
        <div className="bar"><div className="bar-fill" style={{ width: `${a.high * 100}%` }} /></div>
      </div>
      <div className="sense-row">
        <span>Light</span>
        <div className="bar"><div className="bar-fill" style={{ width: `${l.brightness * 100}%` }} /></div>
      </div>
      <div className="sense-row">
        <span title={m.available ? `MIDI ${m.device || 'connecté'}` : 'MIDI inactif'}>
          <span className={`dot ${m.available ? (activeNotes > 0 || ccMax > 0.01 ? 'on' : '') : 'off'}`} style={!m.available ? { opacity: 0.4 } : undefined} />
          MIDI{m.available && activeNotes > 0 ? ` (${activeNotes})` : ''}
        </span>
        <div className="bar"><div className="bar-fill" style={{ width: `${(m.available ? ccMax : 0) * 100}%` }} /></div>
      </div>
    </div>
  )
}
