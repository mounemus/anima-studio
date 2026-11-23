/**
 * Esquisse spatiale sur tablette ou téléphone : ce qui se calcule sans écran.
 *
 * La tablette est le plan de dessin. Son gyroscope dit comment elle est tenue : à plat, on dessine sur le sol vu
 * de dessus ; debout, sur le plan de face ; et se tourner avec elle fait tourner autour du dessin.
 */

/** Écart signé le plus court entre deux angles, en radians (−π..π). */
export const angleDiff = (a: number, b: number) => { let d = (a - b) % (2 * Math.PI); if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; return d }

/** Pose de l'appareil d'après `deviceorientation` (alpha, beta, gamma en degrés) et l'angle de l'écran
 *  (`screen.orientation.angle` : 0 en portrait, 90 ou 270 en paysage).
 *  - `tilt` : inclinaison de l'écran, 0 quand il est debout face à soi, π/2 quand il est posé à plat écran vers le haut.
 *  - `heading` : cap du bord droit de l'écran autour de la verticale (radians, sens inverse des aiguilles vu de dessus).
 *    Ce bord reste horizontal quand on penche l'appareil vers l'avant ou l'arrière, en portrait comme en paysage :
 *    le cap ne bouge donc pas quand on ne fait que coucher ou redresser la tablette. */
export function devicePose(alpha: number, beta: number, gamma: number, screenAngle = 0): { heading: number; tilt: number } {
  const D = Math.PI / 180, a = alpha * D, b = beta * D, g = gamma * D, s = screenAngle * D
  const cz = Math.cos(a), sz = Math.sin(a), cx = Math.cos(b), sx = Math.sin(b), cy = Math.cos(g), sy = Math.sin(g)
  // matrice de rotation de l'appareil (convention du W3C : Z, puis X, puis Y) ; colonnes = ses axes x, y, z dans le monde
  const xAxis = [cz * cy - sz * sx * sy, cy * sz + cz * sx * sy, -cx * sy], yAxis = [-cx * sz, cz * cx, sx]
  const normalZ = cx * cy                                   // composante verticale de la normale à l'écran
  const right = [Math.cos(s) * xAxis[0] - Math.sin(s) * yAxis[0], Math.cos(s) * xAxis[1] - Math.sin(s) * yAxis[1]]   // bord droit de l'écran tel qu'on le regarde
  return { heading: Math.atan2(right[1], right[0]), tilt: Math.asin(Math.max(-1, Math.min(1, normalZ))) }
}

export interface Pt { x: number; y: number }
/** Geste à deux doigts entre deux instants : ce dont ils ont glissé ensemble (dx, dy), de combien ils se sont écartés
 *  (`scale`), de combien ils ont tourné (`twist`, radians, positif dans le sens des aiguilles à l'écran), et leur milieu. */
export function twoFinger(a0: Pt, b0: Pt, a1: Pt, b1: Pt): { dx: number; dy: number; scale: number; twist: number; cx: number; cy: number } {
  const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y), d1 = Math.hypot(b1.x - a1.x, b1.y - a1.y)
  const cx = (a1.x + b1.x) / 2, cy = (a1.y + b1.y) / 2
  return { dx: cx - (a0.x + b0.x) / 2, dy: cy - (a0.y + b0.y) / 2, scale: d0 > 1 && d1 > 1 ? d1 / d0 : 1,
    twist: d0 > 1 && d1 > 1 ? angleDiff(Math.atan2(b1.y - a1.y, b1.x - a1.x), Math.atan2(b0.y - a0.y, b0.x - a0.x)) : 0, cx, cy }
}

/** Épaisseur du trait selon la pression moyenne du stylet (0..1) : léger = plus fin, appuyé = plus épais.
 *  Un stylet sans capteur de pression annonce 0,5 : le trait garde alors l'épaisseur réglée. */
export const pressureScale = (mean: number) => 0.55 + 0.9 * Math.max(0, Math.min(1, mean))
