import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AdminSetup } from './AdminSetup'
import { AdminLogin } from './AdminLogin'
import { AdminDashboard } from './AdminDashboard'
import { ArrowLeft } from 'lucide-react'

interface Status {
  kv: boolean
  encryptKey: boolean
  jwtSecret: boolean
  setupComplete: boolean
}

interface Me { authenticated: boolean; email?: string }

export function AdminPage() {
  const [status, setStatus] = useState<Status | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
  const nav = useNavigate()

  useEffect(() => {
    fetch('/api/admin/status').then((r) => r.json()).then(setStatus).catch(() => setStatus({ kv: false, encryptKey: false, jwtSecret: false, setupComplete: false }))
    fetch('/api/admin/me').then((r) => r.json()).then(setMe).catch(() => setMe({ authenticated: false }))
  }, [refreshTick])

  if (!status || !me) return <div className="admin-shell"><div className="admin-card"><div className="admin-title">Anima · Admin</div><p>Chargement...</p></div></div>

  const allReady = status.kv && status.encryptKey && status.jwtSecret
  if (!allReady) return (
    <div className="admin-shell">
      <button className="ghost" onClick={() => nav('/')} style={{ position: 'absolute', top: 16, left: 16 }}>
        <ArrowLeft size={14} /> Retour
      </button>
      <div className="admin-card">
        <div className="admin-title">Configuration serveur requise</div>
        <p style={{ color: 'var(--text-dim)', marginBottom: 18 }}>
          Pour activer l'admin, configure ces variables d'environnement sur Vercel puis redéploie :
        </p>
        <ul className="env-checklist">
          <li className={status.kv ? 'ok' : 'ko'}>
            <code>KV_REST_API_URL</code> + <code>KV_REST_API_TOKEN</code>
            <small>Vercel Dashboard → Storage → Create Database → KV. Les env vars sont injectées automatiquement.</small>
          </li>
          <li className={status.encryptKey ? 'ok' : 'ko'}>
            <code>ENCRYPT_KEY</code>
            <small>32+ caractères pour chiffrer les clés API. Ex : <code>openssl rand -hex 32</code></small>
          </li>
          <li className={status.jwtSecret ? 'ok' : 'ko'}>
            <code>JWT_SECRET</code>
            <small>16+ caractères pour signer les sessions admin.</small>
          </li>
        </ul>
        <p style={{ color: 'var(--text-mute)', marginTop: 18, fontSize: 12 }}>
          Une fois fait : <code>vercel deploy --prod</code> puis recharge cette page.
        </p>
      </div>
    </div>
  )

  if (!status.setupComplete) return <AdminSetup onDone={() => setRefreshTick((t) => t + 1)} />
  if (!me.authenticated) return <AdminLogin onDone={() => setRefreshTick((t) => t + 1)} />
  return <AdminDashboard email={me.email!} onLogout={() => setRefreshTick((t) => t + 1)} />
}
