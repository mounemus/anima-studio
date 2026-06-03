/** Calibration profiles : sauvegarde de configurations mapping nommées (un par site/installation). */
import { openDB, type IDBPDatabase } from 'idb'
import type { MappingConfig } from '../types/scene'

const DB = 'anima-studio'
const STORE = 'calibrations'

let dbp: Promise<IDBPDatabase> | null = null

function db() {
  if (!dbp) {
    dbp = openDB(DB, 2, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('scenes')) db.createObjectStore('scenes', { keyPath: 'id' })
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
      },
    })
  }
  return dbp
}

export interface CalibrationProfile {
  id: string
  name: string
  site?: string
  notes?: string
  mapping: MappingConfig
  createdAt: number
  updatedAt: number
}

export async function saveCalibration(p: CalibrationProfile) {
  const d = await db()
  await d.put(STORE, { ...p, updatedAt: Date.now() })
}

export async function listCalibrations(): Promise<CalibrationProfile[]> {
  const d = await db()
  return (await d.getAll(STORE)).sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function deleteCalibration(id: string) {
  const d = await db()
  await d.delete(STORE, id)
}

export async function getCalibration(id: string): Promise<CalibrationProfile | undefined> {
  const d = await db()
  return await d.get(STORE, id)
}

export function exportCalibration(p: CalibrationProfile) {
  const blob = new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${p.name.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}.calibration.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
