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
    </div>
  )
}
