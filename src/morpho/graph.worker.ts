/**
 * Web Worker : evaluates a MORPHOGENESIS graph off the main thread (HD marching cubes
 * never freezes the UI). The graph is plain JSON — closures are rebuilt here — so we
 * evaluate it, then transfer the geometry's typed arrays + fabrication stats back.
 */
/// <reference lib="webworker" />
import { evalGraph, type Graph, type Quality } from './graph'
import { analyze, weld } from './mesh'

interface Req { id: number; kind: 'proxy' | 'hd'; graph: Graph; quality: Quality }

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, kind, graph, quality } = e.data
  try {
    let geo = evalGraph(graph, quality)
    if (!geo) { (self as unknown as Worker).postMessage({ id, kind, empty: true }); return }
    // Weld non-indexed marching-cubes output → shared verts + smooth normals (raw
    // flat-normal output looks faceted/"fragmented"). weld() is bulletproof: it
    // returns the original geometry on any failure, so it can never blank the mesh.
    if (!geo.getIndex()) geo = weld(geo)
    const pos = (geo.getAttribute('position').array as Float32Array).slice()
    const nrmAttr = geo.getAttribute('normal')
    const nrm = nrmAttr ? (nrmAttr.array as Float32Array).slice() : null
    const idxAttr = geo.getIndex()
    const idx = idxAttr ? new Uint32Array(idxAttr.array as ArrayLike<number>) : null
    const stats = analyze(geo)
    const transfer: Transferable[] = [pos.buffer]
    if (nrm) transfer.push(nrm.buffer)
    if (idx) transfer.push(idx.buffer)
    ;(self as unknown as Worker).postMessage({ id, kind, position: pos, normal: nrm, index: idx, stats }, transfer)
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, kind, error: String((err as Error)?.message ?? err) })
  }
}
