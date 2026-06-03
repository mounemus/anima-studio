import { db, SCENES } from './db'
import type { Scene } from '../types/scene'

export async function saveScene(s: Scene) {
  const d = await db()
  await d.put(SCENES, { ...s, updatedAt: Date.now() })
}

export async function loadAllScenes(): Promise<Scene[]> {
  const d = await db()
  return await d.getAll(SCENES)
}

export async function deleteScene(id: string) {
  const d = await db()
  await d.delete(SCENES, id)
}

export async function clearAll() {
  const d = await db()
  await d.clear(SCENES)
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
