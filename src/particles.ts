import * as THREE from 'three/webgpu'
import {
  Discard, Fn, If, clamp, cos, dot, float, instanceIndex, instancedArray, length, max, min, mix, normalize,
  pow, remapClamp, sign, sin, smoothstep, sqrt, texture3D, uniform, uv, vec3, vec4,
} from 'three/tsl'
import { bitangentNoise4D } from './noise'
import type { FluidSim } from './fluid'

// Volume particles – a WebGPU port of the igloo.inc "links" section.
//
// Every particle lives in a small cylinder and is steered by:
//   • a baked SDF volume of the current shape (outside → pulled onto the surface),
//   • a weak spring back to its random "home" position (fills the inside),
//   • 4D bitangent curl noise (the constant shimmer),
//   • the screen-space fluid velocity under it (mouse interaction).
// The SDF is sampled through a slowly spinning rotation, so the cloud keeps
// flowing around the shape instead of settling. Velocities are per-frame at
// 60fps and scaled by dtRatio, exactly like the original.

// TSL's generic node typings are too strict for small graph helpers
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNode = any

export const VOLUME_RES = 64

export interface ParticleShape {
  name: string
  volume: Uint8Array // VOLUME_RES³ RGBA8, see scripts/bake-sdf.mjs
  scale: number
}

const CUBE_SIZE = 0.65

/** Tweakable values. Defaults in comments are the original igloo.inc constants. */
export function createParticleSettings() {
  return {
    // look
    size: uniform(0.0038),
    colorDark: uniform(new THREE.Color('#353d50')),
    colorLight: uniform(new THREE.Color('#d4dbe7')),
    colorFast: uniform(new THREE.Color('#e8f4ff')),
    colorInitial: uniform(new THREE.Color('#b5d5ff')),
    contrast: uniform(1.25), // ramp exponent
    brightness: uniform(1),
    insideShadow: uniform(0.2), // 0.2
    wrap: uniform(0.25), // 0.25
    // light used for the per-particle SDF shading (world space), original (-0.75, 1, -0.1)
    lightDir: uniform(new THREE.Vector3(-0.6, 0.9, 0.75)),
    // light used for the sphere impostor (view space), original (0.75, 1, 0.1)
    impostorLight: uniform(new THREE.Vector3(-0.35, 1, 0.45)),
    fastMin: uniform(0.003), // 0.003
    fastMax: uniform(0.005), // 0.005
    blurMin: uniform(0.002), // 0.002
    blurMax: uniform(0.007), // 0.007

    // motion
    noiseForce: uniform(0.0002), // 0.0002
    noiseScale: uniform(7), // 7
    noiseSpeed: uniform(1), // 1
    burstNoise: uniform(0.0004), // 0.0004 extra while switching shape
    surfaceForce: uniform(0.0015), // 0.0015
    springForce: uniform(0.001), // 0.001
    friction: uniform(0.9), // 0.9
    shellOffset: uniform(0), // 0 – shift the target surface in/out (volume units)
    fluidPush: uniform(0.0005), // 0.0005
    fluidRelax: uniform(0.65), // 0.65 – how much the fluid weakens the shape forces
    interactForce: uniform(1),
    // Per-particle randomness of noise speed/force and surface pull. The original reads a
    // `rand` attribute its fullscreen sim pass never provides, so WebGL hands every particle
    // the default (0, 0, 0, 1): one coherent flow field. 0 = original, 1 = fully random.
    variation: uniform(0),
    rotationSpeed: 0.75, // rad/s, JS-side
  }
}

export type ParticleSettings = ReturnType<typeof createParticleSettings>

export class VolumeParticles {
  readonly object: THREE.Sprite
  readonly count: number
  readonly settings = createParticleSettings()

  private readonly simulate
  private readonly uniforms = {
    time: uniform(0),
    dtRatio: uniform(1),
    rotation: uniform(0),
    shapeIndex: uniform(0),
    volumeScale: uniform(1),
    additionalNoise: uniform(0),
    modelMatrix: uniform(new THREE.Matrix4()),
    viewMatrix: uniform(new THREE.Matrix4()),
    projMatrix: uniform(new THREE.Matrix4()),
    camRight: uniform(new THREE.Vector3(1, 0, 0)),
    camUp: uniform(new THREE.Vector3(0, 1, 0)),
  }
  private readonly reveal = uniform(0)
  private revealStart = -1

  private noiseTween = { from: 0, start: -1, duration: 0.5 }
  private shapes: ParticleShape[]
  private current = 0

  constructor(shapes: ParticleShape[], fluid: FluidSim, count = 150_000) {
    this.shapes = shapes
    this.count = count
    const u = this.uniforms
    const k = this.settings

    // --- buffers ------------------------------------------------------------
    const initial = new Float32Array(count * 4)
    const random = new Float32Array(count * 4)
    for (let i = 0; i < count; i++) {
      initial[i * 4 + 0] = (Math.random() - 0.5) * CUBE_SIZE
      initial[i * 4 + 1] = (Math.random() - 0.5) * CUBE_SIZE
      initial[i * 4 + 2] = (Math.random() - 0.5) * CUBE_SIZE
      initial[i * 4 + 3] = Math.random()
      for (let c = 0; c < 4; c++) random[i * 4 + c] = Math.random()
    }
    const positions = instancedArray(initial.slice(), 'vec4') // xyz, w = baked light ("shadow")
    const velocities = instancedArray(count, 'vec4') // xyz, w = smoothed speed
    const origins = instancedArray(initial, 'vec4')
    const randoms = instancedArray(random, 'vec4')

    // all shapes stacked along z in one 3D texture; switching is a uniform change
    const res = VOLUME_RES
    const stacked = new Uint8Array(res ** 3 * 4 * shapes.length)
    shapes.forEach((s, i) => stacked.set(s.volume, i * res ** 3 * 4))
    const volumeTexture = new THREE.Data3DTexture(stacked, res, res, res * shapes.length)
    volumeTexture.format = THREE.RGBAFormat
    volumeTexture.type = THREE.UnsignedByteType
    volumeTexture.minFilter = volumeTexture.magFilter = THREE.LinearFilter
    volumeTexture.wrapS = volumeTexture.wrapT = volumeTexture.wrapR = THREE.ClampToEdgeWrapping
    volumeTexture.unpackAlignment = 1
    volumeTexture.needsUpdate = true

    // --- simulation -----------------------------------------------------------
    this.simulate = Fn(() => {
      const posEl = positions.element(instanceIndex)
      const velEl = velocities.element(instanceIndex)
      const pos = posEl.toVar()
      const vel = velEl.toVar()
      const rand = mix(vec4(0, 0, 0, 1), randoms.element(instanceIndex), k.variation)
      const dt = u.dtRatio

      // sample the SDF through the constant Y rotation
      const c = cos(u.rotation)
      const s = sin(u.rotation)
      const p = pos.xyz.div(CUBE_SIZE)
      const rotated = vec3(c.mul(p.x).add(s.mul(p.z)), p.y, s.negate().mul(p.x).add(c.mul(p.z)))
      const samplePos = rotated.mul(u.volumeScale).add(0.5).toVar()
      // keep z inside this shape's slab of the stacked texture
      const zHalfTexel = 0.5 / res
      samplePos.z.assign(clamp(samplePos.z, zHalfTexel, 1 - zHalfTexel).add(u.shapeIndex).div(shapes.length))
      const vol = texture3D(volumeTexture, samplePos).level(float(0))
      const g = normalize(vol.rgb.mul(2).sub(1))
      const grad = vec3(c.mul(g.x).sub(s.mul(g.z)), g.y, s.mul(g.x).add(c.mul(g.z))).toVar() // inverse rotation
      const dist = vol.a.mul(2).sub(1).sub(k.shellOffset)

      // fluid interaction: screen-space velocity under the particle
      const world = u.modelMatrix.mul(vec4(pos.xyz, 1))
      const clip = u.projMatrix.mul(u.viewMatrix.mul(world))
      const screenUV = clip.xy.div(clip.w).add(1).mul(0.5)
      const fluidVel = fluid.sample(screenUV)
      const push = u.camRight.mul(fluidVel.x).add(u.camUp.mul(fluidVel.y))
      vel.xyz.addAssign(push.mul(k.fluidPush).mul(dt).mul(k.interactForce))
      const invFluid = float(1).sub(length(fluidVel).mul(k.fluidRelax).mul(k.interactForce))

      // curl noise
      const force1 = rand.z.mul(0.3).add(0.7).mul(k.noiseForce).add(u.additionalNoise.mul(k.burstNoise))
      const noiseTime = u.time.mul(k.noiseSpeed).mul(rand.y.mul(0.7).add(1))
      const noise: AnyNode = bitangentNoise4D({ p: vec4(pos.xyz.mul(k.noiseScale), noiseTime) })
      vel.xyz.addAssign(noise.mul(force1).mul(dt))

      // spring towards the home position
      const origin = origins.element(instanceIndex)
      vel.xyz.addAssign(origin.xyz.sub(pos.xyz).mul(k.springForce).mul(dt).mul(invFluid))

      // towards the surface (only from outside)
      const force2 = rand.w.mul(0.3).add(0.7).mul(k.surfaceForce)
      const signForce = mix(0, -0.3, sign(dist).add(1))
      vel.xyz.addAssign(grad.mul(force2).mul(signForce).mul(dt).mul(invFluid))

      // friction + integrate
      vel.xyz.mulAssign(pow(k.friction, dt))
      pos.xyz.addAssign(vel.xyz.mul(dt))

      // keep inside the cylinder
      pos.y.assign(clamp(pos.y, -0.34, 0.35))
      const r = length(pos.xz)
      pos.xz.mulAssign(min(r, 0.275).div(max(r, 1e-6)))

      // wrapped diffuse from the SDF normal (GPU Gems ch.16), dark when deep inside
      const dp = dot(normalize(k.lightDir), grad)
      const diffuse = max(0, dp.add(k.wrap).div(k.wrap.add(1))).add(max(0, dp.negate()).mul(0.1))
      const targetShadow = mix(diffuse.mul(k.insideShadow), diffuse, smoothstep(-0.05, -0.001, dist))
      pos.w.assign(mix(targetShadow, pos.w, u.additionalNoise))

      // smoothed speed drives highlight colour + transparency
      vel.w.assign(mix(vel.w, length(vel.xyz), float(1).sub(pow(1 - 0.035, dt))))

      posEl.assign(pos)
      velEl.assign(vel)
    })().compute(count).setName('particles simulate')

    // --- rendering: camera-facing sphere impostors -------------------------
    const material = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: true })
    const posAttr = positions.toAttribute()
    const velAttr = velocities.toAttribute()
    const shadow = posAttr.w.toVarying('vShadow')
    const speed = velAttr.w.toVarying('vSpeed')

    material.positionNode = posAttr.xyz
    material.scaleNode = k.size
    material.colorNode = Fn(() => {
      const q = uv().mul(2).sub(1)
      const d2 = dot(q, q)
      If(d2.greaterThan(1), () => {
        Discard()
      })
      // the original's impostor normal (gl_PointCoord is y-down, then n.y = 1 - n.y):
      // an upward-biased normal that keeps the camera-facing side lit
      const n = vec3(q.x, q.y.add(1), sqrt(float(1).sub(clamp(d2, 0, 1))))
      const ramp = pow(max(0, dot(normalize(k.impostorLight), normalize(n))).mul(shadow), k.contrast)
      const base = mix(k.colorDark, k.colorLight, ramp).mul(k.brightness)
      const lit = mix(base, k.colorFast, pow(remapClamp(speed, k.fastMin, k.fastMax, 0, 1), 2))
      // intro: fade in from a pale blue glow
      return mix(k.colorInitial, lit, this.reveal)
    })()
    // poor man's motion blur: fast particles get see-through
    material.opacityNode = pow(remapClamp(speed, k.blurMin, k.blurMax, 1, 0), 2).mul(0.5).add(0.5).mul(this.reveal)

    this.object = new THREE.Sprite(material)
    this.object.count = count
    this.object.frustumCulled = false

    this.applyShape(0)
  }

  /** Run the simulation for a while so the shape is formed before it is first seen. */
  prewarm(renderer: THREE.WebGPURenderer, steps = 60) {
    const u = this.uniforms
    u.dtRatio.value = 1
    for (let i = 0; i < steps; i++) {
      u.time.value = i / 60
      u.rotation.value -= this.settings.rotationSpeed / 60
      renderer.compute(this.simulate)
    }
  }

  get shapeIndex() {
    return this.current
  }

  get shapeNames() {
    return this.shapes.map((s) => s.name)
  }

  get volumeScale() {
    return this.shapes[this.current].scale
  }

  set volumeScale(value: number) {
    this.shapes[this.current].scale = value
    this.uniforms.volumeScale.value = value
  }

  /** Jump to a shape, with the noise burst used by the original. */
  setShape(index: number, time: number) {
    const n = this.shapes.length
    this.current = ((index % n) + n) % n
    this.applyShape(this.current)
    this.uniforms.rotation.value = Math.PI * 1.5
    this.noiseTween = { from: 1, start: time, duration: 0.5 }
  }

  private applyShape(index: number) {
    this.uniforms.shapeIndex.value = index
    this.uniforms.volumeScale.value = this.shapes[index].scale
  }

  update(renderer: THREE.WebGPURenderer, camera: THREE.Camera, time: number, delta: number, dtRatio: number) {
    const u = this.uniforms
    u.time.value = time
    u.dtRatio.value = dtRatio
    u.rotation.value -= delta * this.settings.rotationSpeed

    // power2.inOut from 1 → 0
    const t = this.noiseTween.start < 0 ? 1 : Math.min(1, (time - this.noiseTween.start) / this.noiseTween.duration)
    const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
    u.additionalNoise.value = this.noiseTween.from * (1 - eased)

    if (this.revealStart < 0) this.revealStart = time
    this.reveal.value = Math.min(1, (time - this.revealStart) / 1.2) ** 2

    this.object.updateMatrixWorld()
    u.modelMatrix.value.copy(this.object.matrixWorld)
    u.viewMatrix.value.copy(camera.matrixWorldInverse)
    u.projMatrix.value.copy(camera.projectionMatrix)
    u.camRight.value.setFromMatrixColumn(camera.matrixWorld, 0)
    u.camUp.value.setFromMatrixColumn(camera.matrixWorld, 1)

    renderer.compute(this.simulate)
  }
}
