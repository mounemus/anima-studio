/**
 * Web Worker : evaluates the organic-parametric field off the main thread.
 * Marching cubes costs ~0.5 s at res 64 and ~3.4 s at res 128 — running it inline would
 * freeze the sculpt studio's render loop, so the params (plain JSON) are sent here and the
 * finished geometry's typed arrays are transferred back.
 */
/// <reference lib="webworker" />
import { buildOrganic, type OrganicParams } from './organic'
import { weld, laplacianSmooth } from '../morpho/mesh'

interface Req { id: number; params: OrganicParams; smooth: number }

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, params, smooth } = e.data
  try {
    let geo = buildOrganic(params)
    if (geo.getAttribute('position').count < 3) { (self as unknown as Worker).postMessage({ id, empty: true }); return }
    // Marching-cubes output is a raw triangle soup with flat normals — weld it so the
    // surface reads as the smooth grown form it is, not a faceted shell.
    geo = weld(geo)
    if (smooth > 0) geo = laplacianSmooth(geo, Math.min(4, Math.round(smooth)), 0.5)
    const pos = (geo.getAttribute('position').array as Float32Array).slice()
    const nAttr = geo.getAttribute('normal')
    const nrm = nAttr ? (nAttr.array as Float32Array).slice() : null
    const iAttr = geo.getIndex()
    const idx = iAttr ? new Uint32Array(iAttr.array as ArrayLike<number>) : null
    const transfer: Transferable[] = [pos.buffer]
    if (nrm) transfer.push(nrm.buffer)
    if (idx) transfer.push(idx.buffer)
    ;(self as unknown as Worker).postMessage({ id, position: pos, normal: nrm, index: idx, tris: (idx ? idx.length : pos.length / 3) / 3 }, transfer)
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String((err as Error)?.message ?? err) })
  }
}
