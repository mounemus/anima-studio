import { describe, it, expect } from 'vitest'
import { migrateScene, importSceneJSON } from './persistence'

describe('persistence — migrateScene (load + import hardening)', () => {
  it('deep-merges a partial palette instead of wiping the missing channels', () => {
    const m = migrateScene({
      id: 't', organism: { kind: 'boids', values: { count: 100 } },
      visual: { palette: { primary: '#ff0000' } },   // only one channel present
    })
    expect(m.visual.palette.primary).toBe('#ff0000')   // preserved
    expect(m.visual.palette.bg).toBeTruthy()           // backfilled
    expect(m.visual.palette.secondary).toBeTruthy()
    expect(m.visual.palette.glow).toBeTruthy()
  })

  it('backfills every required top-level field for an old/partial scene', () => {
    const m = migrateScene({ id: 'x', organism: { kind: 'cells', values: { count: 50 } } })
    expect(m.mapping).toBeTruthy()
    expect(Array.isArray(m.obstacles)).toBe(true)
    expect(m.flow).toBeTruthy()
    expect(m.visual.palette.bg).toBeTruthy()
    expect(m.evolution).toBeTruthy()
    expect(m.senses).toBeTruthy()
  })

  it('coerces a non-array obstacles field to an empty array', () => {
    const m = migrateScene({ id: 'x', organism: { kind: 'boids', values: {} }, obstacles: 'oops' as any })
    expect(Array.isArray(m.obstacles)).toBe(true)
    expect(m.obstacles).toHaveLength(0)
  })
})

describe('persistence — importSceneJSON', () => {
  it('imports a partial scene without crashing and returns a complete palette', async () => {
    const partial = JSON.stringify({ id: 'imp', organism: { kind: 'boids', values: { count: 10 } }, visual: { palette: { glow: '#abcdef' } } })
    const file = new File([partial], 'scene.json', { type: 'application/json' })
    const scene = await importSceneJSON(file)
    expect(scene.visual.palette.glow).toBe('#abcdef')
    expect(scene.visual.palette.bg).toBeTruthy()
    expect(scene.mapping).toBeTruthy()
  })

  it('rejects a JSON file missing id/organism', async () => {
    const bad = new File(['{"foo":1}'], 'x.json', { type: 'application/json' })
    await expect(importSceneJSON(bad)).rejects.toThrow()
  })

  it('strips blob: shape sources on import (no dead references)', async () => {
    const withBlob = JSON.stringify({
      id: 'b', organism: { kind: 'boids', values: {} },
      mapping: { shapes: [{ id: 's1', content: { src: 'blob:http://x/123', type: 'image' } }] },
    })
    const file = new File([withBlob], 'b.json', { type: 'application/json' })
    const scene = await importSceneJSON(file)
    const shape = scene.mapping?.shapes?.[0] as any
    expect(shape?.content?.src).toBeUndefined()
  })
})
