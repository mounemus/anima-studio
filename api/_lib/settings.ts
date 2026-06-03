import { supa, supaConfigured } from './supabase'
import { decryptString, encryptString, hint } from './crypto'

export const KNOWN_KEYS = [
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic (Claude)', placeholder: 'sk-ant-...', help: 'Compagnon IA — modifie tes scènes par prompt.' },
  { key: 'FAL_KEY', label: 'fal.ai (SDXL Turbo, Flux)', placeholder: 'fal-...', help: 'Génération d\'images / textures live (~1s).' },
  { key: 'OPENAI_API_KEY', label: 'OpenAI', placeholder: 'sk-proj-...', help: 'Alternative IA / TTS / Whisper.' },
  { key: 'ELEVENLABS_API_KEY', label: 'ElevenLabs', placeholder: 'sk_...', help: 'Voix de synthèse pour installations parlantes.' },
  { key: 'REPLICATE_API_TOKEN', label: 'Replicate', placeholder: 'r8_...', help: 'Modèles open-source (vidéo, 3D, audio).' },
  { key: 'STABILITY_API_KEY', label: 'Stability AI', placeholder: 'sk-...', help: 'Stable Diffusion 3, ControlNet officiel.' },
] as const

export type SettingKey = typeof KNOWN_KEYS[number]['key']

export async function getSetting(key: string): Promise<string | null> {
  // Prefer DB, fallback to env var (so the legacy ANTHROPIC_API_KEY env still works)
  if (supaConfigured()) {
    try {
      const { data } = await supa().from('app_settings').select('value').eq('key', key).maybeSingle()
      if (data?.value) {
        try { return await decryptString(data.value) } catch { /* corrupt — fallthrough */ }
      }
    } catch { /* DB error — fallthrough */ }
  }
  return (globalThis as any).process?.env?.[key] ?? null
}

export async function listSettings(): Promise<{ key: string; hint: string; configured: boolean }[]> {
  const env = (globalThis as any).process?.env ?? {}
  const out: { key: string; hint: string; configured: boolean }[] = []
  let dbRows: { key: string; value: string; hint: string | null }[] = []
  if (supaConfigured()) {
    try {
      const { data } = await supa().from('app_settings').select('key, value, hint')
      dbRows = data ?? []
    } catch { /* ignore */ }
  }
  for (const k of KNOWN_KEYS) {
    const row = dbRows.find((r) => r.key === k.key)
    const hasDb = !!row?.value
    const hasEnv = !!env[k.key]
    out.push({
      key: k.key,
      hint: row?.hint ?? (hasEnv ? '(env)' : ''),
      configured: hasDb || hasEnv,
    })
  }
  return out
}

export async function setSetting(key: string, value: string, updatedBy?: string) {
  if (!supaConfigured()) throw new Error('Supabase non configurée — impossible de sauvegarder.')
  const trimmed = value.trim()
  const enc = await encryptString(trimmed)
  const h = hint(trimmed)
  const { error } = await supa()
    .from('app_settings')
    .upsert({ key, value: enc, hint: h, updated_by: updatedBy ?? null, updated_at: new Date().toISOString() })
  if (error) throw new Error(error.message)
}

export async function deleteSetting(key: string) {
  if (!supaConfigured()) throw new Error('Supabase non configurée.')
  const { error } = await supa().from('app_settings').delete().eq('key', key)
  if (error) throw new Error(error.message)
}
