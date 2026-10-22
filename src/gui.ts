import * as THREE from 'three/webgpu'
import { Inspector } from 'three/addons/inspector/Inspector.js'
import type { VolumeParticles } from './particles'
import type { FluidSim } from './fluid'

// three.js Inspector (performance / memory / timeline tabs) plus a Parameters
// tab wired straight into the simulation and shading uniforms.

interface Tweakables {
  particles: VolumeParticles
  fluid: FluidSim
  bloom: { strength: { value: number }; radius: { value: number }; threshold: { value: number } }
  onShapeChange: (index: number) => void
}

type Group = ReturnType<Inspector['createParameters']>

export function setupInspector(renderer: THREE.WebGPURenderer, t: Tweakables) {
  const inspector = new Inspector()
  renderer.inspector = inspector

  const k = t.particles.settings
  const vec3 = (group: Group, label: string, v: THREE.Vector3) => {
    group.add(v, 'x', -1, 1, 0.01).name(`${label} x`)
    group.add(v, 'y', -1, 1, 0.01).name(`${label} y`)
    group.add(v, 'z', -1, 1, 0.01).name(`${label} z`)
  }

  // --- shape
  const shape = inspector.createParameters('Shape')
  const shapeState = {
    get shape() { return t.particles.shapeIndex },
    set shape(v: number) { t.onShapeChange(Number(v)) },
    get volumeScale() { return t.particles.volumeScale },
    set volumeScale(v: number) { t.particles.volumeScale = v },
    get flow() { return t.particles.flow },
    set flow(v: number) { t.particles.flow = v },
  }
  const shapeOptions = Object.fromEntries(t.particles.shapeNames.map((name, i) => [name, i]))
  shape.add(shapeState, 'shape', shapeOptions)
  shape.add(shapeState, 'volumeScale', 0.8, 1.6, 0.01).name('scale (smaller = bigger)')
  shape.add(k, 'rotationSpeed', -2, 2, 0.01).name('rotation speed')
  shape.add(shapeState, 'flow', 0, 1, 0.01).name('flow (0 = rigid spin)')

  // --- particle look
  const look = inspector.createParameters('Particle look')
  look.add(k.size, 'value', 0.001, 0.008, 0.0001).name('size')
  look.addColor(k.colorDark, 'value').name('dark')
  look.addColor(k.colorLight, 'value').name('light')
  look.addColor(k.colorFast, 'value').name('fast')
  look.add(k.brightness, 'value', 0.5, 2, 0.01).name('brightness')
  look.add(k.contrast, 'value', 0.3, 3, 0.01).name('contrast')
  look.add(k.wrap, 'value', 0, 1, 0.01).name('wrap light')
  look.add(k.insideShadow, 'value', 0, 1, 0.01).name('inside shadow')
  const light = look.addFolder('Lights')
  vec3(light, 'shape light', k.lightDir.value)
  vec3(light, 'sphere light', k.impostorLight.value)
  const fast = look.addFolder('Fast particles')
  fast.add(k.fastMin, 'value', 0, 0.02, 0.0001).name('highlight from')
  fast.add(k.fastMax, 'value', 0, 0.02, 0.0001).name('highlight to')
  fast.add(k.blurMin, 'value', 0, 0.02, 0.0001).name('fade from')
  fast.add(k.blurMax, 'value', 0, 0.02, 0.0001).name('fade to')

  // --- motion
  const motion = inspector.createParameters('Noise & forces')
  motion.add(k.noiseForce, 'value', 0, 0.002, 0.00001).name('noise force')
  motion.add(k.noiseScale, 'value', 0.5, 30, 0.1).name('noise scale')
  motion.add(k.noiseSpeed, 'value', 0, 5, 0.01).name('noise speed')
  motion.add(k.burstNoise, 'value', 0, 0.004, 0.00001).name('switch burst')
  motion.add(k.surfaceForce, 'value', 0, 0.006, 0.00001).name('surface pull')
  motion.add(k.springForce, 'value', 0, 0.005, 0.00001).name('home spring')
  motion.add(k.shellOffset, 'value', -0.05, 0.05, 0.001).name('shell offset')
  motion.add(k.friction, 'value', 0.5, 0.99, 0.001).name('friction')
  motion.add(k.variation, 'value', 0, 1, 0.01).name('per-particle variation')

  // --- mouse
  const mouse = inspector.createParameters('Mouse fluid')
  mouse.add(k.interactForce, 'value', 0, 3, 0.01).name('interaction')
  mouse.add(k.fluidPush, 'value', 0, 0.003, 0.00001).name('push')
  mouse.add(k.fluidRelax, 'value', 0, 2, 0.01).name('release shape')
  mouse.add(t.fluid.options.splatRadius, 'value', 0.02, 0.6, 0.01).name('splat radius')
  mouse.add(t.fluid.options, 'splatForce', 0, 150, 1).name('splat force')
  mouse.add(t.fluid.options, 'velocityDissipation', 0.8, 1, 0.001).name('velocity decay')

  // --- scene
  const scene = inspector.createParameters('Scene')
  scene.add(t.bloom.strength, 'value', 0, 2, 0.01).name('bloom strength')
  scene.add(t.bloom.radius, 'value', 0, 1, 0.01).name('bloom radius')
  scene.add(t.bloom.threshold, 'value', 0, 1.5, 0.01).name('bloom threshold')

  // --- export
  const actions = inspector.createParameters('Export')
  actions.add({ copy: () => copySettings(t) }, 'copy').name('copy settings JSON')

  return inspector
}

function copySettings(t: Tweakables) {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(t.particles.settings)) {
    const v = typeof value === 'number' ? value : value.value
    out[key] = v instanceof THREE.Color ? `#${v.getHexString()}` : v instanceof THREE.Vector3 ? v.toArray() : v
  }
  out.volumeScale = t.particles.volumeScale
  out.fluid = { ...t.fluid.options, splatRadius: t.fluid.options.splatRadius.value }
  out.bloom = { strength: t.bloom.strength.value, radius: t.bloom.radius.value, threshold: t.bloom.threshold.value }
  const json = JSON.stringify(out, null, 2)
  navigator.clipboard?.writeText(json).catch(() => {})
  console.log(json)
}
