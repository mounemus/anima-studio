/** Calibration profiles : sauvegarde de configurations mapping nommées (un par site/installation). */
import { db, CALIBRATIONS } from './db'
import type { MappingConfig } from '../types/scene'

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
  await d.put(CALIBRATIONS, { ...p, updatedAt: Date.now() })
}

export async function listCalibrations(): Promise<CalibrationProfile[]> {
  const d = await db()
  return ((await d.getAll(CALIBRATIONS)) as CalibrationProfile[]).sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function deleteCalibration(id: string) {
  const d = await db()
  await d.delete(CALIBRATIONS, id)
}

export async function getCalibration(id: string): Promise<CalibrationProfile | undefined> {
  const d = await db()
  return (await d.get(CALIBRATIONS, id)) as CalibrationProfile | undefined
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
