import { getSetting } from '../_lib/settings'
import { jsonResponse } from '../_lib/auth'

export const config = { runtime: 'edge' }

/**
 * POST /api/fal/generate
 * Body: { prompt: string, model?: string, size?: 'square' | 'square_hd' | 'portrait' | 'landscape' }
 * Returns: { url, width, height, model, seed }
 *
 * Defaults to Flux Schnell (~1s, free-ish tier). Falls back to fast-sdxl.
 */
export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonResponse({ error: 'method' }, { status: 405 })

  const apiKey = await getSetting('FAL_KEY')
  if (!apiKey) return jsonResponse({ error: 'Clé fal.ai non configurée. Va sur /admin.' }, { status: 500 })

  let body: { prompt?: string; model?: string; size?: string }
  try { body = await req.json() } catch { return jsonResponse({ error: 'bad json' }, { status: 400 }) }

  const prompt = body.prompt?.toString().slice(0, 800).trim()
  if (!prompt) return jsonResponse({ error: 'prompt manquant' }, { status: 400 })

  const model = body.model?.toString() || 'fal-ai/flux/schnell'
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
      return jsonResponse({ error: `fal.ai ${r.status}: ${txt.slice(0, 200)}` }, { status: 502 })
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
    return jsonResponse({ error: e?.message ?? 'erreur' }, { status: 500 })
  }
}
