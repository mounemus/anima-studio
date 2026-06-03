/** WebXR helpers — best-effort AR session for compatible mobile / Quest browsers. */

export async function isXRARSupported(): Promise<boolean> {
  const nav: any = navigator
  if (!nav.xr || !nav.xr.isSessionSupported) return false
  try { return await nav.xr.isSessionSupported('immersive-ar') } catch { return false }
}

let currentSession: any = null

export async function startXR(renderer: any, onEnd?: () => void): Promise<boolean> {
  const nav: any = navigator
  if (!nav.xr) return false
  try {
    const session = await nav.xr.requestSession('immersive-ar', {
      optionalFeatures: ['local-floor', 'bounded-floor', 'dom-overlay'],
      domOverlay: { root: document.body },
    })
    currentSession = session
    renderer.xr.enabled = true
    await renderer.xr.setSession(session)
    session.addEventListener('end', () => {
      currentSession = null
      renderer.xr.enabled = false
      onEnd?.()
    })
    return true
  } catch (e) {
    console.warn('XR session failed', e)
    return false
  }
}

export function endXR() {
  if (currentSession) {
    try { currentSession.end() } catch { /* noop */ }
  }
}

export function isInXR(): boolean { return !!currentSession }
