/** Always-visible master sound control in the TopBar. */
import { useEffect, useRef, useState } from 'react'
import { Volume2, VolumeX, Play, Pause, Square } from 'lucide-react'
import { soundEngine } from '../engine/SoundEngine'
import { play as melodyPlay, pause as melodyPause, stop as melodyStop, info as melodyInfo, subscribe as melodySubscribe } from '../engine/MelodyEngine'

export function MasterSound() {
  const [muted, setMuted] = useState(false)
  const [vol, setVol] = useState(0.6)
  const [open, setOpen] = useState(false)
  const [, tick] = useState(0)
  const popRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setMuted(soundEngine.isMuted())
  }, [])

  // Re-render when melody state changes (load/play/pause/stop) AND tick when playing
  useEffect(() => {
    const unsub = melodySubscribe(() => tick((x) => x + 1))
    let id = 0
    const poll = () => { tick((x) => x + 1); id = window.setTimeout(poll, 200) }
    if (open) poll()
    return () => { unsub(); clearTimeout(id) }
  }, [open])

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false)
    }
    if (open) document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const toggleMute = () => {
    soundEngine.ensure()           // first interaction unlocks AudioContext if needed
    const m = !muted
    soundEngine.setMuted(m)
    setMuted(m)
  }
  const setVolume = (v: number) => {
    soundEngine.ensure()
    setVol(v)
    soundEngine.setMasterVolume(v)
  }

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => { setOpen((x) => !x); soundEngine.ensure() }}
        className={muted ? '' : (soundEngine.isReady() ? 'primary' : '')}
        title="Mixer audio global"
        style={{ padding: '5px 8px' }}
      >
        {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
      </button>
      {open && (
        <div ref={popRef} className="master-sound-pop">
          <div style={{ fontSize: 10, color: 'var(--text-mute)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
            🎚️ Mixer global
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
            <button onClick={toggleMute} className={muted ? 'danger' : 'primary'} style={{ flex: 1, justifyContent: 'center', fontSize: 12 }}>
              {muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
              {muted ? 'Muet' : 'Audio ON'}
            </button>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>Volume {Math.round(vol * 100)}%</div>
          <input
            type="range"
            min={0} max={1} step={0.01}
            value={vol}
            onChange={(e) => setVolume(parseFloat(e.target.value))}
            style={{ width: '100%' }}
          />
          {/* Melody transport — visible only if a melody is loaded */}
          {(() => {
            const m = melodyInfo()
            if (!m.hasMelody) return null
            const pct = m.totalBeats > 0 ? Math.min(100, (m.beat / m.totalBeats) * 100) : 0
            return (
              <div style={{ marginTop: 12, padding: 8, background: 'var(--bg)', border: '1px solid var(--accent-3)', borderRadius: 'var(--radius-sm)' }}>
                <div style={{ fontSize: 10, color: 'var(--text-mute)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>
                  🎵 Mélodie IA
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>
                  {m.tempo} BPM · {m.notesCount} notes
                  {m.key && ` · ${m.key}`}{m.scale && ` ${m.scale}`}
                </div>
                <div style={{ height: 4, background: 'var(--bg-elev)', borderRadius: 2, marginBottom: 6, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent-3)', transition: 'width 0.1s' }} />
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button
                    onClick={() => { soundEngine.ensure(); m.playing ? melodyPause() : melodyPlay() }}
                    className={m.playing ? 'primary' : ''}
                    style={{ flex: 1, justifyContent: 'center', fontSize: 11, padding: '4px' }}
                  >
                    {m.playing ? <Pause size={11} /> : <Play size={11} />}
                    {m.playing ? 'Pause' : 'Lecture'}
                  </button>
                  <button onClick={melodyStop} className="ghost" style={{ fontSize: 11, padding: '4px 8px' }} title="Stop">
                    <Square size={11} />
                  </button>
                </div>
              </div>
            )
          })()}
          <p style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 10, lineHeight: 1.4 }}>
            Le son provient de 3 sources : <strong>obstacles sonifiés</strong> (onglet Obs.),
            <strong> polysynth MIDI</strong> (clavier virtuel ou contrôleur USB), et
            <strong> mélodies générées par l'IA</strong> (bouton 🎵 dans le chat).
          </p>
        </div>
      )}
    </div>
  )
}
