import { describe, it, expect } from 'vitest'
import { createOrganism, ORGANISM_DEFAULTS } from '../OrganismFactory'
import type { OrganismKind, VisualParams } from '../../types/scene'
import { senseBus, sanitizeSenses } from '../../senses/SenseBus'
import * as THREE from 'three'

/**
 * Cross-organism robustness harness.
 *
 * Constructs EVERY organism with its defaults, then hammers it with degenerate
 * inputs (extreme params, dt spikes, NaN/None senses) for hundreds of frames and
 * asserts it never (a) throws, nor (b) produces NaN/Infinity in its exposed
 * position/velocity buffers or instance matrices.
 *
 * GPU organisms early-return in update() without a renderer (none in jsdom), so
 * this exercises the CPU-side math — exactly where NaN corruption happens.
 */

const VISUAL: VisualParams = {
  palette: { bg: '#06070d', primary: '#00ffa3', secondary: '#00d4ff', glow: '#7c3aed' },
  bloom: 0.5, feedback: 0.92, blendMode: 'add', texture: null,
}

const KINDS: OrganismKind[] = [
  'boids', 'particles', 'tendrils', 'cells', 'worms', 'spores', 'psychedelic',
  'mandala', 'fractal', 'mathcurve', 'reactiondiffusion', 'cellularautomata',
  'hilbert', 'menger', 'supershape3d', 'swarm3d', 'crystal', 'murmuration', 'instrument',
]

function bufferFinite(o: any): { ok: boolean; where: string } {
  const check = (arr: ArrayLike<number> | undefined, name: string, stride = 1, maxN = 20000) => {
    if (!arr) return true
    const n = Math.min(arr.length, maxN * stride)
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(arr[i])) { bad = name + '[' + i + ']'; return false }
    }
    return true
  }
  let bad = ''
  if (!check(o.positions, 'positions')) return { ok: false, where: bad }
  if (!check(o.velocities, 'velocities')) return { ok: false, where: bad }
  const geom = o.mesh?.geometry
  const posAttr = geom?.attributes?.position?.array as Float32Array | undefined
  if (!check(posAttr, 'geometry.position')) return { ok: false, where: bad }
  // InstancedMesh matrices
  const im = o.mesh?.instanceMatrix?.array as Float32Array | undefined
  if (!check(im, 'instanceMatrix')) return { ok: false, where: bad }
  return { ok: true, where: '' }
}

function setSenses(mode: 'normal' | 'nan' | 'extreme') {
  const h = senseBus.hands
  const a = senseBus.audio
  if (mode === 'normal') {
    h.detected = false; a.bass = 0; a.mid = 0; a.high = 0; a.level = 0
  } else if (mode === 'nan') {
    // A sensor feeding NaN must NOT be able to poison the organism.
    h.detected = true; h.indexTip.x = NaN; h.indexTip.y = NaN; h.pinch = NaN
    a.bass = NaN; a.mid = NaN; a.high = NaN
  } else {
    h.detected = true; h.indexTip.x = 5; h.indexTip.y = -5; h.pinch = 10
    a.bass = 10; a.mid = 10; a.high = 10
  }
}

describe('All organisms — robustness (no NaN, no throw under stress)', () => {
  for (const kind of KINDS) {
    it(`${kind}: survives extreme params + dt spikes + degenerate senses`, () => {
      const base = { ...(ORGANISM_DEFAULTS[kind] as any) }
      let o: any
      expect(() => { o = createOrganism(kind, base, VISUAL) }, `${kind} construct`).not.toThrow()
      o.setAspect(16 / 9)

      const run = (frames: number, dt: number, sense: 'normal' | 'nan' | 'extreme') => {
        setSenses(sense)
        for (let f = 0; f < frames; f++) {
          // Mirror the Engine loop: senses are sanitized every frame before
          // any organism reads them. Re-apply the raw (possibly-NaN) senses
          // each iteration so we test that the pipeline guard truly protects.
          setSenses(sense)
          sanitizeSenses()
          expect(() => o.update(dt), `${kind} update`).not.toThrow()
        }
        setSenses('normal')
        const r = bufferFinite(o)
        expect(r.ok, `${kind} produced non-finite at ${r.where} (sense=${sense}, dt=${dt})`).toBe(true)
      }

      run(120, 1 / 60, 'normal')
      run(60, 0.25, 'extreme')     // big dt spikes + extreme senses
      run(60, 1 / 60, 'nan')       // NaN sensors must not poison state

      // Extreme parameter values must not break it either
      const extreme = { ...base }
      for (const k in extreme) {
        if (typeof extreme[k] === 'number' && k !== 'count' && k !== 'resolution' && k !== 'gpu') {
          extreme[k] = k === 'vision' ? 0 : extreme[k] * 50
        }
      }
      expect(() => o.updateParams(extreme), `${kind} updateParams extreme`).not.toThrow()
      run(60, 1 / 60, 'normal')

      o.dispose?.()
    })
  }
})
