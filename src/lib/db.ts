/** Single source of truth for IndexedDB. Both scenes and calibrations live here. */
import { openDB, type IDBPDatabase } from 'idb'

export const DB_NAME = 'anima-studio'
export const SCENES = 'scenes'
export const CALIBRATIONS = 'calibrations'
export const DB_VERSION = 2

const OPEN_TIMEOUT_MS = 3000

let dbp: Promise<IDBPDatabase> | null = null

export function db(): Promise<IDBPDatabase> {
  if (!dbp) {
    dbp = openWithTimeout()
  }
  return dbp
}

function openWithTimeout(): Promise<IDBPDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      dbp = null    // allow retries
      reject(new Error(`IndexedDB open timed out after ${OPEN_TIMEOUT_MS}ms — another tab probably holds the DB. Close other Anima Studio tabs and reload.`))
    }, OPEN_TIMEOUT_MS)

    openDB(DB_NAME, DB_VERSION, {
      upgrade(d) {
        if (!d.objectStoreNames.contains(SCENES)) d.createObjectStore(SCENES, { keyPath: 'id' })
        if (!d.objectStoreNames.contains(CALIBRATIONS)) d.createObjectStore(CALIBRATIONS, { keyPath: 'id' })
      },
      blocked() {
        console.warn('IndexedDB blocked — another tab holds an older version. Close other Anima Studio tabs.')
      },
      blocking() {
        // another tab wants to upgrade — release our connection
        try { dbp = null } catch { /* noop */ }
      },
      terminated() {
        console.warn('IndexedDB connection terminated by browser')
        dbp = null
      },
    }).then((d) => {
      if (settled) { try { d.close() } catch {} ; return }
      settled = true
      clearTimeout(timer)
      resolve(d)
    }).catch((err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      dbp = null
      reject(err)
    })
  })
}

/** Force a fresh open (used if user wants to retry after closing other tabs). */
export function resetDb() { dbp = null }

/**
 * Nuke the IndexedDB completely. Returns a promise that resolves once deleted.
 * Use as a last resort when the DB is permanently stuck (locked by another process,
 * corrupted, version mismatch, etc.). After this, calling db() will create a fresh empty DB.
 */
export async function destroyDb(): Promise<void> {
  dbp = null
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    const timer = setTimeout(() => {
      // even delete can hang if another connection is open — just resolve and reload
      resolve()
    }, 2000)
    req.onsuccess = () => { clearTimeout(timer); resolve() }
    req.onerror = () => { clearTimeout(timer); reject(req.error) }
    req.onblocked = () => {
      console.warn('Delete blocked — another tab still has the DB open. Will resolve via timeout.')
    }
  })
}
