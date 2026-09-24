import * as THREE from 'three';

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number): number => clamp01((v - a) / (b - a));
export const remap = (a: number, b: number, c: number, d: number, v: number): number =>
  lerp(c, d, invLerp(a, b, v));

export const smoothstep = (a: number, b: number, v: number): number => {
  const t = invLerp(a, b, v);
  return t * t * (3 - 2 * t);
};

/** Frame-rate independent exponential approach. `lambda` is responsiveness in 1/s. */
export const damp = (a: number, b: number, lambda: number, dt: number): number =>
  lerp(a, b, 1 - Math.exp(-lambda * dt));

export const wrapAngle = (a: number): number => {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
};

export const dampAngle = (a: number, b: number, lambda: number, dt: number): number =>
  a + wrapAngle(b - a) * (1 - Math.exp(-lambda * dt));

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - clamp01(t), 3);
export const easeInCubic = (t: number): number => Math.pow(clamp01(t), 3);
export const easeOutBack = (t: number, s = 1.70158): number => {
  t = clamp01(t) - 1;
  return t * t * ((s + 1) * t + s) + 1;
};
export const easeOutElastic = (t: number): number => {
  t = clamp01(t);
  if (t === 0 || t === 1) return t;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
};

/** 0 → 1 → 0 bump over [0,1]. */
export const bump = (t: number): number => Math.sin(clamp01(t) * Math.PI);

export const len2 = (x: number, z: number): number => Math.sqrt(x * x + z * z);

/** Damped harmonic spring on a scalar. Great for squash, recoil and wobble. */
export class Spring {
  value: number;
  velocity = 0;
  target: number;

  constructor(
    value = 0,
    public stiffness = 220,
    public damping = 14,
  ) {
    this.value = value;
    this.target = value;
  }

  update(dt: number): number {
    const a = this.stiffness * (this.target - this.value) - this.damping * this.velocity;
    this.velocity += a * dt;
    this.value += this.velocity * dt;
    return this.value;
  }

  kick(v: number): void {
    this.velocity += v;
  }

  reset(v: number): void {
    this.value = v;
    this.target = v;
    this.velocity = 0;
  }
}

/** Shared scratch objects – never hold on to them across calls. */
export const tmpV1 = new THREE.Vector3();
export const tmpV2 = new THREE.Vector3();
export const tmpV3 = new THREE.Vector3();
export const tmpQ1 = new THREE.Quaternion();
export const tmpM1 = new THREE.Matrix4();

export const UP = new THREE.Vector3(0, 1, 0);

/** Build a matrix from position, euler rotation (radians) and scale. */
export function compose(
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
  sx = 1,
  sy = sx,
  sz = sx,
): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ'));
  m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(sx, sy, sz));
  return m;
}

/** Point-to-segment distance squared in XZ. */
export function distToSegment2(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = clamp01(t);
  const qx = ax + dx * t - px;
  const qz = az + dz * t - pz;
  return qx * qx + qz * qz;
}
