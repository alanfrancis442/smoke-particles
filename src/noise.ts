import { wgslFn } from 'three/tsl'

// 4D bitangent noise (Atyuwen, public domain) – a cheap divergence-free curl
// noise. Same function igloo.inc uses to keep the particle cloud alive.

const pcg4d16 = wgslFn(/* wgsl */ `
fn pcg4d16(p: vec4u) -> vec2u {
  var v = p * 1664525u + 1013904223u;
  v.x += v.y * v.w;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  v.w += v.y * v.z;
  v.x += v.y * v.w;
  v.y += v.z * v.x;
  return v.xy;
}
`)

const gradient4d = wgslFn(/* wgsl */ `
fn gradient4d(hash: u32) -> vec4f {
  let g = vec4f(vec4u(hash) & vec4u(0x80000u, 0x40000u, 0x20000u, 0x10000u));
  return g * (1.0 / vec4f(262144.0, 131072.0, 65536.0, 32768.0)) - 1.0;
}
`)

export const bitangentNoise4D = wgslFn(/* wgsl */ `
fn bitangentNoise4D(p: vec4f) -> vec3f {
  let F4 = vec4f(0.309016994374947451);
  let C = vec4f(0.138196601125011, 0.276393202250021, 0.414589803375032, -0.447213595499958);

  var i = floor(p + dot(p, F4));
  let x0 = p - i + dot(i, C.xxxx);

  let isX = step(x0.yzw, x0.xxx);
  let isYZ = step(x0.zww, x0.yyz);
  var i0 = vec4f(isX.x + isX.y + isX.z, 1.0 - isX);
  i0.y += isYZ.x + isYZ.y;
  i0.z += 1.0 - isYZ.x;
  i0.w += 1.0 - isYZ.y;
  i0.z += isYZ.z;
  i0.w += 1.0 - isYZ.z;

  let i3 = clamp(i0, vec4f(0.0), vec4f(1.0));
  let i2 = clamp(i0 - 1.0, vec4f(0.0), vec4f(1.0));
  let i1 = clamp(i0 - 2.0, vec4f(0.0), vec4f(1.0));

  let x1 = x0 - i1 + C.xxxx;
  let x2 = x0 - i2 + C.yyyy;
  let x3 = x0 - i3 + C.zzzz;
  let x4 = x0 + C.wwww;

  i = i + 32768.5;
  let hash0 = pcg4d16(vec4u(i));
  let hash1 = pcg4d16(vec4u(i + i1));
  let hash2 = pcg4d16(vec4u(i + i2));
  let hash3 = pcg4d16(vec4u(i + i3));
  let hash4 = pcg4d16(vec4u(i + 1.0));

  let p00 = gradient4d(hash0.x); let p01 = gradient4d(hash0.y);
  let p10 = gradient4d(hash1.x); let p11 = gradient4d(hash1.y);
  let p20 = gradient4d(hash2.x); let p21 = gradient4d(hash2.y);
  let p30 = gradient4d(hash3.x); let p31 = gradient4d(hash3.y);
  let p40 = gradient4d(hash4.x); let p41 = gradient4d(hash4.y);

  let m0 = clamp(0.6 - vec3f(dot(x0, x0), dot(x1, x1), dot(x2, x2)), vec3f(0.0), vec3f(1.0));
  let m1 = clamp(0.6 - vec2f(dot(x3, x3), dot(x4, x4)), vec2f(0.0), vec2f(1.0));
  let m02 = m0 * m0;
  let m03 = m02 * m0;
  let m12 = m1 * m1;
  let m13 = m12 * m1;

  var temp0 = m02 * vec3f(dot(p00, x0), dot(p10, x1), dot(p20, x2));
  var temp1 = m12 * vec2f(dot(p30, x3), dot(p40, x4));
  var grad0 = -6.0 * (temp0.x * x0 + temp0.y * x1 + temp0.z * x2 + temp1.x * x3 + temp1.y * x4);
  grad0 += m03.x * p00 + m03.y * p10 + m03.z * p20 + m13.x * p30 + m13.y * p40;

  temp0 = m02 * vec3f(dot(p01, x0), dot(p11, x1), dot(p21, x2));
  temp1 = m12 * vec2f(dot(p31, x3), dot(p41, x4));
  var grad1 = -6.0 * (temp0.x * x0 + temp0.y * x1 + temp0.z * x2 + temp1.x * x3 + temp1.y * x4);
  grad1 += m03.x * p01 + m03.y * p11 + m03.z * p21 + m13.x * p31 + m13.y * p41;

  return cross(grad0.xyz, grad1.xyz) * 81.0;
}
`, [pcg4d16, gradient4d] as never)
