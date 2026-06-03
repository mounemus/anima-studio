import { useState } from 'react'
import { Sparkles } from 'lucide-react'

export function AdminSetup({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (password !== confirm) { setError('Les mots de passe ne correspondent pas.'); return }
    setBusy(true)
    try {
      const r = await fetch('/api/admin/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'erreur')
      onDone()
    } catch (e: any) { setError(e.message); setBusy(false) }
  }

  return (
    <div className="admin-shell">
      <form className="admin-card" onSubmit={submit}>
        <div className="admin-title"><Sparkles size={18} style={{ color: 'var(--accent)' }} /> Création de l'admin</div>
        <p style={{ color: 'var(--text-dim)', marginBottom: 18, fontSize: 13 }}>
          Premier lancement : choisis tes identifiants. Ils seront stockés hashés (bcrypt) dans Supabase.
        </p>
        <div className="form-row">
          <label>Email</label>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </div>
        <div className="form-row">
          <label>Mot de passe (8 caractères min.)</label>
          <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div className="form-row">
          <label>Confirme</label>
          <input type="password" required minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        {error && <div className="form-error">{error}</div>}
        <button className="primary" type="submit" disabled={busy} style={{ width: '100%', justifyContent: 'center', marginTop: 10 }}>
          {busy ? 'Création...' : 'Créer mon compte admin'}
        </button>
      </form>
    </div>
  )
}
