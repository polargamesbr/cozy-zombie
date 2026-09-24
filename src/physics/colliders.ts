import * as THREE from 'three';

export type Surface =
  | 'grass'
  | 'dirt'
  | 'wood'
  | 'metal'
  | 'stone'
  | 'plant'
  | 'hay'
  | 'water'
  | 'flesh'
  | 'terracotta'
  | 'glass'
  | 'pumpkin'
  | 'road';

/** Something that owns a collider/body and wants to react to hits (fences, crates, the car...). */
export interface HitReceiver {
  /** Bullet hit. `force` is the impulse magnitude, `damage` weapon damage. */
  onBulletHit?(point: THREE.Vector3, normal: THREE.Vector3, dir: THREE.Vector3, damage: number, force: number): void;
  /**
   * A flying body or debris slammed into it. Return true if the thing broke, which lets the
   * incoming object pass through instead of bouncing.
   */
  onImpact?(speed: number, point: THREE.Vector3, dir: THREE.Vector3, mass: number): boolean;
  /** Explosion within range. */
  onBlast?(center: THREE.Vector3, strength: number): void;
}

let nextId = 1;

/**
 * Immovable collider: an oriented box (rotated around Y) or a vertical cylinder, spanning
 * [y0, y1] in height. Ground is the implicit y = 0 plane.
 */
export class StaticCollider {
  readonly id = nextId++;
  enabled = true;
  /** Characters walk on top of it (porch decks, steps) instead of being blocked. */
  walkable = false;
  /** Bullets pass through (e.g. low decorative stuff). */
  ignoreBullets = false;
  /** Low enough to climb over (fences): the nav grid treats it as costly, not blocked. */
  climbable = false;
  cos = 1;
  sin = 0;

  private constructor(
    public kind: 'box' | 'cyl',
    public x: number,
    public z: number,
    public hx: number,
    public hz: number,
    public r: number,
    public y0: number,
    public y1: number,
    public rot: number,
    public surface: Surface,
    public owner: HitReceiver | null,
  ) {
    this.cos = Math.cos(rot);
    this.sin = Math.sin(rot);
  }

  static box(
    x: number,
    z: number,
    hx: number,
    hz: number,
    y1: number,
    rot = 0,
    surface: Surface = 'wood',
    owner: HitReceiver | null = null,
    y0 = 0,
  ): StaticCollider {
    return new StaticCollider('box', x, z, hx, hz, 0, y0, y1, rot, surface, owner);
  }

  static cyl(x: number, z: number, r: number, y1: number, surface: Surface = 'wood', owner: HitReceiver | null = null, y0 = 0): StaticCollider {
    return new StaticCollider('cyl', x, z, r, r, r, y0, y1, 0, surface, owner);
  }

  /** Does the XZ point lie inside the footprint? */
  containsXZ(px: number, pz: number, pad = 0): boolean {
    if (this.kind === 'cyl') return Math.hypot(px - this.x, pz - this.z) < this.r + pad;
    const [lx, lz] = this.toLocal(px, pz);
    return Math.abs(lx) < this.hx + pad && Math.abs(lz) < this.hz + pad;
  }

  /** Radius of a bounding circle in XZ. */
  get boundR(): number {
    return this.kind === 'cyl' ? this.r : Math.hypot(this.hx, this.hz);
  }

  toLocal(px: number, pz: number): [number, number] {
    const dx = px - this.x;
    const dz = pz - this.z;
    return [dx * this.cos - dz * this.sin, dx * this.sin + dz * this.cos];
  }

  dirToWorld(lx: number, lz: number): [number, number] {
    return [lx * this.cos + lz * this.sin, -lx * this.sin + lz * this.cos];
  }

  /**
   * Push a circle out of this collider (XZ only). Returns penetration normal * depth, or null.
   */
  pushCircle(px: number, pz: number, radius: number, out: { x: number; z: number }): boolean {
    if (this.kind === 'cyl') {
      const dx = px - this.x;
      const dz = pz - this.z;
      const d2 = dx * dx + dz * dz;
      const rr = this.r + radius;
      if (d2 >= rr * rr) return false;
      const d = Math.sqrt(d2) || 1e-4;
      out.x = (dx / d) * (rr - d);
      out.z = (dz / d) * (rr - d);
      return true;
    }
    const [lx, lz] = this.toLocal(px, pz);
    const cx = Math.max(-this.hx, Math.min(this.hx, lx));
    const cz = Math.max(-this.hz, Math.min(this.hz, lz));
    let dx = lx - cx;
    let dz = lz - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= radius * radius) return false;
    let nx: number;
    let nz: number;
    let depth: number;
    if (d2 > 1e-10) {
      const d = Math.sqrt(d2);
      nx = dx / d;
      nz = dz / d;
      depth = radius - d;
    } else {
      // center inside the box → leave along the shallowest axis
      const px2 = this.hx - Math.abs(lx);
      const pz2 = this.hz - Math.abs(lz);
      if (px2 < pz2) {
        nx = Math.sign(lx) || 1;
        nz = 0;
        depth = px2 + radius;
      } else {
        nx = 0;
        nz = Math.sign(lz) || 1;
        depth = pz2 + radius;
      }
    }
    [dx, dz] = this.dirToWorld(nx * depth, nz * depth);
    out.x = dx;
    out.z = dz;
    return true;
  }

  /**
   * Sphere vs collider in 3D. Writes the push vector (normal * depth) into `out`.
   */
  pushSphere(p: THREE.Vector3 | { x: number; y: number; z: number }, radius: number, out: THREE.Vector3): boolean {
    if (p.y - radius > this.y1 || p.y + radius < this.y0) return false;
    if (this.kind === 'cyl') {
      const dx = p.x - this.x;
      const dz = p.z - this.z;
      const d2 = dx * dx + dz * dz;
      const rr = this.r + radius;
      if (d2 >= rr * rr) return false;
      const d = Math.sqrt(d2) || 1e-4;
      if (p.y > this.y1) {
        // near the top cap: treat as landing on top if mostly above
        const up = this.y1 + radius - p.y;
        if (d < this.r) {
          out.set(0, up, 0);
          return true;
        }
      }
      const side = rr - d;
      const top = this.y1 + radius - p.y;
      if (top < side && top > 0) {
        out.set(0, top, 0);
        return true;
      }
      out.set((dx / d) * side, 0, (dz / d) * side);
      return true;
    }
    const [lx, lz] = this.toLocal(p.x, p.z);
    const cx = Math.max(-this.hx, Math.min(this.hx, lx));
    const cz = Math.max(-this.hz, Math.min(this.hz, lz));
    const cy = Math.max(this.y0, Math.min(this.y1, p.y));
    const dx = lx - cx;
    const dy = p.y - cy;
    const dz = lz - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= radius * radius) return false;
    let nx: number;
    let ny: number;
    let nz: number;
    let depth: number;
    if (d2 > 1e-10) {
      const d = Math.sqrt(d2);
      nx = dx / d;
      ny = dy / d;
      nz = dz / d;
      depth = radius - d;
    } else {
      const ox = this.hx - Math.abs(lx);
      const oz = this.hz - Math.abs(lz);
      const oy = this.y1 - p.y;
      if (oy < ox && oy < oz) {
        nx = 0;
        ny = 1;
        nz = 0;
        depth = oy + radius;
      } else if (ox < oz) {
        nx = Math.sign(lx) || 1;
        ny = 0;
        nz = 0;
        depth = ox + radius;
      } else {
        nx = 0;
        ny = 0;
        nz = Math.sign(lz) || 1;
        depth = oz + radius;
      }
    }
    const [wx, wz] = this.dirToWorld(nx, nz);
    out.set(wx * depth, ny * depth, wz * depth);
    return true;
  }

  /** Is a point strictly inside (with margin)? Used for sample-point contacts. */
  pointInside(px: number, py: number, pz: number, out: THREE.Vector3): number {
    if (py > this.y1 || py < this.y0) return -1;
    if (this.kind === 'cyl') {
      const dx = px - this.x;
      const dz = pz - this.z;
      const d = Math.hypot(dx, dz);
      if (d >= this.r) return -1;
      const side = this.r - d;
      const top = this.y1 - py;
      if (top < side) {
        out.set(0, 1, 0);
        return top;
      }
      out.set(dx / (d || 1), 0, dz / (d || 1));
      return side;
    }
    const [lx, lz] = this.toLocal(px, pz);
    if (Math.abs(lx) >= this.hx || Math.abs(lz) >= this.hz) return -1;
    const ox = this.hx - Math.abs(lx);
    const oz = this.hz - Math.abs(lz);
    const oy = this.y1 - py;
    if (oy < ox && oy < oz) {
      out.set(0, 1, 0);
      return oy;
    }
    if (ox < oz) {
      const [wx, wz] = this.dirToWorld(Math.sign(lx) || 1, 0);
      out.set(wx, 0, wz);
      return ox;
    }
    const [wx, wz] = this.dirToWorld(0, Math.sign(lz) || 1);
    out.set(wx, 0, wz);
    return oz;
  }

  /** Ray test. Returns distance or -1, writes the surface normal. */
  raycast(o: THREE.Vector3, d: THREE.Vector3, maxT: number, normal: THREE.Vector3): number {
    if (this.kind === 'cyl') return rayVerticalCylinder(o, d, this.x, this.z, this.r, this.y0, this.y1, maxT, normal);
    const [olx, olz] = this.toLocal(o.x, o.z);
    const dlx = d.x * this.cos - d.z * this.sin;
    const dlz = d.x * this.sin + d.z * this.cos;
    const t = rayAabb(olx, o.y, olz, dlx, d.y, dlz, -this.hx, this.y0, -this.hz, this.hx, this.y1, this.hz, maxT, normal);
    if (t >= 0) {
      const [wx, wz] = this.dirToWorld(normal.x, normal.z);
      normal.set(wx, normal.y, wz);
    }
    return t;
  }
}

/** Slab ray/AABB test, returns entry distance (or -1) and entry normal. */
export function rayAabb(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  maxT: number,
  normal: THREE.Vector3,
): number {
  let tmin = 0;
  let tmax = maxT;
  let axis = -1;
  let sgn = 0;
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  const mn = [minX, minY, minZ];
  const mx = [maxX, maxY, maxZ];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < mn[i] || o[i] > mx[i]) return -1;
      continue;
    }
    const inv = 1 / d[i];
    let t1 = (mn[i] - o[i]) * inv;
    let t2 = (mx[i] - o[i]) * inv;
    let s = -1;
    if (t1 > t2) {
      const tt = t1;
      t1 = t2;
      t2 = tt;
      s = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      axis = i;
      sgn = s;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  if (axis < 0) {
    // origin inside
    normal.set(-dx, -dy, -dz).normalize();
    return 0;
  }
  normal.set(0, 0, 0);
  if (axis === 0) normal.x = sgn;
  else if (axis === 1) normal.y = sgn;
  else normal.z = sgn;
  return tmin;
}

export function rayVerticalCylinder(
  o: THREE.Vector3,
  d: THREE.Vector3,
  cx: number,
  cz: number,
  r: number,
  y0: number,
  y1: number,
  maxT: number,
  normal: THREE.Vector3,
): number {
  const ox = o.x - cx;
  const oz = o.z - cz;
  const a = d.x * d.x + d.z * d.z;
  let best = -1;
  if (a > 1e-9) {
    const b = 2 * (ox * d.x + oz * d.z);
    const c = ox * ox + oz * oz - r * r;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      if (t >= 0 && t <= maxT) {
        const y = o.y + d.y * t;
        if (y >= y0 && y <= y1) {
          best = t;
          normal.set((ox + d.x * t) / r, 0, (oz + d.z * t) / r);
        }
      }
    }
  }
  // top cap
  if (Math.abs(d.y) > 1e-9 && d.y < 0) {
    const t = (y1 - o.y) / d.y;
    if (t >= 0 && t <= maxT && (best < 0 || t < best)) {
      const x = ox + d.x * t;
      const z = oz + d.z * t;
      if (x * x + z * z <= r * r) {
        best = t;
        normal.set(0, 1, 0);
      }
    }
  }
  return best;
}

export function raySphere(o: THREE.Vector3, d: THREE.Vector3, c: THREE.Vector3 | { x: number; y: number; z: number }, r: number, maxT: number): number {
  const ox = o.x - c.x;
  const oy = o.y - c.y;
  const oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  if (cc > 0 && b > 0) return -1;
  const disc = b * b - cc;
  if (disc < 0) return -1;
  let t = -b - Math.sqrt(disc);
  if (t < 0) t = 0;
  return t <= maxT ? t : -1;
}
