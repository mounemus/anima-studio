/** Single source of truth for IndexedDB. Both scenes and calibrations live here. */
import { openDB, type IDBPDatabase } from 'idb'

export const DB_NAME = 'anima-studio'
export const SCENES = 'scenes'
export const CALIBRATIONS = 'calibrations'
export const DB_VERSION = 2

let dbp: Promise<IDBPDatabase> | null = null

export function db(): Promise<IDBPDatabase> {
  if (!dbp) {
    dbp = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(SCENES)) db.createObjectStore(SCENES, { keyPath: 'id' })
        if (!db.objectStoreNames.contains(CALIBRATIONS)) db.createObjectStore(CALIBRATIONS, { keyPath: 'id' })
      },
      blocked() { console.warn('IndexedDB blocked — close other tabs of Anima Studio') },
      blocking() { dbp = null /* let other connection upgrade */ },
    }).catch((err) => {
      console.error('IndexedDB open failed', err)
      dbp = null
      throw err
    }) as Promise<IDBPDatabase>
  }
  return dbp
}
