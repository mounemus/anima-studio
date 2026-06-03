/**
 * Lightweight localStorage wrapper. Synchronous, no version conflict, no multi-tab lock.
 * Our payload (a few KB of scenes + calibrations) is orders of magnitude under the 5 MB cap.
 */

const PREFIX = 'anima:'

export function getItem<T>(key: string): T | null {
  try {
    const s = localStorage.getItem(PREFIX + key)
    return s ? (JSON.parse(s) as T) : null
  } catch { return null }
}

export function setItem<T>(key: string, value: T): boolean {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
    return true
  } catch (e) {
    console.warn(`localStorage write failed for ${key}`, e)
    return false
  }
}

export function removeItem(key: string) {
  try { localStorage.removeItem(PREFIX + key) } catch { /* ignore */ }
}

/** List all keys (without prefix) starting with a given sub-prefix. */
export function listKeys(subPrefix: string): string[] {
  const out: string[] = []
  try {
    const full = PREFIX + subPrefix
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(full)) out.push(k.slice(PREFIX.length))
    }
  } catch { /* ignore */ }
  return out
}

export function hasStorage(): boolean {
  try {
    const probe = '__anima_probe__'
    localStorage.setItem(probe, '1')
    localStorage.removeItem(probe)
    return true
  } catch { return false }
}

/** Wipe everything under the anima namespace. */
export function clearNamespace() {
  try {
    const keysToRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(PREFIX)) keysToRemove.push(k)
    }
    keysToRemove.forEach((k) => localStorage.removeItem(k))
  } catch { /* ignore */ }
}
