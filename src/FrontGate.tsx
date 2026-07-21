import { useCallback, useEffect, useState } from 'react'
import { Lock } from 'lucide-react'
import { AdminSetup } from './admin/AdminSetup'

/**
 * Front-office access gate — no free access. Reuses the SAME account/session as
 * the admin (one login controls the studio and the admin). Flow:
 *   backend not configured / unreachable → OPEN  (never lock a live installation
 *     out because KV or the network hiccuped mid-show — the art keeps running)
 *   configured + no account yet          → account creation (AdminSetup)
 *   configured + account + not signed in → login
 *   signed in                            → the app
 */
type GateState = 'loading' | 'setup' | 'login' | 'open'

export function FrontGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<GateState>('loading')

  const check = useCallback(() => {
    Promise.all([
      fetch('/api/admin/status').then((r) => r.json()).catch(() => null),
      fetch('/api/admin/me').then((r) => r.json()).catch(() => null),
    ]).then(([status, me]) => {
      // Fail OPEN when auth isn't set up on the server (no KV/JWT) or unreachable:
      // a live show must not be locked out by a backend outage.
      if (!status || !status.kv || !status.jwtSecret) { setState('open'); return }
      if (!status.setupComplete) { setState('setup'); return }
      if (!me || !me.authenticated) { setState('login'); return }
      setState('open')
    }).catch(() => setState('open'))
  }, [])

  useEffect(() => { check() }, [check])

  if (state === 'loading') {
    return <div className="admin-shell"><div className="admin-card"><div className="admin-title">DigiArt</div><p>Chargement…</p></div></div>
  }
  if (state === 'setup') return <AdminSetup onDone={check} />
  if (state === 'login') return <FrontLogin onDone={check} />
  return <>{children}</>
}

function FrontLogin({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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
      if (!r.ok) throw new Error(d.error || 'Identifiants invalides')
      onDone()
    } catch (e: any) { setError(e.message); setBusy(false) }
  }

  return (
    <div className="admin-shell">
      <form className="admin-card" onSubmit={submit}>
        <div className="admin-title"><Lock size={18} style={{ color: 'var(--accent)' }} /> DigiArt · Accès</div>
        <p style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 14 }}>
          Accès réservé. Connecte-toi avec ton compte pour ouvrir le studio.
        </p>
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
          {busy ? 'Connexion…' : 'Se connecter'}
        </button>
      </form>
    </div>
  )
}
