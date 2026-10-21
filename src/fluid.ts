import * as THREE from 'three/webgpu'
import { Fn, clamp, dot, float, floor, fract, instanceIndex, instancedArray, int, length, mix, uniform, vec2 } from 'three/tsl'

// Screen-space 2D stable-fluids solver on compute buffers. It is a port of the
// igloo.inc setup (Pavel Dobryakov-style): line splats from the pointer,
// divergence → pressure (Jacobi) → gradient subtract → advection, no vorticity.
// The particles read the velocity field at their projected screen position.

// TSL's generic node typings are too strict for small graph helpers
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNode = any

const RES = 128
const CELLS = RES * RES


const at = (x: AnyNode, y: AnyNode): AnyNode => clamp(y, 0, RES - 1).mul(RES).add(clamp(x, 0, RES - 1))
const cellUV = (x: AnyNode, y: AnyNode): AnyNode => vec2(float(x).add(0.5), float(y).add(0.5)).div(RES)
const cell = () => {
  const i = int(instanceIndex)
  return { x: i.mod(RES), y: i.div(RES) }
}

// clamp-to-edge bilinear fetch from a RES×RES vec2 buffer
function sampleField(field: AnyNode, uv: AnyNode): AnyNode {
  const st = uv.mul(RES).sub(0.5)
  const i0: AnyNode = floor(st)
  const f: AnyNode = fract(st)
  const ix: AnyNode = int(i0.x)
  const iy: AnyNode = int(i0.y)
  const x0: AnyNode = clamp(ix, 0, RES - 1)
  const y0: AnyNode = clamp(iy, 0, RES - 1)
  const x1: AnyNode = clamp(ix.add(1), 0, RES - 1)
  const y1: AnyNode = clamp(iy.add(1), 0, RES - 1)
  const a = field.element(y0.mul(RES).add(x0))
  const b = field.element(y0.mul(RES).add(x1))
  const c = field.element(y1.mul(RES).add(x0))
  const d = field.element(y1.mul(RES).add(x1))
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y)
}

export class FluidSim {
  /** Tweakable at runtime. Defaults are the igloo.inc values. */
  readonly options = {
    splatRadius: uniform(0.22),
    splatForce: 35,
    velocityDissipation: 0.98,
    pressureDissipation: 0.86,
  }

  readonly velocity: AnyNode = instancedArray(CELLS, 'vec2')

  private readonly velTmp: AnyNode = instancedArray(CELLS, 'vec2')
  private readonly pressureA: AnyNode = instancedArray(CELLS, 'float')
  private readonly pressureB: AnyNode = instancedArray(CELLS, 'float')
  private readonly divergence: AnyNode = instancedArray(CELLS, 'float')

  private readonly uPoint = uniform(new THREE.Vector2(0.5, 0.5))
  private readonly uPrevPoint = uniform(new THREE.Vector2(0.5, 0.5))
  private readonly uSplat = uniform(new THREE.Vector2())
  private readonly uAspect = uniform(1)
  private readonly uDt = uniform(1)
  private readonly uVelDissipation = uniform(1)
  private readonly uPressureDissipation = uniform(1)

  private readonly splatPass
  private readonly solvePasses

  private pointer = new THREE.Vector2(0.5, 0.5)
  private prevPointer = new THREE.Vector2(0.5, 0.5)
  private lastUpdate = 0
  private lastMove = -Infinity
  private strokeRestart = true

  constructor() {
    // velocity += cubicIn(1 - dist(uv, segment) / radius) * force
    this.splatPass = Fn(() => {
      const { x, y } = cell()
      const pa = cellUV(x, y).sub(this.uPrevPoint).toVar()
      const ba = this.uPoint.sub(this.uPrevPoint).toVar()
      pa.x.mulAssign(this.uAspect)
      ba.x.mulAssign(this.uAspect)
      const h = clamp(dot(pa, ba).div(dot(ba, ba).max(1e-8)), 0, 1)
      const f = clamp(float(1).sub(length(pa.sub(ba.mul(h))).div(this.options.splatRadius)), 0, 1)
      this.velocity.element(instanceIndex).addAssign(this.uSplat.mul(f.mul(f).mul(f)))
    })().compute(CELLS).setName('fluid splat')

    const divergencePass = Fn(() => {
      const { x, y } = cell()
      const L = this.velocity.element(at(x.sub(1), y)).x
      const R = this.velocity.element(at(x.add(1), y)).x
      const T = this.velocity.element(at(x, y.add(1))).y
      const B = this.velocity.element(at(x, y.sub(1))).y
      this.divergence.element(instanceIndex).assign(R.sub(L).add(T).sub(B).mul(0.5))
      this.pressureA.element(instanceIndex).mulAssign(this.uPressureDissipation)
    })().compute(CELLS).setName('fluid divergence')

    const jacobi = (src: AnyNode, dst: AnyNode) =>
      Fn(() => {
        const { x, y } = cell()
        const sum = src.element(at(x.sub(1), y))
          .add(src.element(at(x.add(1), y)))
          .add(src.element(at(x, y.add(1))))
          .add(src.element(at(x, y.sub(1))))
        dst.element(instanceIndex).assign(sum.sub(this.divergence.element(instanceIndex)).mul(0.25))
      })().compute(CELLS).setName('fluid pressure')

    const gradientPass = Fn(() => {
      const { x, y } = cell()
      const p = this.pressureA
      const grad = vec2(
        p.element(at(x.add(1), y)).sub(p.element(at(x.sub(1), y))),
        p.element(at(x, y.add(1))).sub(p.element(at(x, y.sub(1)))),
      )
      this.velTmp.element(instanceIndex).assign(this.velocity.element(instanceIndex).sub(grad))
    })().compute(CELLS).setName('fluid gradient')

    const advectPass = Fn(() => {
      const { x, y } = cell()
      const coord = cellUV(x, y).sub(this.velTmp.element(instanceIndex).mul(this.uDt).div(RES))
      this.velocity.element(instanceIndex).assign(sampleField(this.velTmp, coord).mul(this.uVelDissipation))
    })().compute(CELLS).setName('fluid advect')

    this.solvePasses = [
      divergencePass,
      jacobi(this.pressureA, this.pressureB),
      jacobi(this.pressureB, this.pressureA),
      gradientPass,
      advectPass,
    ]
  }

  /** Pointer position in 0..1 screen space, y up. */
  setPointer(x: number, y: number) {
    // a pause of more than 150ms between moves starts a new stroke (no jump splat)
    const now = performance.now()
    if (now - this.lastMove > 150) this.strokeRestart = true
    this.lastMove = now
    this.pointer.set(x, y)
  }

  /** Bilinear velocity lookup at a 0..1 screen-space uv (for other compute shaders). */
  sample(uv: AnyNode): AnyNode {
    return sampleField(this.velocity, uv)
  }

  update(renderer: THREE.WebGPURenderer, time: number, dtRatio: number, aspect: number) {
    this.uAspect.value = aspect
    this.uDt.value = dtRatio
    this.uVelDissipation.value = this.options.velocityDissipation ** dtRatio
    this.uPressureDissipation.value = this.options.pressureDissipation ** dtRatio

    // splats are throttled to ~60Hz like the original
    if (time - this.lastUpdate >= 0.016) {
      const dx = this.pointer.x - this.prevPointer.x
      const dy = this.pointer.y - this.prevPointer.y
      if (dx !== 0 || dy !== 0) {
        const restart = this.strokeRestart
        this.strokeRestart = false
        this.uPoint.value.copy(this.pointer)
        this.uPrevPoint.value.copy(restart ? this.pointer : this.prevPointer)
        this.uSplat.value.set(dx * aspect, dy).multiplyScalar(restart ? 0 : this.options.splatForce)
        renderer.compute(this.splatPass)
      }
      this.lastUpdate = time
      this.prevPointer.copy(this.pointer)
    }

    renderer.compute(this.solvePasses)
  }
}
