import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Lock, ArrowLeft } from 'lucide-react'

export function AdminLogin({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const nav = useNavigate()

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null); setBusy(true)
    try {
      const r = await fetch('/api/admin/login', {
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
      <button className="ghost" onClick={() => nav('/')} style={{ position: 'absolute', top: 16, left: 16 }}>
        <ArrowLeft size={14} /> Retour
      </button>
      <form className="admin-card" onSubmit={submit}>
        <div className="admin-title"><Lock size={18} style={{ color: 'var(--accent)' }} /> Admin</div>
        <div className="form-row">
          <label>Email</label>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </div>
        <div className="form-row">
          <label>Mot de passe</label>
          <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && <div className="form-error">{error}</div>}
        <button className="primary" type="submit" disabled={busy} style={{ width: '100%', justifyContent: 'center', marginTop: 10 }}>
          {busy ? 'Connexion...' : 'Se connecter'}
        </button>
      </form>
    </div>
  )
}
