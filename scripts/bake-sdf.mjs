// Bakes the particle target shapes into 64³ signed-distance volumes.
//
// Output per shape: public/volumes/<name>.bin, RES³ RGBA8 texels laid out x-fastest,
//   rgb = SDF gradient (outward surface normal) * 0.5 + 0.5
//   a   = signed distance in volume units (the [0,1] cube), clamped to ±1, * 0.5 + 0.5
//
// Run with: node scripts/bake-sdf.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import * as THREE from 'three'
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { MeshBVH } from 'three-mesh-bvh'

const RES = 64
const FILL = 0.9 // largest dimension of the shape, as a fraction of the volume
const OUT_DIR = new URL('../public/volumes/', import.meta.url)

// ---------------------------------------------------------------------------
// Minimal GLB reader: positions + indices of every mesh primitive, in world space

function loadGLB(path) {
  const buf = readFileSync(path)
  const jsonLen = buf.readUInt32LE(12)
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'))
  const binStart = 20 + jsonLen + 8
  const bin = buf.subarray(binStart)

  const readAccessor = (index) => {
    const acc = json.accessors[index]
    const view = json.bufferViews[acc.bufferView]
    const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type]
    const Ctor = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array }[acc.componentType]
    const offset = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0)
    const stride = view.byteStride ?? comps * Ctor.BYTES_PER_ELEMENT
    const out = new Ctor(acc.count * comps)
    const dv = new DataView(bin.buffer, bin.byteOffset)
    const get = {
      5121: (o) => dv.getUint8(o),
      5123: (o) => dv.getUint16(o, true),
      5125: (o) => dv.getUint32(o, true),
      5126: (o) => dv.getFloat32(o, true),
    }[acc.componentType]
    for (let i = 0; i < acc.count; i++)
      for (let c = 0; c < comps; c++) out[i * comps + c] = get(offset + i * stride + c * Ctor.BYTES_PER_ELEMENT)
    return out
  }

  const geometries = []
  const visit = (nodeIndex, parentMatrix) => {
    const node = json.nodes[nodeIndex]
    const local = new THREE.Matrix4()
    if (node.matrix) local.fromArray(node.matrix)
    else
      local.compose(
        new THREE.Vector3(...(node.translation ?? [0, 0, 0])),
        new THREE.Quaternion(...(node.rotation ?? [0, 0, 0, 1])),
        new THREE.Vector3(...(node.scale ?? [1, 1, 1])),
      )
    const world = parentMatrix.clone().multiply(local)
    if (node.mesh !== undefined) {
      for (const prim of json.meshes[node.mesh].primitives) {
        const g = new THREE.BufferGeometry()
        g.setAttribute('position', new THREE.BufferAttribute(readAccessor(prim.attributes.POSITION), 3))
        if (prim.indices !== undefined) g.setIndex(new THREE.BufferAttribute(Uint32Array.from(readAccessor(prim.indices)), 1))
        g.applyMatrix4(world)
        geometries.push(g.index ? g.toNonIndexed() : g)
      }
    }
    for (const child of node.children ?? []) visit(child, world)
  }
  for (const n of json.scenes[json.scene ?? 0].nodes) visit(n, new THREE.Matrix4())
  return mergeGeometries(geometries)
}

// ---------------------------------------------------------------------------
// Procedural shapes

// The X logo outline (24×24 viewBox, all straight segments), extruded with a bevel
function xLogo() {
  const outer = [
    [18.244, 2.25], [21.552, 2.25], [14.325, 10.51], [22.827, 21.75], [16.17, 21.75], [10.956, 14.933],
    [4.99, 21.75], [1.68, 21.75], [9.41, 12.915], [1.254, 2.25], [8.08, 2.25], [12.793, 8.481],
  ]
  const hole = [[17.083, 19.77], [18.916, 19.77], [7.084, 4.126], [5.117, 4.126]]
  const toVec = ([x, y]) => new THREE.Vector2(x - 12, 12 - y) // SVG is y-down
  const shape = new THREE.Shape(outer.map(toVec))
  shape.holes.push(new THREE.Path(hole.map(toVec)))
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 2.2, bevelEnabled: true, bevelThickness: 0.9, bevelSize: 0.45, bevelSegments: 4, curveSegments: 1,
  })
  return geo.toNonIndexed()
}

// The Medium logo: a circle, an ellipse and a thin ellipse, as flattened ellipsoids
function mediumLogo() {
  const parts = [
    { x: -0.62, sx: 0.62, sy: 0.62 },
    { x: 0.42, sx: 0.31, sy: 0.58 },
    { x: 0.92, sx: 0.11, sy: 0.52 },
  ].map(({ x, sx, sy }) => {
    const g = new THREE.SphereGeometry(1, 64, 32)
    g.scale(sx, sy, 0.24)
    g.translate(x, 0, 0)
    return g.toNonIndexed()
  })
  // mergeGeometries needs matching attribute sets
  for (const p of parts) { p.deleteAttribute('uv'); p.deleteAttribute('normal') }
  return mergeGeometries(parts)
}

// ---------------------------------------------------------------------------
// SDF bake

function bake(name, geometry) {
  for (const key of Object.keys(geometry.attributes)) if (key !== 'position') geometry.deleteAttribute(key)
  geometry = mergeVertices(geometry)

  // centre and fit into the [-0.5, 0.5] volume
  geometry.computeBoundingBox()
  const box = geometry.boundingBox
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  geometry.translate(-center.x, -center.y, -center.z)
  geometry.scale(...Array(3).fill(FILL / Math.max(size.x, size.y, size.z)))

  const bvh = new MeshBVH(geometry)
  const dist = new Float32Array(RES ** 3)
  const p = new THREE.Vector3()
  const hit = {}
  const ray = new THREE.Ray()
  const dirs = [new THREE.Vector3(1, 0.013, 0.007), new THREE.Vector3(-0.011, 1, 0.017), new THREE.Vector3(0.019, -0.009, 1)].map((d) => d.normalize())

  const t0 = performance.now()
  for (let z = 0; z < RES; z++)
    for (let y = 0; y < RES; y++)
      for (let x = 0; x < RES; x++) {
        p.set((x + 0.5) / RES - 0.5, (y + 0.5) / RES - 0.5, (z + 0.5) / RES - 0.5)
        bvh.closestPointToPoint(p, hit)
        // inside/outside by majority vote of ray-crossing parity
        let inside = 0
        for (const d of dirs) {
          ray.set(p, d)
          inside += bvh.raycast(ray, THREE.DoubleSide).length & 1
        }
        dist[x + y * RES + z * RES * RES] = inside >= 2 ? -hit.distance : hit.distance
      }

  const at = (x, y, z) => {
    x = Math.min(RES - 1, Math.max(0, x)); y = Math.min(RES - 1, Math.max(0, y)); z = Math.min(RES - 1, Math.max(0, z))
    return dist[x + y * RES + z * RES * RES]
  }
  const out = new Uint8Array(RES ** 3 * 4)
  const g = new THREE.Vector3()
  const enc = (v) => Math.round(Math.min(1, Math.max(-1, v)) * 127.5 + 127.5)
  for (let z = 0; z < RES; z++)
    for (let y = 0; y < RES; y++)
      for (let x = 0; x < RES; x++) {
        g.set(at(x + 1, y, z) - at(x - 1, y, z), at(x, y + 1, z) - at(x, y - 1, z), at(x, y, z + 1) - at(x, y, z - 1))
        if (g.lengthSq() < 1e-12) g.set(0, 1, 0)
        g.normalize()
        const i = (x + y * RES + z * RES * RES) * 4
        out[i] = enc(g.x); out[i + 1] = enc(g.y); out[i + 2] = enc(g.z)
        out[i + 3] = enc(dist[i / 4])
      }

  writeFileSync(new URL(`${name}.bin`, OUT_DIR), out)
  const insideCount = dist.reduce((n, d) => n + (d < 0), 0)
  console.log(`${name}: ${((performance.now() - t0) / 1000).toFixed(1)}s, ${(100 * insideCount / dist.length).toFixed(1)}% inside`)
}

mkdirSync(OUT_DIR, { recursive: true })
bake('duck', loadGLB(new URL('../assets-src/Duck.glb', import.meta.url)))
bake('x', xLogo())
bake('medium', mediumLogo())
