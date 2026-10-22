import './style.css'
import * as THREE from 'three/webgpu'
import { pass } from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { FluidSim } from './fluid'
import { VolumeParticles, type ParticleShape } from './particles'
import { createEnvironment } from './environment'
import { setupInspector } from './gui'

const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!
const label = {
  prev: document.querySelector<HTMLElement>('#label-prev')!,
  current: document.querySelector<HTMLElement>('#label-current')!,
  next: document.querySelector<HTMLElement>('#label-next')!,
}

if (!navigator.gpu) {
  document.body.classList.add('no-webgpu')
  throw new Error('WebGPU is not available in this browser')
}

// flow: how much of the spin flows through the SDF instead of turning the cloud rigidly.
// Detailed models with thin parts smear at the original 1, so they mostly spin rigidly
// and face the camera (facing 0) when switched to.
const SHAPES = [
  { name: 'Duck', file: 'duck', scale: 1.15, flow: 1 },
  { name: 'X / Twitter', file: 'x', scale: 1.2, flow: 1 },
  { name: 'Medium', file: 'medium', scale: 1.05, flow: 1 },
  { name: 'Drone', file: 'drone', scale: 1.2, flow: 0.1, facing: 0 },
  { name: 'F1 Wheel', file: 'f1-wheel', scale: 1.2, flow: 0.15, facing: 0 },
  { name: 'AirPods Max', file: 'airpods-max', scale: 1.15, flow: 0.15, facing: 0 },
  { name: 'Takeaway Cup', file: 'takeaway-cup', scale: 1.15, flow: 0.4, facing: 0 },
  { name: 'Steam Deck', file: 'steam-deck', scale: 1.2, flow: 0.15, facing: 0 },
  { name: 'VR Headset', file: 'vr', scale: 1.2, flow: 0.1, facing: 0 },
]

const params = new URLSearchParams(location.search)
const particleCount = Number(params.get('count')) || 150_000

const renderer = new THREE.WebGPURenderer({ canvas, antialias: false })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.toneMapping = THREE.NoToneMapping

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(25, window.innerWidth / window.innerHeight, 0.05, 30)
const cameraBase = new THREE.Vector3(0, 0.02, 1.95)
const lookTarget = new THREE.Vector3(0, -0.03, 0)

const environment = createEnvironment(scene)

const volumes = await Promise.all(
  SHAPES.map(async (s) => {
    const response = await fetch(`/volumes/${s.file}.vol`)
    return new Uint8Array(await new Response(response.body!.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
  }),
)
const shapes: ParticleShape[] = SHAPES.map(({ file: _, ...s }, i) => ({ ...s, volume: volumes[i] }))

const fluid = new FluidSim()
const particles = new VolumeParticles(shapes, fluid, particleCount)
scene.add(particles.object)

// post: a soft bloom on the ring lights and the energised particles
const pipeline = new THREE.RenderPipeline(renderer)
const scenePass = pass(scene, camera)
const sceneColor = scenePass.getTextureNode('output')
const bloomPass = bloom(sceneColor, 0.35, 0.45, 0.9)
pipeline.outputNode = sceneColor.add(bloomPass)

// --- input ----------------------------------------------------------------
const pointer = new THREE.Vector2(0.5, 0.5) // 0..1, y up
const pointerSmoothed = new THREE.Vector2(0, 0)
let pointerDown: { x: number; y: number; t: number } | null = null

canvas.addEventListener('pointermove', (e) => {
  pointer.set(e.clientX / window.innerWidth, 1 - e.clientY / window.innerHeight)
  fluid.setPointer(pointer.x, pointer.y)
})
canvas.addEventListener('pointerdown', (e) => {
  pointer.set(e.clientX / window.innerWidth, 1 - e.clientY / window.innerHeight)
  fluid.setPointer(pointer.x, pointer.y)
  pointerDown = { x: e.clientX, y: e.clientY, t: performance.now() }
})
canvas.addEventListener('pointerup', (e) => {
  if (!pointerDown) return
  const dx = e.clientX - pointerDown.x
  const quick = performance.now() - pointerDown.t < 350
  if (Math.abs(dx) > 80 && quick) changeShape(dx < 0 ? 1 : -1) // swipe
  else if (Math.abs(dx) < 6 && e.pointerType === 'mouse') changeShape(e.clientX < window.innerWidth / 2 ? -1 : 1)
  pointerDown = null
})
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
  if (e.key === 'ArrowRight') changeShape(1)
  else if (e.key === 'ArrowLeft') changeShape(-1)
})
document.querySelector('#arrow-prev')!.addEventListener('click', () => changeShape(-1))
document.querySelector('#arrow-next')!.addEventListener('click', () => changeShape(1))

const timer = new THREE.Timer()
timer.connect(document)

function changeShape(direction: 1 | -1) {
  setShape(particles.shapeIndex + direction)
}
function setShape(index: number) {
  particles.setShape(index, timer.getElapsed())
  updateLabels()
}
function updateLabels() {
  const n = shapes.length
  const shapeIndex = particles.shapeIndex
  label.prev.textContent = shapes[(shapeIndex - 1 + n) % n].name
  label.current.textContent = shapes[shapeIndex].name
  label.next.textContent = shapes[(shapeIndex + 1) % n].name
  label.current.classList.remove('flash')
  void label.current.offsetWidth
  label.current.classList.add('flash')
}
updateLabels()

// --- resize ---------------------------------------------------------------
function resize() {
  const aspect = window.innerWidth / window.innerHeight
  camera.aspect = aspect
  // keep the chamber in frame on portrait screens
  const halfWidth = 0.42
  cameraBase.z = Math.max(1.95, halfWidth / (Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * aspect))
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
}
window.addEventListener('resize', resize)
resize()

setupInspector(renderer, {
  particles,
  fluid,
  bloom: bloomPass,
  onShapeChange: setShape,
})

// --- loop -----------------------------------------------------------------
await renderer.init()
particles.prewarm(renderer)

renderer.setAnimationLoop(() => {
  timer.update()
  const delta = Math.min(timer.getDelta(), 1 / 15)
  const time = timer.getElapsed()
  const dtRatio = Math.min(delta * 60, 2)

  // subtle parallax
  pointerSmoothed.lerp(new THREE.Vector2(pointer.x - 0.5, pointer.y - 0.5), 1 - Math.pow(0.04, delta))
  camera.position.set(cameraBase.x + pointerSmoothed.x * 0.06, cameraBase.y + pointerSmoothed.y * 0.04, cameraBase.z)
  camera.lookAt(lookTarget)
  camera.updateMatrixWorld()

  fluid.update(renderer, time, dtRatio, camera.aspect)
  particles.update(renderer, camera, time, delta, dtRatio)
  environment.update(time)

  pipeline.render()
})
