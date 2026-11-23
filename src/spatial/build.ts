/**
 * Esquisse spatiale : objets paramétriques et leurs maillages.
 *
 * Tout ce qui est dessiné est gardé sous forme de points de contrôle (`Obj`), jamais de
 * maillage figé : on peut donc rééditer un point, annuler, sauvegarder en JSON, et
 * reconstruire la géométrie à tout moment avec `buildGeometry`.
 */
import * as THREE from 'three'

export type Kind = 'stroke' | 'revolve' | 'surface' | 'prim' | 'image'
export type Section = 'round' | 'ribbon' | 'square'
export type Prim = 'sphere' | 'box' | 'cylinder' | 'cone' | 'pyramid' | 'torus' | 'capsule' | 'plane'
export type Mat = 'matte' | 'gloss' | 'metal' | 'neon' | 'glass' | 'wire'
export type Sym = 'none' | 'mirror' | 'radial'
export type P3 = [number, number, number]

export interface Obj {
  id: string
  kind: Kind
  layer: string
  color: string
  mat: Mat
  /** Points de contrôle, dans le repère du monde dessiné (avant la pose `pos/quat/scale`). */
  pts: P3[]
  /** Surface : second bord. */
  pts2?: P3[]
  /** Ruban : normale de la paume à chaque point (oriente le plat du ruban). */
  nrm?: P3[]
  /** Rayon du trait / demi-largeur du ruban. */
  size: number
  section: Section
  taper: number
  prim?: Prim
  /** Révolution : axe (origine, direction), nombre de côtés, angle balayé en degrés. */
  axisO?: P3
  axisD?: P3
  sides?: number
  sweep?: number
  sym: Sym
  symN: number
  pos: P3
  quat: [number, number, number, number]
  scale: number
  /** Image de référence : URL de données, et rapport hauteur / largeur. */
  img?: string
  ratio?: number
}

const V = (p: P3) => new THREE.Vector3(p[0], p[1], p[2])
const clamp = (a: number, b: number, v: number) => Math.max(a, Math.min(b, v))

/** Douglas-Peucker en 3D : indices des points gardés (les extrémités le sont toujours). */
export function simplify(pts: P3[], eps: number): number[] {
  if (pts.length <= 2) return pts.map((_, i) => i)
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1
  const stack: [number, number][] = [[0, pts.length - 1]]
  const a = new THREE.Vector3(), b = new THREE.Vector3(), p = new THREE.Vector3(), line = new THREE.Line3(), c = new THREE.Vector3()
  while (stack.length) {
    const [i0, i1] = stack.pop()!
    a.fromArray(pts[i0]); b.fromArray(pts[i1]); line.set(a, b)
    // boucle fermée : les deux bouts sont confondus, il n'y a pas de droite ; la distance se prend au point
    // (sans cela elle vaut NaN, rien n'est gardé et la boucle se réduit à deux points confondus)
    const closed = a.distanceToSquared(b) < 1e-18
    let far = -1, dMax = eps
    for (let i = i0 + 1; i < i1; i++) {
      p.fromArray(pts[i]); if (!closed) line.closestPointToPoint(p, true, c)
      const d = p.distanceTo(closed ? a : c)
      if (d > dMax) { dMax = d; far = i }
    }
    if (far > 0) { keep[far] = 1; stack.push([i0, far], [far, i1]) }
  }
  const out: number[] = []
  keep.forEach((k, i) => { if (k) out.push(i) })
  return out
}

/** Adoucit un tracé à main levée : chaque point glisse vers la moyenne de ses voisins. Les
 *  extrémités ne bougent pas, une ligne droite reste droite. */
export function relax(pts: P3[], iterations: number): P3[] {
  let cur = pts
  for (let n = 0; n < iterations; n++) {
    const prev = cur
    cur = prev.map((p, i) => (i === 0 || i === prev.length - 1 ? p : [0, 1, 2].map((k) => (prev[i - 1][k] + 2 * p[k] + prev[i + 1][k]) / 4) as P3))
  }
  return cur
}

/** Décalages (u, v) du profil de section, en multiples du rayon. */
function sectionRing(section: Section): [number, number][] {
  if (section === 'square') return [[0.8, 0.8], [-0.8, 0.8], [-0.8, -0.8], [0.8, -0.8]]
  if (section === 'ribbon') return [[1, 0.1], [-1, 0.1], [-1, -0.1], [1, -0.1]]
  return Array.from({ length: 10 }, (_, j) => [Math.cos(j / 10 * Math.PI * 2), Math.sin(j / 10 * Math.PI * 2)] as [number, number])
}

/** Balaye une section le long de la courbe passant par `pts` : tube rond, barre carrée ou
 *  ruban plat, effilé aux bouts si `taper` > 0, fermé par deux fonds (maillage étanche). */
export function sweep(pts: P3[], r: number, section: Section = 'round', taper = 0, normals?: P3[]): THREE.BufferGeometry {
  if (pts.length < 2) {
    const s = new THREE.SphereGeometry(Math.max(1e-4, r), 14, 10)
    if (pts[0]) s.translate(pts[0][0], pts[0][1], pts[0][2])
    return s
  }
  const curve = new THREE.CatmullRomCurve3(pts.map(V), false, 'centripetal')
  const n = clamp(8, 360, pts.length * 3)
  const frames = curve.computeFrenetFrames(n, false)
  const ring = sectionRing(section), m = ring.length
  const pos: number[] = [], idx: number[] = []
  const P = new THREE.Vector3(), U = new THREE.Vector3(), W = new THREE.Vector3(), N = new THREE.Vector3()
  for (let i = 0; i <= n; i++) {
    const t = i / n
    curve.getPointAt(t, P)
    U.copy(frames.normals[i]); W.copy(frames.binormals[i])
    if (section === 'ribbon' && normals && normals.length === pts.length) {
      // le plat du ruban suit la paume : largeur = tangente × normale de la paume
      N.fromArray(normals[Math.round(t * (pts.length - 1))])
      U.crossVectors(frames.tangents[i], N)
      if (U.lengthSq() > 1e-6) { U.normalize(); W.crossVectors(U, frames.tangents[i]).normalize() } else U.copy(frames.normals[i])
    }
    const ri = r * (1 - taper + taper * Math.sin(Math.PI * t))
    for (const [cu, cv] of ring) pos.push(P.x + (U.x * cu + W.x * cv) * ri, P.y + (U.y * cu + W.y * cv) * ri, P.z + (U.z * cu + W.z * cv) * ri)
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
    const a = i * m + j, b = i * m + (j + 1) % m, c = a + m, d = b + m
    idx.push(a, c, b, b, c, d)
  }
  // fonds : un éventail autour du centre de chaque extrémité
  const c0 = pos.length / 3; curve.getPointAt(0, P); pos.push(P.x, P.y, P.z)
  const c1 = c0 + 1; curve.getPointAt(1, P); pos.push(P.x, P.y, P.z)
  for (let j = 0; j < m; j++) { idx.push(c0, j, (j + 1) % m); idx.push(c1, n * m + (j + 1) % m, n * m + j) }
  let g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx)
  if (section !== 'round') g = g.toNonIndexed()   // arêtes vives
  g.computeVertexNormals()
  return g
}

/** Tourne le profil `pts` autour de l'axe (origine `o`, direction `d`). */
export function revolve(pts: P3[], o: P3, d: P3, sides = 48, sweepDeg = 360): THREE.BufferGeometry | null {
  if (pts.length < 2) return null
  const O = V(o), D = V(d).normalize(), rel = new THREE.Vector3()
  const curve = new THREE.CatmullRomCurve3(pts.map(V), false, 'centripetal')
  const prof = curve.getPoints(clamp(8, 120, pts.length * 4)).map((p) => {
    rel.subVectors(p, O); const h = rel.dot(D)
    return new THREE.Vector2(rel.addScaledVector(D, -h).length(), h)
  })
  const g = new THREE.LatheGeometry(prof, clamp(3, 96, Math.round(sides)), 0, clamp(10, 360, sweepDeg) * Math.PI / 180)
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), D))
  g.translate(O.x, O.y, O.z)
  g.computeVertexNormals()
  return g
}

/** Surface tendue entre deux bords (règle droite d'un bord à l'autre). */
export function surface(a: P3[], b: P3[]): THREE.BufferGeometry | null {
  if (a.length < 2 || b.length < 2) return null
  const ca = new THREE.CatmullRomCurve3(a.map(V), false, 'centripetal'), cb = new THREE.CatmullRomCurve3(b.map(V), false, 'centripetal')
  const n = clamp(4, 200, Math.max(a.length, b.length) * 3)
  const pos: number[] = [], uv: number[] = [], idx: number[] = [], p = new THREE.Vector3()
  for (let i = 0; i <= n; i++) {
    ca.getPointAt(i / n, p); pos.push(p.x, p.y, p.z); uv.push(i / n, 0)
    cb.getPointAt(i / n, p); pos.push(p.x, p.y, p.z); uv.push(i / n, 1)
  }
  for (let i = 0; i < n; i++) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2) }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/** Volume simple posé en deux points : `a` = centre (coin pour boîte et plan), `b` = taille. */
export function primitive(kind: Prim, a: P3, b: P3): THREE.BufferGeometry {
  const A = V(a), v = V(b).sub(A), d = Math.max(v.length(), 1e-3)
  const rad = Math.max(Math.hypot(v.x, v.z), 0.2 * d), h = Math.max(2 * Math.abs(v.y), 0.4 * d)
  let g: THREE.BufferGeometry
  switch (kind) {
    case 'box': case 'plane': {
      const min = kind === 'plane' ? 0 : 0.05 * d
      const s = [Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)].map((x) => Math.max(x, min))
      if (kind === 'plane') s[s.indexOf(Math.min(...s))] = 0.01 * d   // la plus petite dimension devient l'épaisseur
      g = new THREE.BoxGeometry(s[0], s[1], s[2])
      return g.translate(A.x + v.x / 2, A.y + v.y / 2, A.z + v.z / 2)
    }
    case 'cylinder': g = new THREE.CylinderGeometry(rad, rad, h, 40); break
    case 'cone': g = new THREE.ConeGeometry(rad, h, 40); break
    case 'pyramid': g = new THREE.ConeGeometry(rad, h, 4); break
    case 'torus': g = new THREE.TorusGeometry(d, 0.28 * d, 16, 48); break
    case 'capsule': g = new THREE.CapsuleGeometry(rad, h, 8, 24); break
    default: g = new THREE.SphereGeometry(d, 32, 20)
  }
  return g.translate(A.x, A.y, A.z)
}

export function buildGeometry(o: Obj): THREE.BufferGeometry | null {
  switch (o.kind) {
    case 'stroke': return o.pts.length ? sweep(o.pts, o.size, o.section, o.taper, o.nrm) : null
    case 'revolve': return revolve(o.pts, o.axisO ?? [0, 0, 0], o.axisD ?? [0, 1, 0], o.sides, o.sweep)
    case 'surface': return o.pts2 ? surface(o.pts, o.pts2) : null
    case 'prim': return o.pts.length >= 2 ? primitive(o.prim ?? 'sphere', o.pts[0], o.pts[1]) : null
    case 'image': { const w = o.size * 2; return new THREE.PlaneGeometry(w, w * (o.ratio ?? 1)).translate(o.pts[0][0], o.pts[0][1], o.pts[0][2]) }
  }
}

/** Copies de symétrie, dans le repère du monde dessiné : miroir sur le plan X = 0, ou N
 *  répétitions autour de l'axe vertical. La première est toujours l'original. */
export function symMatrices(sym: Sym, n: number): THREE.Matrix4[] {
  if (sym === 'mirror') return [new THREE.Matrix4(), new THREE.Matrix4().makeScale(-1, 1, 1)]
  const count = clamp(2, 24, Math.round(n))
  if (sym === 'radial') return Array.from({ length: count }, (_, k) => new THREE.Matrix4().makeRotationY(k / count * Math.PI * 2))
  return [new THREE.Matrix4()]
}

export function objMatrix(o: Obj): THREE.Matrix4 {
  return new THREE.Matrix4().compose(V(o.pos), new THREE.Quaternion().fromArray(o.quat), new THREE.Vector3(o.scale, o.scale, o.scale))
}

export function makeMaterial(mat: Mat, color: string): THREE.Material {
  const c = new THREE.Color(color), side = THREE.DoubleSide
  switch (mat) {
    case 'gloss': return new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.18, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.1, side })
    case 'metal': return new THREE.MeshStandardMaterial({ color: c, roughness: 0.22, metalness: 1, side })
    case 'neon': return new THREE.MeshBasicMaterial({ color: c, side, toneMapped: false })
    case 'glass': return new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.08, metalness: 0, transparent: true, opacity: 0.38, depthWrite: false, side })
    case 'wire': return new THREE.MeshBasicMaterial({ color: c, wireframe: true })
    default: return new THREE.MeshStandardMaterial({ color: c, roughness: 0.75, metalness: 0, side })
  }
}

/** Tous les objets visibles, symétries et poses appliquées, prêts pour l'export (un
 *  maillage par copie ; l'ordre des triangles est rétabli pour les copies en miroir). */
export function bakeForExport(objs: Obj[]): THREE.Group {
  const root = new THREE.Group()
  for (const o of objs) {
    if (o.kind === 'image') continue
    const base = buildGeometry(o); if (!base) continue
    const own = objMatrix(o)
    for (const S of symMatrices(o.sym, o.symN)) {
      const m = S.clone().multiply(own), g = base.clone().applyMatrix4(m)
      if (m.determinant() < 0) {
        const ix = g.index ? g.index.array : null
        if (ix) for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t }
        else { const p = g.getAttribute('position').array as Float32Array; for (let i = 0; i < p.length; i += 9) for (let k = 0; k < 3; k++) { const t = p[i + 3 + k]; p[i + 3 + k] = p[i + 6 + k]; p[i + 6 + k] = t } }
        g.computeVertexNormals()
      }
      const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: o.color, roughness: o.mat === 'metal' ? 0.25 : 0.7, metalness: o.mat === 'metal' ? 1 : 0 }))
      mesh.name = `${o.kind}-${o.id}`
      root.add(mesh)
    }
    base.dispose()
  }
  return root
}
