/**
 * ErrorBoundary — dernière ligne de défense contre un crash React total.
 *
 * Sans ça, un throw dans n'importe quel composant démonte tout le tree et
 * l'utilisateur se retrouve avec un écran noir sans aucun feedback ni
 * moyen de récupérer.
 *
 * Ici on affiche un panneau minimal explicite avec :
 *  - le message d'erreur
 *  - un bouton pour recharger la page
 *  - un bouton "Vider mes scènes" (localStorage anima:scene:*) au cas où
 *    une scène corrompue bloque le boot indéfiniment
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { error: Error | null; info: ErrorInfo | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] app crashed', error, info)
    this.setState({ info })
  }

  private wipeScenes = () => {
    try {
      const keys: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k && k.startsWith('anima:scene:')) keys.push(k)
      }
      keys.forEach((k) => localStorage.removeItem(k))
    } catch { /* ignore */ }
    window.location.reload()
  }

  private wipeAll = () => {
    try {
      const keys: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k && k.startsWith('anima:')) keys.push(k)
      }
      keys.forEach((k) => localStorage.removeItem(k))
    } catch { /* ignore */ }
    window.location.reload()
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          position: 'fixed', inset: 0,
          background: 'var(--bg, #07080d)', color: 'var(--text, #d8dce8)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 24, fontFamily: 'system-ui, sans-serif', zIndex: 99999,
        }}>
          <div style={{
            maxWidth: 520,
            background: 'var(--bg-elev, #0e1018)',
            border: '1px solid var(--danger, #ff5a7a)',
            borderRadius: 10, padding: 24,
          }}>
            <h2 style={{ margin: '0 0 8px', color: 'var(--danger, #ff5a7a)' }}>
              ⚠ Erreur au chargement
            </h2>
            <p style={{ fontSize: 13, color: 'var(--text-dim, #8a8fa3)', marginTop: 0 }}>
              L'application a rencontré une erreur inattendue. Voici les options pour récupérer :
            </p>
            <pre style={{
              fontSize: 11, background: 'var(--bg, #000)', padding: 10,
              borderRadius: 4, overflow: 'auto', maxHeight: 140,
              color: 'var(--warn, #ffb547)', fontFamily: 'ui-monospace, monospace',
            }}>{String(this.state.error?.message ?? this.state.error)}</pre>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 }}>
              <button
                onClick={() => window.location.reload()}
                style={{
                  padding: '10px 14px', fontSize: 13, cursor: 'pointer',
                  background: 'var(--accent, #00ffa3)', color: '#001110',
                  border: 'none', borderRadius: 6, fontWeight: 600,
                }}
              >
                🔄 Recharger la page
              </button>
              <button
                onClick={this.wipeScenes}
                style={{
                  padding: '10px 14px', fontSize: 13, cursor: 'pointer',
                  background: 'transparent', color: 'var(--text, #d8dce8)',
                  border: '1px solid var(--line, #232633)', borderRadius: 6,
                }}
              >
                🗑 Vider mes scènes sauvegardées (repartir des scènes par défaut)
              </button>
              <button
                onClick={this.wipeAll}
                style={{
                  padding: '8px 14px', fontSize: 12, cursor: 'pointer',
                  background: 'transparent', color: 'var(--danger, #ff5a7a)',
                  border: '1px solid var(--danger, #ff5a7a)', borderRadius: 6,
                }}
              >
                💣 Reset complet (efface tout — scènes, calibrations, préférences)
              </button>
            </div>
            <p style={{ fontSize: 10, color: 'var(--text-mute, #5b6075)', marginTop: 16 }}>
              Si l'erreur revient après reset, c'est un bug de l'app — signale-le sur GitHub.
            </p>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
