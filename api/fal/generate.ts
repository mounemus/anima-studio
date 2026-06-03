import { getSetting } from '../_lib/settings'
import { jsonResponse } from '../_lib/auth'
import { guard, readJsonCapped } from '../_lib/guard'

export const config = { runtime: 'edge' }

// Whitelist of allowed fal.ai models — prevents callers from picking
// expensive ones (Flux Pro ~$0.05/img vs Schnell ~$0.003).
const ALLOWED_MODELS = new Set([
  'fal-ai/flux/schnell',
  'fal-ai/fast-sdxl',
  'fal-ai/fast-lightning-sdxl',
])

/**
 * POST /api/fal/generate
 * Body: { prompt: string, model?: string, size?: 'square' | 'square_hd' | 'portrait' | 'landscape' }
 * Returns: { url, width, height, model, seed }
 *
 * Defaults to Flux Schnell (~1s, free-ish tier). Falls back to fast-sdxl.
 */
export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonResponse({ error: 'method' }, { status: 405 })
  const gate = await guard(req, { bucket: 'fal-generate', perMin: 10 })
  if (gate instanceof Response) return gate

  const apiKey = await getSetting('FAL_KEY')
  if (!apiKey) return jsonResponse({ error: 'Clé fal.ai non configurée. Va sur /admin.' }, { status: 500 })

  const parsed = await readJsonCapped<{ prompt?: string; model?: string; size?: string }>(req, 32 * 1024)
  if (parsed instanceof Response) return parsed
  const body = parsed

  const prompt = body.prompt?.toString().slice(0, 800).trim()
  if (!prompt) return jsonResponse({ error: 'prompt manquant' }, { status: 400 })

  const requestedModel = body.model?.toString() || 'fal-ai/flux/schnell'
  const model = ALLOWED_MODELS.has(requestedModel) ? requestedModel : 'fal-ai/flux/schnell'
  const sizeMap: Record<string, { width: number; height: number }> = {
    square: { width: 512, height: 512 },
    square_hd: { width: 1024, height: 1024 },
    portrait: { width: 768, height: 1024 },
    landscape: { width: 1024, height: 768 },
  }
  const size = sizeMap[body.size || 'square'] ?? sizeMap.square

  try {
    const r = await fetch(`https://fal.run/${model}`, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt,
        image_size: size,
        num_inference_steps: 4,
        num_images: 1,
        enable_safety_checker: true,
      }),
    })
    if (!r.ok) {
      const txt = await r.text()
      console.error('[api/fal/generate]', r.status, txt.slice(0, 500))
      return jsonResponse({ error: `fal.ai indisponible (${r.status})` }, { status: 502 })
    }
    const data = await r.json() as { images?: { url: string; width?: number; height?: number }[]; seed?: number }
    const img = data.images?.[0]
    if (!img?.url) return jsonResponse({ error: 'Pas d\'image générée' }, { status: 502 })
    return jsonResponse({
      url: img.url,
      width: img.width ?? size.width,
      height: img.height ?? size.height,
      model,
      seed: data.seed,
      prompt,
    })
  } catch (e: any) {
    console.error('[api/fal/generate]', e)
    return jsonResponse({ error: 'erreur côté fal.ai' }, { status: 500 })
  }
}
