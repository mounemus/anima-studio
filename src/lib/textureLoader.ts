import * as THREE from 'three'

const cache = new Map<string, Promise<THREE.Texture>>()

export function loadTexture(url: string): Promise<THREE.Texture> {
  const existing = cache.get(url)
  if (existing) return existing
  const p = new Promise<THREE.Texture>((resolve, reject) => {
    const loader = new THREE.TextureLoader()
    loader.setCrossOrigin('anonymous')
    loader.load(
      url,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace
        tex.minFilter = THREE.LinearMipmapLinearFilter
        tex.magFilter = THREE.LinearFilter
        tex.generateMipmaps = true
        resolve(tex)
      },
      undefined,
      (err) => { cache.delete(url); reject(err) },
    )
  })
  cache.set(url, p)
  return p
}

export function clearTextureCache() {
  for (const p of cache.values()) {
    p.then((t) => t.dispose()).catch(() => {})
  }
  cache.clear()
}
