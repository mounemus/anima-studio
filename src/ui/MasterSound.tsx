/** Always-visible master sound control in the TopBar. */
import { useEffect, useRef, useState } from 'react'
import { Volume2, VolumeX } from 'lucide-react'
import { soundEngine } from '../engine/SoundEngine'

export function MasterSound() {
  const [muted, setMuted] = useState(false)
  const [vol, setVol] = useState(0.6)
  const [open, setOpen] = useState(false)
  const popRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setMuted(soundEngine.isMuted())
  }, [])

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
          <p style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 10, lineHeight: 1.4 }}>
            Le son est généré par les <strong>obstacles sonifiés</strong>.
            Va dans l'onglet <strong>Obs.</strong>, ajoute un obstacle, puis active <strong>"Sonifier cet obstacle"</strong>.
            Ou clique <strong>"Appliquer un préset musical"</strong> pour assigner des notes à tous les obstacles en 1 clic.
          </p>
        </div>
      )}
    </div>
  )
}
