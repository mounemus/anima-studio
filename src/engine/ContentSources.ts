/**
 * Per-shape content sources for the mapping pass.
 * Manages the lifecycle of video / image / webcam textures so each mapped zone can
 * display a different source than the default organism feedback.
 */
import * as THREE from 'three'
import type { ShapeContent } from '../types/scene'
import { getMaskedWebcamTexture } from './MaskedWebcam'

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

function bindWebcam(useMaskedBody: boolean): WebcamEntry {
  if (useMaskedBody) {
    const masked = getMaskedWebcamTexture()
    return { kind: 'webcam', texture: masked as unknown as THREE.VideoTexture | null }
  }
  const cam = document.querySelector('video.mirror-bg') as HTMLVideoElement | null
  const source = cam ?? (document.querySelector('video') as HTMLVideoElement | null)
  // CRITICAL: only bind a VideoTexture if the video has a live MediaStream.
  // Otherwise the texture is just black (no pixels are ever painted into it) and
  // the zone shows pure black instead of falling back to the main organism source.
  if (!source || !source.srcObject) return { kind: 'webcam', texture: null }
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
/** Global flag — when true, all 'webcam' content uses the masked body texture instead of raw video. */
let useMaskedBody = false
export function setUseMaskedBody(v: boolean) { useMaskedBody = v }

/** Shared raw-webcam VideoTexture for chroma-key (sampled in the mapping shader).
 *  Rebinds automatically when the underlying <video> / MediaStream changes. Returns
 *  null when no camera stream is live. */
let chromaTex: THREE.VideoTexture | null = null
let chromaVideo: HTMLVideoElement | null = null
export function getWebcamTexture(): THREE.VideoTexture | null {
  const cam = (document.querySelector('video.mirror-bg') as HTMLVideoElement | null)
    ?? (document.querySelector('video') as HTMLVideoElement | null)
  if (!cam || !cam.srcObject) { chromaTex = null; chromaVideo = null; return null }
  if (chromaVideo !== cam || !chromaTex) {
    chromaVideo = cam
    chromaTex = new THREE.VideoTexture(cam)
    chromaTex.colorSpace = THREE.SRGBColorSpace
    chromaTex.minFilter = THREE.LinearFilter
    chromaTex.magFilter = THREE.LinearFilter
  }
  return chromaTex
}

export function resolveShapeTexture(shapeId: string, content: ShapeContent | undefined): THREE.Texture | null {
  if (!content || content.type === 'organism') {
    const existing = cache.get(cacheKey(shapeId))
    if (existing) { disposeEntry(existing); cache.delete(cacheKey(shapeId)) }
    return null
  }
  const existing = cache.get(cacheKey(shapeId))
  if (existing) {
    if (content.type === 'video' && existing.kind === 'video' && existing.src === content.src) return existing.texture
    if (content.type === 'image' && existing.kind === 'image' && existing.src === content.src) return existing.texture
    if (content.type === 'webcam' && existing.kind === 'webcam' && existing.texture) {
      // For webcam, check whether the underlying <video> changed (mask flag toggled,
      // new MediaStream attached, etc.) WITHOUT creating a throw-away VideoTexture
      // — that was a use-after-dispose bug. Compare the source DOM element instead.
      const cam = document.querySelector('video.mirror-bg') as HTMLVideoElement | null
      const wantedSource = useMaskedBody ? null : (cam ?? (document.querySelector('video') as HTMLVideoElement | null))
      const existingSrc = (existing.texture as any).image as HTMLVideoElement | undefined
      // useMaskedBody = true uses a shared CanvasTexture; we leave it bound until the flag flips
      if (!useMaskedBody && existingSrc === wantedSource && wantedSource?.srcObject) {
        return existing.texture
      }
      disposeEntry(existing); cache.delete(cacheKey(shapeId))
    } else {
      disposeEntry(existing); cache.delete(cacheKey(shapeId))
    }
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
    const e = bindWebcam(useMaskedBody)
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

/** Force-invalidate all cached webcam entries so they re-bind on the next resolve.
 *  Call this when the camera goes on/off so zones pick up the new MediaStream. */
export function invalidateWebcamCache() {
  for (const [id, e] of Array.from(cache.entries())) {
    if (e.kind === 'webcam') {
      disposeEntry(e)
      cache.delete(id)
    }
  }
}

/** Dispose every cached entry. Call from Engine.destroy() to release GPU memory
 *  cleanly during HMR / component unmount. Otherwise this module-level cache
 *  outlives Engine instances and leaks one VideoTexture per zone per reload. */
export function disposeAllContentSources() {
  for (const e of cache.values()) disposeEntry(e)
  cache.clear()
}
