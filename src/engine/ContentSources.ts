/**
 * Per-shape content sources for the mapping pass.
 * Manages the lifecycle of video / image / webcam textures so each mapped zone can
 * display a different source than the default organism feedback.
 */
import * as THREE from 'three'
import type { ShapeContent } from '../types/scene'

interface VideoEntry {
  kind: 'video'
  src: string
  video: HTMLVideoElement
  texture: THREE.VideoTexture
}
interface ImageEntry {
  kind: 'image'
  src: string
  texture: THREE.Texture
}
interface WebcamEntry {
  kind: 'webcam'
  texture: THREE.VideoTexture | null   // bound to global tracking video
}

type Entry = VideoEntry | ImageEntry | WebcamEntry

const cache = new Map<string, Entry>()   // key = shapeId

function cacheKey(shapeId: string) { return shapeId }

function disposeEntry(e: Entry) {
  if (e.kind === 'video') {
    try { e.video.pause() } catch { /* ignore */ }
    e.video.removeAttribute('src')
    e.video.load()
    e.texture.dispose()
  } else if (e.kind === 'image') {
    e.texture.dispose()
  } else if (e.kind === 'webcam' && e.texture) {
    e.texture.dispose()
  }
}

function loadVideo(src: string): VideoEntry {
  const video = document.createElement('video')
  video.crossOrigin = 'anonymous'
  video.loop = true
  video.muted = true
  video.playsInline = true
  video.src = src
  video.play().catch(() => { /* user gesture may be required */ })
  const texture = new THREE.VideoTexture(video)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  return { kind: 'video', src, video, texture }
}

function loadImage(src: string): ImageEntry {
  const tex = new THREE.TextureLoader().load(src, () => {
    tex.needsUpdate = true
  })
  tex.colorSpace = THREE.SRGBColorSpace
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  return { kind: 'image', src, texture: tex }
}

function bindWebcam(): WebcamEntry {
  const cam = document.querySelector('video.mirror-bg') as HTMLVideoElement | null
  const source = cam ?? (document.querySelector('video') as HTMLVideoElement | null)
  if (!source) return { kind: 'webcam', texture: null }
  const texture = new THREE.VideoTexture(source)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  return { kind: 'webcam', texture }
}

/**
 * Returns the THREE.Texture for the given shape's content (or null = use default organism source).
 * Caches resources and disposes them when the content type/src changes.
 */
export function resolveShapeTexture(shapeId: string, content: ShapeContent | undefined): THREE.Texture | null {
  if (!content || content.type === 'organism') {
    // Free any prior entry for this shape
    const existing = cache.get(cacheKey(shapeId))
    if (existing) { disposeEntry(existing); cache.delete(cacheKey(shapeId)) }
    return null
  }
  const existing = cache.get(cacheKey(shapeId))
  // Re-use if same kind + src
  if (existing) {
    if (content.type === 'video' && existing.kind === 'video' && existing.src === content.src) return existing.texture
    if (content.type === 'image' && existing.kind === 'image' && existing.src === content.src) return existing.texture
    if (content.type === 'webcam' && existing.kind === 'webcam' && existing.texture) return existing.texture
    // Different kind or src → dispose & rebuild
    disposeEntry(existing)
    cache.delete(cacheKey(shapeId))
  }
  if (content.type === 'video' && content.src) {
    const e = loadVideo(content.src)
    cache.set(cacheKey(shapeId), e)
    return e.texture
  }
  if (content.type === 'image' && content.src) {
    const e = loadImage(content.src)
    cache.set(cacheKey(shapeId), e)
    return e.texture
  }
  if (content.type === 'webcam') {
    const e = bindWebcam()
    if (e.texture) cache.set(cacheKey(shapeId), e)
    return e.texture
  }
  return null
}

/** Cleanup entries for shapes that no longer exist. */
export function pruneShapeTextures(currentShapeIds: Set<string>) {
  for (const id of Array.from(cache.keys())) {
    if (!currentShapeIds.has(id)) {
      const e = cache.get(id)!
      disposeEntry(e)
      cache.delete(id)
    }
  }
}
