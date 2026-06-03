/**
 * Window Management API — opens a dedicated output window on a chosen display.
 * Falls back to a new window on the primary display when the API is unavailable.
 *
 * The output window navigates to `/?output=1` which the app interprets as
 * "render only, no UI" (re-uses existing output mode).
 */

export interface DisplayInfo {
  id: string
  label: string
  width: number
  height: number
  left: number
  top: number
  isPrimary: boolean
  isInternal: boolean
}

export async function hasWindowManagement(): Promise<boolean> {
  const w = window as any
  if (!w.getScreenDetails) return false
  try {
    const perm = await navigator.permissions.query({ name: 'window-management' as PermissionName })
    return perm.state !== 'denied'
  } catch {
    return true
  }
}

export async function listDisplays(): Promise<DisplayInfo[]> {
  const w = window as any
  if (!w.getScreenDetails) {
    // fallback: only the current screen
    return [{
      id: 'current',
      label: 'Écran courant',
      width: screen.width, height: screen.height,
      left: 0, top: 0,
      isPrimary: true, isInternal: true,
    }]
  }
  try {
    const details = await w.getScreenDetails()
    return details.screens.map((s: any, i: number) => ({
      id: String(i),
      label: s.label || `Écran ${i + 1}`,
      width: s.width,
      height: s.height,
      left: s.availLeft,
      top: s.availTop,
      isPrimary: s.isPrimary,
      isInternal: s.isInternal,
    }))
  } catch (e) {
    return [{
      id: 'current',
      label: 'Écran courant',
      width: screen.width, height: screen.height,
      left: 0, top: 0,
      isPrimary: true, isInternal: true,
    }]
  }
}

let outputWin: Window | null = null

export function openOutputWindow(display: DisplayInfo): Window | null {
  closeOutputWindow()
  const features = [
    `left=${display.left}`,
    `top=${display.top}`,
    `width=${display.width}`,
    `height=${display.height}`,
    'noopener=no',
    'menubar=no',
    'toolbar=no',
    'status=no',
    'location=no',
  ].join(',')
  outputWin = window.open(`/?output=1&display=${display.id}`, 'anima-output', features)
  // try to enter fullscreen on the new window once it loads
  if (outputWin) {
    setTimeout(() => {
      try {
        const doc = outputWin?.document
        const el = doc?.documentElement
        if (el && (el as any).requestFullscreen) (el as any).requestFullscreen({ navigationUI: 'hide' })
      } catch { /* cross-origin or denied */ }
    }, 800)
  }
  return outputWin
}

export function closeOutputWindow() {
  if (outputWin && !outputWin.closed) {
    try { outputWin.close() } catch { /* ignore */ }
  }
  outputWin = null
}

export function isOutputWindow(): boolean {
  return new URLSearchParams(window.location.search).get('output') === '1'
}
