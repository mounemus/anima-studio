import { describe, it, expect } from 'vitest'
import { devicePose, angleDiff, twoFinger, pressureScale } from './tablet'

const deg = (r: number) => r * 180 / Math.PI

describe('tablette : pose d\'après le gyroscope', () => {
  it('à plat = vue de dessus, debout = vue de face, écran vers le bas = vue de dessous', () => {
    expect(deg(devicePose(0, 0, 0).tilt)).toBeCloseTo(90)
    expect(deg(devicePose(0, 90, 0).tilt)).toBeCloseTo(0)
    expect(deg(devicePose(0, 45, 0).tilt)).toBeCloseTo(45)
    expect(deg(devicePose(0, 180, 0).tilt)).toBeCloseTo(-90)
  })
  it('en paysage aussi : debout = vue de face, quel que soit le côté où l\'on a tourné l\'appareil', () => {
    expect(deg(devicePose(0, 0, -90, 90).tilt)).toBeCloseTo(0)
    expect(deg(devicePose(0, 0, 90, 270).tilt)).toBeCloseTo(0)
    expect(deg(devicePose(0, 0, -45, 90).tilt)).toBeCloseTo(45)
  })
  it('se tourner fait tourner le cap d\'autant, à plat comme debout', () => {
    for (const beta of [0, 40, 90]) for (const turn of [10, 60, 170, -120]) {
      expect(deg(angleDiff(devicePose(30 + turn, beta, 0).heading, devicePose(30, beta, 0).heading))).toBeCloseTo(turn, 6)
    }
  })
  it('coucher ou redresser la tablette ne change pas le cap', () => {
    const upright = devicePose(75, 90, 0).heading
    for (const beta of [0, 20, 60, 89]) expect(deg(angleDiff(devicePose(75, beta, 0).heading, upright))).toBeCloseTo(0, 6)
    // en paysage, pencher vers l'avant ou l'arrière fait varier gamma, pas beta
    const land = devicePose(75, 0, -90, 90).heading
    for (const gamma of [-80, -45, -10]) expect(Math.abs(deg(angleDiff(devicePose(75, 0, gamma, 90).heading, land)))).toBeLessThan(1e-6)
  })
  it('écart d\'angles : toujours le plus court chemin', () => {
    expect(deg(angleDiff(Math.PI * 0.95, -Math.PI * 0.95))).toBeCloseTo(-18)
    expect(angleDiff(0.3, 0.1)).toBeCloseTo(0.2)
  })
})

describe('tablette : gestes à deux doigts et stylet', () => {
  it('glisser ensemble déplace, sans zoom ni rotation', () => {
    const g = twoFinger({ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 130, y: 80 }, { x: 230, y: 80 })
    expect(g.dx).toBe(30); expect(g.dy).toBe(-20); expect(g.scale).toBeCloseTo(1); expect(g.twist).toBeCloseTo(0)
  })
  it('écarter zoome autour du milieu, tourner donne l\'angle (sens des aiguilles = positif)', () => {
    const z = twoFinger({ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 50, y: 100 }, { x: 250, y: 100 })
    expect(z.scale).toBeCloseTo(2); expect(z.cx).toBe(150); expect(z.dx).toBe(0); expect(z.twist).toBeCloseTo(0)
    const t = twoFinger({ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 150, y: 50 }, { x: 150, y: 150 })   // quart de tour, y vers le bas
    expect(deg(t.twist)).toBeCloseTo(90); expect(t.scale).toBeCloseTo(1)
    expect(twoFinger({ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 9, y: 9 }, { x: 9, y: 9 }).scale).toBe(1)        // doigts confondus : rien d'absurde
  })
  it('pression du stylet : léger = plus fin, appuyé = plus épais, sans capteur = inchangé', () => {
    expect(pressureScale(0.5)).toBeCloseTo(1); expect(pressureScale(0.1)).toBeLessThan(0.7); expect(pressureScale(1)).toBeGreaterThan(1.4)
    expect(pressureScale(7)).toBe(pressureScale(1))
  })
})
