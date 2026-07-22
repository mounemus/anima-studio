/**
 * Web Worker : evaluates the organic-parametric field off the main thread.
 * Marching cubes costs ~0.5 s at res 64 and ~3.4 s at res 128 — running it inline would
 * freeze the sculpt studio's render loop, so the params (plain JSON) are sent here and the
 * finished geometry's typed arrays are transferred back.
 *
 * When `source` is present (a sculpted blob or an imported model) it is first BAKED into a
 * signed-distance grid, which then replaces the primitive body — so an arbitrary mesh gets
 * shelled / perforated / twisted by exactly the same pipeline. Baking is the expensive half,
 * so it owns the first 45 % of the reported progress.
 */
/// <reference lib="webworker" />
import * as THREE from 'three'
import { buildOrganic, type OrganicParams } from './organic'
import { meshToField } from './meshField'
import { finishMesh } from './finish'
import type { Field } from '../morpho/marching'

interface Req { id: number; params: OrganicParams; smooth: number; mainOnly?: boolean; source?: { pos: number[] | Float32Array; idx?: number[] | Uint32Array } | null }

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, params, smooth, source } = e.data
  const post = (self as unknown as Worker).postMessage.bind(self)
  let last = -1
  const report = (t: number) => { const pc = Math.round(t * 90); if (pc !== last) { last = pc; post({ id, progress: pc }) } }
  try {
    // ── Bake an arbitrary mesh into an SDF body, when one was supplied ──
    let body: Field | null = null
    const usesMesh = params.form === 'mesh'
    if (usesMesh && source?.pos?.length) {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(Float32Array.from(source.pos), 3))
      if (source.idx?.length) g.setIndex(new THREE.BufferAttribute(Uint32Array.from(source.idx), 1))
      body = meshToField(g, { grid: 56, onProgress: (t) => report(t * 0.45) })
    } else if (usesMesh) {
      post({ id, error: 'Aucune forme source — sculpte ou importe un objet d\'abord.' }); return
    }
    const base = usesMesh ? 0.45 : 0
    const raw = buildOrganic(params, (t) => report(base + t * (1 - base)), body)
    if (raw.getAttribute('position').count < 3) { post({ id, empty: true }); return }
    post({ id, progress: 94 })
    // Finition : soudure, retrait des débris flottants, fermeture, puis lissage.
    // « mainOnly » ne garde que la plus grosse pièce → un solide unique, imprimable.
    const { geo, stats } = finishMesh(raw, { smooth, minFrac: e.data.mainOnly ? 1 : 0.05 })
    const pos = (geo.getAttribute('position').array as Float32Array).slice()
    const nAttr = geo.getAttribute('normal')
    const nrm = nAttr ? (nAttr.array as Float32Array).slice() : null
    const iAttr = geo.getIndex()
    const idx = iAttr ? new Uint32Array(iAttr.array as ArrayLike<number>) : null
    const transfer: Transferable[] = [pos.buffer]
    if (nrm) transfer.push(nrm.buffer)
    if (idx) transfer.push(idx.buffer)
    post({ id, position: pos, normal: nrm, index: idx, tris: (idx ? idx.length : pos.length / 3) / 3, stats }, transfer)
  } catch (err) {
    post({ id, error: String((err as Error)?.message ?? err) })
  }
}
