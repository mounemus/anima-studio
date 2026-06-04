/**
 * MIDI Monitor — vue détaillée des signaux MIDI entrants.
 *
 * Affiche :
 *  - État de connexion + nom du device
 *  - Les 8 CC les plus actifs (avec numéro + barre + valeur)
 *  - Les notes actives (avec numéro MIDI + vélocité)
 *  - La mod wheel
 *
 * Ré-rendu à 30fps via un tick local — pas de Zustand subscribe, donc zéro
 * impact sur les autres composants quand MIDI bouge.
 */
import { useEffect, useState } from 'react'
import { senseBus } from '../senses/SenseBus'

export function MidiMonitor() {
  const [, tick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => tick((x) => x + 1), 50)
    return () => clearInterval(id)
  }, [])

  const m = senseBus.midi
  // Find top-8 active CCs
  const ccPairs: { num: number; val: number }[] = []
  for (let i = 0; i < 128; i++) if (m.cc[i] > 0.001) ccPairs.push({ num: i, val: m.cc[i] })
  ccPairs.sort((a, b) => b.val - a.val)
  const topCCs = ccPairs.slice(0, 8)
  // Find active notes
  const activeNotes: { num: number; vel: number }[] = []
  for (let i = 0; i < 128; i++) if (m.notes[i] > 0) activeNotes.push({ num: i, vel: m.notes[i] })

  if (!m.available) {
    return (
      <div style={{ padding: 8, background: 'var(--bg-elev-2)', border: '1px dashed var(--line)', borderRadius: 'var(--radius-sm)' }}>
        <p style={{ fontSize: 11, color: 'var(--text-mute)', margin: 0 }}>
          🎹 MIDI inactif — clique <strong>MIDI</strong> dans la barre du haut pour activer WebMIDI (Chrome/Edge requis).
        </p>
      </div>
    )
  }

  return (
    <div style={{ padding: 8, background: 'var(--bg-elev-2)', border: `1px solid ${(activeNotes.length > 0 || topCCs.length > 0) ? 'var(--accent)' : 'var(--line)'}`, borderRadius: 'var(--radius-sm)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span className={`dot ${(activeNotes.length > 0 || topCCs.length > 0) ? 'on' : 'off'}`} />
        <strong style={{ fontSize: 12 }}>🎹 MIDI</strong>
        <span style={{ fontSize: 10, color: 'var(--text-mute)', marginLeft: 'auto' }}>
          {m.device || 'connecté (aucun appareil)'}
        </span>
      </div>
      {/* CC values */}
      <div style={{ marginBottom: 6 }}>
        <div style={{ fontSize: 10, color: 'var(--text-mute)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 3 }}>
          Contrôleurs CC ({ccPairs.length} actif{ccPairs.length > 1 ? 's' : ''})
        </div>
        {topCCs.length === 0 && (
          <div style={{ fontSize: 11, color: 'var(--text-mute)', fontStyle: 'italic' }}>Bouge un slider/knob de ton contrôleur…</div>
        )}
        {topCCs.map((cc) => (
          <div key={cc.num} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
            <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--text-dim)', width: 50, flexShrink: 0 }}>cc{cc.num}</span>
            <div style={{ flex: 1, height: 6, background: 'var(--bg)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${cc.val * 100}%`, background: 'linear-gradient(90deg, var(--accent), var(--accent-2))' }} />
            </div>
            <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--text-dim)', width: 32, textAlign: 'right' }}>
              {Math.round(cc.val * 127)}
            </span>
          </div>
        ))}
      </div>
      {/* Notes */}
      <div>
        <div style={{ fontSize: 10, color: 'var(--text-mute)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 3 }}>
          Notes actives ({activeNotes.length})
        </div>
        {activeNotes.length === 0 && (
          <div style={{ fontSize: 11, color: 'var(--text-mute)', fontStyle: 'italic' }}>Joue une touche…</div>
        )}
        {activeNotes.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {activeNotes.map((n) => (
              <span key={n.num} style={{
                fontSize: 10, fontFamily: 'var(--mono)',
                padding: '2px 6px', borderRadius: 3,
                background: `rgba(0,212,255,${0.2 + n.vel * 0.5})`,
                color: 'var(--accent-2)',
                border: '1px solid var(--accent-2)',
              }}>
                {midiNoteName(n.num)} ({n.num})
              </span>
            ))}
          </div>
        )}
      </div>
      {/* Mod wheel */}
      {m.mod > 0.001 && (
        <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>Mod wheel</span>
          <div style={{ flex: 1, height: 4, background: 'var(--bg)', borderRadius: 2 }}>
            <div style={{ height: '100%', width: `${m.mod * 100}%`, background: 'var(--accent-3)', borderRadius: 2 }} />
          </div>
        </div>
      )}
    </div>
  )
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
function midiNoteName(n: number): string {
  const oct = Math.floor(n / 12) - 1
  return NOTE_NAMES[n % 12] + oct
}
