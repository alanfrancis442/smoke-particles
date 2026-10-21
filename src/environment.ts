import * as THREE from 'three/webgpu'
import { color, mix, positionWorldDirection, smoothstep } from 'three/tsl'

// The misty glass chamber the particles float in: gradient sky + fog and a ring
// light above.

export function createEnvironment(scene: THREE.Scene) {
  const fogColor = new THREE.Color('#c4c8cf')
  scene.fog = new THREE.Fog(fogColor, 2.2, 6.5)

  const y = positionWorldDirection.y
  const below = color('#8e949e')
  const horizon = color('#c4c8cf')
  const zenith = color('#e3e5e9')
  scene.backgroundNode = mix(mix(below, horizon, smoothstep(-0.25, 0, y)), zenith, smoothstep(0.02, 0.6, y))

  scene.add(new THREE.HemisphereLight('#f4f7ff', '#80868f', 1.8))
  const sun = new THREE.DirectionalLight('#ffffff', 1.4)
  sun.position.set(0.4, 2, 1)
  scene.add(sun)

  const group = new THREE.Group()
  scene.add(group)

  const glow = (intensity: number) =>
    new THREE.MeshBasicNodeMaterial({ color: new THREE.Color('#eef6ff').multiplyScalar(intensity), fog: false })

  // far ground
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(12, 64).rotateX(-Math.PI / 2),
    new THREE.MeshStandardNodeMaterial({ color: '#9aa0a9', roughness: 0.9 }),
  )
  ground.position.y = -0.47
  group.add(ground)

  // ring light above the chamber
  const ringLight = new THREE.Mesh(
    new THREE.TorusGeometry(0.55, 0.014, 8, 160).rotateX(Math.PI / 2),
    glow(4),
  )
  ringLight.position.y = 0.68
  group.add(ringLight)

  // floating dust (1px points are free on WebGPU)
  const dustCount = 700
  const dust = new Float32Array(dustCount * 3)
  for (let i = 0; i < dustCount; i++) {
    const a = Math.random() * Math.PI * 2
    const r = 0.4 + Math.random() * 2.5
    dust.set([Math.cos(a) * r, -0.4 + Math.random() * 1.8, Math.sin(a) * r - 0.5], i * 3)
  }
  const dustGeometry = new THREE.BufferGeometry()
  dustGeometry.setAttribute('position', new THREE.BufferAttribute(dust, 3))
  const dustPoints = new THREE.Points(
    dustGeometry,
    new THREE.PointsNodeMaterial({ color: '#ffffff', transparent: true, opacity: 0.55, depthWrite: false }),
  )
  group.add(dustPoints)

  return {
    update(time: number) {
      dustPoints.rotation.y = time * 0.01
    },
  }
}
