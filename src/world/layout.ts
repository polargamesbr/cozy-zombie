/**
 * The farm, as data. Ground painting, grass placement, colliders and props all read from here
 * so the map stays consistent. Units are meters; +X east, +Z south (towards the default camera).
 */
export type Pt = [number, number];

export interface PathDef {
  pts: Pt[];
  width: number;
  kind: 'dirt' | 'stone' | 'trail';
}

export const LAYOUT = {
  bounds: { minX: -31, maxX: 31, minZ: -25, maxZ: 23 },
  paintSize: 110,

  road: { z: 13, width: 6.2 },

  house: { x: -10, z: -6.6, w: 7.2, d: 5.6, h: 2.9 },
  barn: { x: 13, z: -10, w: 9, d: 8 },
  pond: { x: -21, z: -13.5, rx: 5.4, rz: 3.9 },

  paths: [
    { pts: [[-10, -2.4], [-10, 1.5], [-10, 4.2], [-9.4, 7.5], [-9, 10.5]], width: 1.5, kind: 'stone' },
    { pts: [[-1.5, 10.5], [-1.4, 7.2], [-0.6, 4.4], [0.6, 1.2], [1.2, -0.8]], width: 3.4, kind: 'dirt' },
    { pts: [[11.6, 10.5], [12, 5], [12.6, 0], [13, -5.4]], width: 3.6, kind: 'dirt' },
    { pts: [[2.2, -0.4], [5.5, -1.2], [9, -2.6], [11.4, -3.6]], width: 1.3, kind: 'trail' },
    { pts: [[-16.8, -10.8], [-13.6, -10.2], [-11, -10]], width: 1.1, kind: 'trail' },
  ] as PathDef[],

  beds: [
    { x: -14.2, z: 0.6, w: 2.4, d: 3.2, rows: 4, kind: 'veg' },
    { x: -12.9, z: -3.25, w: 2.2, d: 0.8, rows: 0, kind: 'flowers' },
    { x: -7.1, z: -3.25, w: 2.2, d: 0.8, rows: 0, kind: 'flowers' },
    { x: 19.5, z: 1.6, w: 5.2, d: 3.6, rows: 3, kind: 'pumpkins' },
  ],

  /** Picket fence around the front yard (runs of connected posts). */
  picketRuns: [
    [[-16.2, -4.2], [-16.2, 4.2], [-11, 4.2]],
    [[-9, 4.2], [-3.8, 4.2], [-3.8, -4.2]],
  ] as Pt[][],

  /** Split-rail fences. */
  rusticRuns: [
    [[-31, 9.4], [-12.2, 9.4]],
    [[16.5, 9.4], [31, 9.4]],
    [[19, -15], [27.5, -15], [27.5, -4], [23, -4]],
  ] as Pt[][],

  car: { x: 0.9, z: 1.4, rot: 2.9 },

  trees: [
    { x: -19.8, z: -1.2, kind: 'oak', s: 1.15 },
    { x: 5.4, z: -16.4, kind: 'oak', s: 1.0 },
    { x: -3.8, z: -13.2, kind: 'autumn', s: 0.95 },
    { x: 24.5, z: 6.5, kind: 'autumn', s: 1.05 },
    { x: -27, z: -7.5, kind: 'birch', s: 1.0 },
    { x: -15.2, z: -18.2, kind: 'birch', s: 0.9 },
    { x: -14.5, z: 19.2, kind: 'oak', s: 1.05 },
    { x: 3.5, z: 20.5, kind: 'autumn', s: 0.9 },
    { x: 20.5, z: 18.8, kind: 'oak', s: 1.1 },
    { x: -27, z: 17.5, kind: 'pine', s: 1.0 },
    { x: -26, z: -22.5, kind: 'pine', s: 1.1 },
    { x: -7, z: -22.5, kind: 'pine', s: 0.95 },
    { x: 10, z: -23.4, kind: 'pine', s: 1.05 },
    { x: 27.5, z: -20.5, kind: 'pine', s: 1.0 },
    { x: 29, z: 1.5, kind: 'birch', s: 0.95 },
  ],

  bushes: [
    [-14.3, -10.1, 0.9],
    [-5.9, -10.2, 0.8],
    [8.1, -5.9, 0.85],
    [18.2, -14.2, 0.9],
    [-5.3, 9.1, 0.7],
    [5.8, 8.8, 0.75],
    [-16.4, -9.4, 0.7],
    [26.5, 12.2, 0.8],
    [-24.5, 4.5, 0.85],
    [15.5, 16.5, 0.8],
  ] as [number, number, number][],

  rocks: [
    [-25.9, -11.6, 0.5],
    [-16.2, -14.8, 0.38],
    [-18.5, -9.9, 0.3],
    [-24.2, -16.3, 0.42],
    [-26.5, -14.2, 0.28],
    [4.1, 8.5, 0.35],
    [22, -1.8, 0.4],
    [-29, 5, 0.55],
    [28.5, -9, 0.5],
    [-6, 21.5, 0.45],
  ] as [number, number, number][],

  clothesline: { a: [-4.6, -8.6] as Pt, b: [-0.6, -8.6] as Pt },
  mailbox: { x: -8.1, z: 9.2 },
  lampPost: { x: -4.2, z: 9.3 },
  sign: { x: 8.3, z: 9.3 },

  playerSpawn: { x: -9.6, z: 1.4 },
  zombieSpawns: [
    { x: 9.6, z: -1.6, type: 'shambler' },
    { x: 15.4, z: -2.6, type: 'shambler' },
    { x: 12.4, z: 1.0, type: 'runner' },
    { x: 19.4, z: -5.6, type: 'shambler' },
    { x: 11.2, z: -4.2, type: 'brute' },
  ] as { x: number; z: number; type: 'shambler' | 'runner' | 'brute' }[],
};

export function inPond(x: number, z: number, pad = 0): boolean {
  const p = LAYOUT.pond;
  const dx = (x - p.x) / (p.rx + pad);
  const dz = (z - p.z) / (p.rz + pad);
  return dx * dx + dz * dz < 1;
}

/** Distance from a point to a polyline (XZ). */
export function distToPath(x: number, z: number, pts: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const l2 = dx * dx + dz * dz;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    const qx = ax + dx * t - x;
    const qz = az + dz * t - z;
    best = Math.min(best, Math.hypot(qx, qz));
  }
  return best;
}

/** Where grass/flowers may grow (keeps paths, road, buildings and water clear). */
export function isOpenGround(x: number, z: number, margin = 0): boolean {
  const L = LAYOUT;
  if (Math.abs(z - L.road.z) < L.road.width / 2 + 0.8 + margin) return false;
  for (const p of L.paths) if (distToPath(x, z, p.pts) < p.width / 2 + 0.3 + margin) return false;
  const h = L.house;
  if (Math.abs(x - h.x) < h.w / 2 + 0.7 + margin && Math.abs(z - h.z) < h.d / 2 + 0.7 + margin) return false;
  // porch
  if (Math.abs(x - h.x) < 2.6 + margin && z > h.z + h.d / 2 - 0.2 && z < h.z + h.d / 2 + 2.6 + margin) return false;
  const b = L.barn;
  if (Math.abs(x - b.x) < b.w / 2 + 0.9 + margin && Math.abs(z - b.z) < b.d / 2 + 0.9 + margin) return false;
  if (inPond(x, z, 1.0 + margin)) return false;
  for (const bed of L.beds) {
    if (Math.abs(x - bed.x) < bed.w / 2 + 0.3 && Math.abs(z - bed.z) < bed.d / 2 + 0.3) return false;
  }
  const c = L.car;
  if (Math.hypot(x - c.x, z - c.z) < 3) return false;
  return true;
}
