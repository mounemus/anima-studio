import { openDB, type IDBPDatabase } from 'idb'
import type { Scene } from '../types/scene'

const DB = 'anima-studio'
const STORE = 'scenes'

let dbp: Promise<IDBPDatabase> | null = null

function db() {
  if (!dbp) {
    dbp = openDB(DB, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' })
        }
      },
    })
  }
  return dbp
}

export async function saveScene(s: Scene) {
  const d = await db()
  await d.put(STORE, { ...s, updatedAt: Date.now() })
}

export async function loadAllScenes(): Promise<Scene[]> {
  const d = await db()
  return await d.getAll(STORE)
}

export async function deleteScene(id: string) {
  const d = await db()
  await d.delete(STORE, id)
}

export async function clearAll() {
  const d = await db()
  await d.clear(STORE)
}

export function exportSceneJSON(s: Scene) {
  const blob = new Blob([JSON.stringify(s, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${s.id}.scene.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function importSceneJSON(file: File): Promise<Scene> {
  const text = await file.text()
  const s = JSON.parse(text) as Scene
  if (!s.id || !s.organism) throw new Error('Invalid scene file')
  return s
}
