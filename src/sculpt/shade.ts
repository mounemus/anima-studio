/**
 * SHADING data for a generated form — what lets it read as glazed ceramic instead of a
 * uniformly tinted mesh.
 *
 * Two numbers per vertex, computed once in the worker :
 *   - h  : where the vertex sits relative to the bare body. +1 at the tip of the tallest
 *          relief, 0 on the body's skin, −1 deep inside the wall or a hollow. A glaze
 *          palette is mapped on it (relief colour / body colour / hollow colour), so the
 *          rosettes come out orange on a turquoise body without anyone painting them.
 *   - ao : ambient occlusion read straight from the distance field — step along the normal
 *          and see whether free space opens as fast as it should. Hollows, bores and the
 *          foot of each element get darker, which is most of what makes relief legible.
 *
 * The palette itself is applied on the main thread (paletteColors) : changing a colour
 * must not cost a regeneration.
 */
import * as THREE from 'three'
import type { Field } from '../morpho/marching'

const sat = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const AO_STEPS = [0.025, 0.06, 0.12, 0.2], AO_W = [0.4, 0.3, 0.2, 0.1]

/** → Float32Array [h, ao, h, ao, …] for every vertex of `geo` (which must have normals). */
export function shadeMesh(geo: THREE.BufferGeometry, field: Field, height: Field, shell: number): Float32Array {
  const pos = geo.getAttribute('position').array as ArrayLike<number>
  const nrm = geo.getAttribute('normal').array as ArrayLike<number>
  const V = pos.length / 3
  const out = new Float32Array(V * 2)
  let hMax = 0
  for (let i = 0; i < V; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2]
    let nx = nrm[i * 3], ny = nrm[i * 3 + 1], nz = nrm[i * 3 + 2]
    // Le sens des normales dépend de l'enroulement des triangles : on le lit sur le champ.
    if (field(x + nx * 0.02, y + ny * 0.02, z + nz * 0.02) < field(x - nx * 0.02, y - ny * 0.02, z - nz * 0.02)) { nx = -nx; ny = -ny; nz = -nz }
    let occ = 0
    for (let s = 0; s < AO_STEPS.length; s++) { const d = AO_STEPS[s]; occ += AO_W[s] * sat((d - field(x + nx * d, y + ny * d, z + nz * d)) / d) }
    const h = height(x, y, z)
    if (h > hMax) hMax = h
    out[i * 2] = h; out[i * 2 + 1] = 1 - sat(occ)
  }
  // Sans relief notable, rien ne doit prendre la couleur « relief » (le lissage et la
  // maille décalent la peau de quelques millièmes : ce n'est pas un ornement).
  const up = hMax > 0.015 ? hMax : Infinity, down = Math.max(2 * shell, 0.04)
  for (let i = 0; i < V; i++) { const h = out[i * 2]; out[i * 2] = h >= 0 ? sat(h / up) : -sat(-h / down) }
  return out
}

/** Glaze : hollow colour ← body colour → relief colour, darkened by occlusion.
 *  Colours are linear RGB triples ; the result is a `color` vertex attribute. */
export function paletteColors(shade: Float32Array, body: THREE.Color, relief: THREE.Color, hollow: THREE.Color): Float32Array {
  const V = shade.length / 2
  const col = new Float32Array(V * 3)
  for (let i = 0; i < V; i++) {
    const h = shade[i * 2], ao = 0.3 + 0.7 * shade[i * 2 + 1]
    const to = h >= 0 ? relief : hollow
    let t = h >= 0 ? sat((h - 0.12) / 0.6) : sat(-h * 1.15)
    t = t * t * (3 - 2 * t)
    col[i * 3] = (body.r + (to.r - body.r) * t) * ao
    col[i * 3 + 1] = (body.g + (to.g - body.g) * t) * ao
    col[i * 3 + 2] = (body.b + (to.b - body.b) * t) * ao
  }
  return col
}
