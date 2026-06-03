import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LogOut, ArrowLeft, Save, Eye, EyeOff, Check, X, KeyRound } from 'lucide-react'

interface KeyDef { key: string; label: string; placeholder: string; help: string }
interface KeyState { key: string; hint: string; configured: boolean }

export function AdminDashboard({ email, onLogout }: { email: string; onLogout: () => void }) {
  const [keys, setKeys] = useState<KeyDef[]>([])
  const [states, setStates] = useState<KeyState[]>([])
  const [values, setValues] = useState<Record<string, string>>({})
  const [shown, setShown] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null)
  const nav = useNavigate()

  const load = async () => {
    const r = await fetch('/api/admin/settings')
    const d = await r.json()
    if (r.ok) { setKeys(d.keys); setStates(d.items) }
  }
  useEffect(() => { load() }, [])

  const showToast = (msg: string, err = false) => {
    setToast({ msg, err })
    setTimeout(() => setToast(null), 2500)
  }

  const save = async (key: string) => {
    const value = values[key] ?? ''
    setBusy((b) => ({ ...b, [key]: true }))
    try {
      const r = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, value }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'erreur')
      setValues((v) => ({ ...v, [key]: '' }))
      showToast(value === '' ? `${key} supprimée` : `${key} enregistrée`)
      await load()
    } catch (e: any) { showToast(e.message, true) }
    finally { setBusy((b) => ({ ...b, [key]: false })) }
  }

  const logout = async () => {
    await fetch('/api/admin/logout', { method: 'POST' })
    onLogout()
  }

  return (
    <div className="admin-shell" style={{ alignItems: 'flex-start', paddingTop: 40 }}>
      <div style={{ position: 'absolute', top: 16, left: 16, display: 'flex', gap: 8 }}>
        <button className="ghost" onClick={() => nav('/')}><ArrowLeft size={14} /> Studio</button>
      </div>
      <div style={{ position: 'absolute', top: 16, right: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>connecté : <strong style={{ color: 'var(--text)' }}>{email}</strong></span>
        <button className="ghost" onClick={logout}><LogOut size={14} /> Déconnexion</button>
      </div>

      <div className="admin-card admin-wide">
        <div className="admin-title"><KeyRound size={18} style={{ color: 'var(--accent)' }} /> Clés API</div>
        <p style={{ color: 'var(--text-dim)', marginBottom: 20, fontSize: 13 }}>
          Les clés sont chiffrées (AES-256-GCM) avant d'être stockées. Elles ne ressortent jamais en clair côté client — seul un indice est affiché.
        </p>

        <div className="keys-grid">
          {keys.map((k) => {
            const st = states.find((s) => s.key === k.key)
            const configured = !!st?.configured
            const shownNow = !!shown[k.key]
            return (
              <div key={k.key} className="key-card">
                <div className="key-head">
                  <div>
                    <div className="key-label">{k.label}</div>
                    <div className="key-name"><code>{k.key}</code></div>
                  </div>
                  <div className={`key-status ${configured ? 'ok' : 'ko'}`}>
                    {configured ? <><Check size={12} /> Configurée</> : <><X size={12} /> Manquante</>}
                  </div>
                </div>
                <div className="key-help">{k.help}</div>
                {configured && st!.hint && <div className="key-hint">Indice actuel : <code>{st!.hint}</code></div>}
                <div className="key-input-row">
                  <input
                    type={shownNow ? 'text' : 'password'}
                    placeholder={configured ? `Remplacer (${k.placeholder})` : k.placeholder}
                    value={values[k.key] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [k.key]: e.target.value }))}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className="ghost icon"
                    onClick={() => setShown((s) => ({ ...s, [k.key]: !s[k.key] }))}
                    title={shownNow ? 'Masquer' : 'Afficher'}
                  >
                    {shownNow ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy[k.key] || (values[k.key] ?? '') === ''}
                    onClick={() => save(k.key)}
                  >
                    <Save size={14} /> {busy[k.key] ? '...' : 'Enregistrer'}
                  </button>
                  {configured && (
                    <button
                      type="button"
                      className="danger"
                      disabled={busy[k.key]}
                      onClick={() => { if (confirm(`Supprimer ${k.key} ?`)) { setValues((v) => ({ ...v, [k.key]: '' })); save(k.key) } }}
                    >
                      Supprimer
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
      {toast && <div className={`toast ${toast.err ? 'error' : ''}`}>{toast.msg}</div>}
    </div>
  )
}
