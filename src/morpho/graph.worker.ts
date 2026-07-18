/**
 * Web Worker : evaluates a MORPHOGENESIS graph off the main thread (HD marching cubes
 * never freezes the UI). The graph is plain JSON — closures are rebuilt here — so we
 * evaluate it, then transfer the geometry's typed arrays + fabrication stats back.
 */
/// <reference lib="webworker" />
import { evalGraph, type Graph, type Quality } from './graph'
import { analyze } from './mesh'

interface Req { id: number; kind: 'proxy' | 'hd'; graph: Graph; quality: Quality }

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, kind, graph, quality } = e.data
  try {
    const geo = evalGraph(graph, quality)
    if (!geo) { (self as unknown as Worker).postMessage({ id, kind, empty: true }); return }
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
