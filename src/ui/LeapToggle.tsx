/**
 * Bouton « Leap Motion » commun à tous les ateliers : branche le capteur comme source des
 * mains à la place de la caméra, affiche l'état et les réglages (adresse du service,
 * emplacement du capteur, largeur de la zone). `compact` = simple bouton pour la barre
 * du haut du studio principal.
 */
import { useState } from 'react'
import { Hand } from 'lucide-react'
import { useLeap, connectLeap, turnLeapOff, setLeapSettings, resetLeapCal, LEAP_DEFAULTS } from '../senses/Leap'

export function LeapToggle({ accent = '#00f0ff', compact = false }: { accent?: string; compact?: boolean }) {
  const { status, message, settings, fit } = useLeap()
  const [open, setOpen] = useState(false)
  const on = status === 'on', busy = status === 'connecting'
  const toggle = () => { if (on || busy) turnLeapOff(); else void connectLeap() }

  if (compact) {
    return (
      <button onClick={toggle} className={on ? 'primary' : ''} title={message || 'Leap Motion : suivre les mains avec le capteur au lieu de la caméra'}>
        <Hand size={14} /> {busy ? 'Leap…' : 'Leap'}
        {status === 'error' && <span style={{ color: '#ff6b6b', marginLeft: 4 }} aria-label="erreur">!</span>}
      </button>
    )
  }

  const box: React.CSSProperties = { border: `1px solid ${on ? accent : 'rgba(255,255,255,0.18)'}`, borderRadius: 8, padding: 10, marginBottom: 12, background: on ? 'rgba(255,255,255,0.06)' : 'transparent' }
  const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', color: 'white', padding: 6, borderRadius: 6, fontSize: 12 }
  const label: React.CSSProperties = { fontSize: 10, color: '#aaa', margin: '8px 0 3px', display: 'block' }
  return (
    <div style={box}>
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={toggle} aria-pressed={on} style={{ ...input, flex: 1, cursor: 'pointer', fontWeight: 600, fontSize: 13, padding: 8, background: on ? accent : 'rgba(255,255,255,0.1)', color: on ? '#000' : '#fff' }}>
          🖐 Leap Motion {on ? '— actif (débrancher)' : busy ? '— recherche… (annuler)' : '— activer'}
        </button>
        <button onClick={() => setOpen((v) => !v)} aria-expanded={open} title="Réglages du capteur" style={{ ...input, width: 34, cursor: 'pointer' }}>⚙</button>
      </div>
      {message && <div role="status" style={{ fontSize: 11, lineHeight: 1.35, marginTop: 6, color: status === 'error' ? '#ff6b6b' : '#9a9aa5' }}>{message}</div>}
      {on && settings.autoCal && <div style={{ fontSize: 11, lineHeight: 1.35, marginTop: 4, color: fit.n >= 6 ? '#7ddc9a' : '#ffd200' }}>
        {fit.n >= 6 ? `Calé sur l'image de la caméra : ${fit.n} zones mesurées, écart ${(fit.err * 100).toFixed(1)} % de l'image.`
          : fit.n ? `Calage en cours : ${fit.n} zone${fit.n > 1 ? 's' : ''} sur 6. Promène lentement ta main ouverte : à gauche, à droite, en haut, en bas, plus près, plus loin.`
          : settings.cal ? "Calage précédent repris. Il s'affine dès que la caméra voit ta main ouverte."
          : "Pour caler le Leap sur l'image : tiens une main ouverte au-dessus du capteur, bien visible par la caméra, presque immobile."}
      </div>}
      {open && (
        <div>
          <label style={label}>Emplacement du capteur
            <select value={settings.placement} onChange={(e) => setLeapSettings({ placement: e.target.value as 'desk' | 'screen' | 'head' })} style={{ ...input, marginTop: 3 }}>
              <option value="desk">À plat sur le bureau (fenêtre vers le haut)</option>
              <option value="screen">Fixé à l'écran, face à moi</option>
              <option value="head">Sur un casque, sur la tête (regarde devant moi)</option>
            </select>
          </label>
          <label style={{ ...label, display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#ccc' }}>
            <input type="checkbox" checked={settings.flip} onChange={(e) => setLeapSettings({ flip: e.target.checked })} style={{ accentColor: accent }} /> Capteur monté dans l'autre sens
          </label>
          {settings.placement === 'head' && <p style={{ fontSize: 10, color: '#888', lineHeight: 1.4, margin: '4px 0 0' }}>
            Sur la tête, le capteur bouge avec toi : le calage se refait en continu, reste face à l'écran. Si tes mains partent du mauvais côté, coche « monté dans l'autre sens ».
          </p>}
          <label style={{ ...label, display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#ccc' }}>
            <input type="checkbox" checked={settings.autoCal} onChange={(e) => setLeapSettings({ autoCal: e.target.checked })} style={{ accentColor: accent }} /> Caler tout seul sur l'image de la caméra
          </label>
          <button onClick={resetLeapCal} style={{ ...input, cursor: 'pointer', marginTop: 6 }}>Recommencer le calage</button>
          {settings.placement !== 'head' && <>
            <p style={{ fontSize: 10, color: '#888', lineHeight: 1.4, margin: '6px 0 0' }}>Sans caméra, ou case décochée, règle à la main les deux curseurs ci-dessous.</p>
            <label style={label}>Hauteur de la caméra au-dessus du capteur — {settings.height} mm
              <input type="range" min={0} max={700} step={10} value={settings.height} onChange={(e) => setLeapSettings({ height: +e.target.value })} style={{ width: '100%', accentColor: accent }} />
            </label>
            <label style={label}>Zone des mains couverte par l'écran — {settings.span} mm
              <input type="range" min={300} max={1400} step={20} value={settings.span} onChange={(e) => setLeapSettings({ span: +e.target.value })} style={{ width: '100%', accentColor: accent }} />
            </label>
          </>}
          <label style={label}>Adresse du service
            <input value={settings.url} onChange={(e) => setLeapSettings({ url: e.target.value })} onBlur={(e) => { if (!e.target.value.trim()) setLeapSettings({ url: LEAP_DEFAULTS.url }) }} spellCheck={false} style={{ ...input, marginTop: 3 }} />
          </label>
          <p style={{ fontSize: 10, color: '#888', lineHeight: 1.4, margin: '8px 0 0' }}>
            Leap Motion V2 ou Orion V4 : dans le panneau de contrôle Leap, coche « Autoriser les applications Web ».
            Gemini ou Hyperion : lance le pont <a href="/leap-bridge/leap_bridge.py" download style={{ color: accent }}>leap_bridge.py</a> (<code>pip install websockets</code> une fois, puis <code>py leap_bridge.py</code>).
            En ligne, Chrome demande aussi l'« Accès au réseau local » : réponds Autoriser.
          </p>
        </div>
      )}
    </div>
  )
}
