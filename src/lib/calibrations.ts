/** Calibration profiles : sauvegarde de configurations mapping nommées (un par site/installation). */
import type { MappingConfig } from '../types/scene'
import { getItem, setItem, removeItem, listKeys } from './storage'

const KEY = (id: string) => `cal:${id}`
const PREFIX = 'cal:'

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
  setItem(KEY(p.id), { ...p, updatedAt: Date.now() })
}

export async function listCalibrations(): Promise<CalibrationProfile[]> {
  const keys = listKeys(PREFIX)
  const out: CalibrationProfile[] = []
  for (const k of keys) {
    const c = getItem<CalibrationProfile>(k)
    if (c && c.id) out.push(c)
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function deleteCalibration(id: string) {
  removeItem(KEY(id))
}

export async function getCalibration(id: string): Promise<CalibrationProfile | undefined> {
  return getItem<CalibrationProfile>(KEY(id)) ?? undefined
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
