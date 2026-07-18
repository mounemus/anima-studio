/**
 * File imports for MORPHOGENESIS STUDIO — STL / OBJ (meshes) and SVG (extruded contours).
 * Parsed on the main thread into a compact {pos, idx} payload embedded in a `meshimport`
 * node's `data` (so it travels to the worker with the graph JSON). Large meshes are
 * auto-decimated + fitted to the unit box.
 */
import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { fitUnit } from './parametric'
import { decimate } from './mesh'

export interface MeshData { pos: number[]; idx?: number[] }

export function geomToData(g: THREE.BufferGeometry): MeshData {
  const pos = Array.from(g.getAttribute('position').array as Float32Array)
  const index = g.getIndex()
  return { pos, idx: index ? Array.from(index.array as ArrayLike<number>) : undefined }
}
export function dataToGeom(d: MeshData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(d.pos, 3)); if (d.idx) g.setIndex(d.idx); g.computeVertexNormals(); return g
}

function collect(obj: THREE.Object3D): THREE.BufferGeometry {
  const geos: THREE.BufferGeometry[] = []
  obj.updateMatrixWorld(true)
  obj.traverse((c) => { const m = c as THREE.Mesh; if (m.isMesh && m.geometry) { const g = m.geometry.clone(); g.applyMatrix4(m.matrixWorld); for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k); if (g.getIndex()) g.setIndex(null); geos.push(g) } })
  if (!geos.length) throw new Error('Aucun maillage trouvé')
  return geos.length === 1 ? geos[0] : (mergeGeometries(geos, false) ?? geos[0])
}

function svgToGeom(text: string): THREE.BufferGeometry {
  const data = new SVGLoader().parse(text)
  const geos: THREE.BufferGeometry[] = []
  for (const path of data.paths) for (const shape of SVGLoader.createShapes(path)) { const g = new THREE.ExtrudeGeometry(shape, { depth: 30, bevelEnabled: true, bevelThickness: 4, bevelSize: 3, bevelSegments: 2 }); geos.push(g.toNonIndexed()) }
  if (!geos.length) throw new Error('Aucun contour dans le SVG')
  const merged = geos.length === 1 ? geos[0] : (mergeGeometries(geos, false) ?? geos[0])
  merged.scale(1, -1, 1)   // SVG Y is downward
  return merged
}

export async function importFile(file: File): Promise<{ data: MeshData; name: string; tris: number }> {
  const ext = (file.name.split('.').pop() ?? '').toLowerCase()
  let geo: THREE.BufferGeometry
  if (ext === 'stl') geo = new STLLoader().parse(await file.arrayBuffer())
  else if (ext === 'obj') geo = collect(new OBJLoader().parse(await file.text()))
  else if (ext === 'svg') geo = svgToGeom(await file.text())
  else throw new Error(`Format .${ext} non supporté (STL, OBJ, SVG)`)
  geo = fitUnit(geo, 1.7)
  const triCount = () => (geo.getIndex() ? geo.getIndex()!.count : geo.getAttribute('position').count) / 3
  if (triCount() > 30000) geo = decimate(geo, 100)
  return { data: geomToData(geo), name: file.name, tris: Math.round(triCount()) }
}
