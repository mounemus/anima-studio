import { Link } from 'react-router-dom'

// Atelier « Sculptures cinétiques » : l'appli Kinetic Studio, construite à part (dépôt local kinetic-studio)
// et servie telle quelle depuis public/kinetic-app. Elle garde ses propres réglages (localStorage « kinetic-studio.* »)
// et prend la palette de DigiArt grâce au paramètre ?hote=anima.
export function KineticStudio() {
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 14px', borderBottom: '1px solid var(--line)', background: 'var(--bg-elev)', fontSize: 12 }}>
        <Link to="/" style={{ color: 'var(--text-dim)', textDecoration: 'none' }}>← Studio</Link>
        <strong style={{ color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: 1 }}>Sculptures cinétiques</strong>
        <span style={{ color: 'var(--text-dim)' }}>fleurs et vagues mécaniques à imprimer : forme, mécanisme, simulation, dossier de fabrication</span>
      </div>
      <iframe
        title="Kinetic Studio"
        src="/kinetic-app/index.html?hote=anima"
        style={{ flex: 1, width: '100%', border: 0, background: 'var(--bg)' }}
      />
    </div>
  )
}
