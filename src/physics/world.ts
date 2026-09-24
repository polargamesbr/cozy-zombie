import * as THREE from 'three';
import { raySphere, StaticCollider, type Surface } from './colliders';
import { collideBodies, RigidBody } from './rigid';
import { Ragdoll, type CharacterProxy } from './ragdoll';

export const GRAVITY = -21;
export const PHYS_DT = 1 / 120;

/** A living character's hit volume (vertical capsule + head sphere) used by raycasts. */
export interface CharacterBody extends CharacterProxy {
  alive: boolean;
  headY: number;
  headR: number;
  /** body height used for raycast (capsule top) */
  owner: unknown;
  team: 'player' | 'zombie';
}

export type HitKind = 'ground' | 'static' | 'body' | 'ragdoll' | 'character';

export interface RayHit {
  kind: HitKind;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  surface: Surface;
  collider?: StaticCollider;
  body?: RigidBody;
  ragdoll?: Ragdoll;
  particle?: number;
  character?: CharacterBody;
  headshot?: boolean;
}

const _n = new THREE.Vector3();
const _c = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();

export class PhysicsWorld {
  /** Water depth under a point (the pond), used by ragdolls to float and sink. */
  water: ((x: number, z: number) => number) | null = null;
  statics: StaticCollider[] = [];
  bodies: RigidBody[] = [];
  ragdolls: Ragdoll[] = [];
  characters: CharacterBody[] = [];
  time = 0;
  private accumulator = 0;

  addStatic(c: StaticCollider): StaticCollider {
    this.statics.push(c);
    return c;
  }

  removeStatic(c: StaticCollider): void {
    c.enabled = false;
    const i = this.statics.indexOf(c);
    if (i >= 0) this.statics.splice(i, 1);
  }

  addBody(b: RigidBody): RigidBody {
    this.bodies.push(b);
    return b;
  }

  removeBody(b: RigidBody): void {
    b.removed = true;
    const i = this.bodies.indexOf(b);
    if (i >= 0) this.bodies.splice(i, 1);
  }

  addRagdoll(r: Ragdoll): Ragdoll {
    r.water = this.water;
    this.ragdolls.push(r);
    return r;
  }

  removeRagdoll(r: Ragdoll): void {
    r.removed = true;
    const i = this.ragdolls.indexOf(r);
    if (i >= 0) this.ragdolls.splice(i, 1);
  }

  /** Advance with a fixed internal step. Returns the number of substeps taken. */
  update(dt: number, onSubstep?: (h: number) => void): number {
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= PHYS_DT && steps < 8) {
      this.accumulator -= PHYS_DT;
      this.substep(PHYS_DT);
      onSubstep?.(PHYS_DT);
      steps++;
    }
    if (steps === 8) this.accumulator = 0;
    return steps;
  }

  private substep(h: number): void {
    this.time += h;
    const alive = this.characters.filter((c) => c.alive);
    for (const b of this.bodies) b.step(h, GRAVITY, this.statics, this.time);
    for (let i = 0; i < this.bodies.length; i++) {
      for (let j = i + 1; j < this.bodies.length; j++) collideBodies(this.bodies[i], this.bodies[j]);
    }
    // characters shove props around
    for (const ch of alive) {
      for (const b of this.bodies) {
        if (b.pos.y - b.radius > ch.height) continue;
        const dx = b.pos.x - ch.x;
        const dz = b.pos.z - ch.z;
        const rr = ch.radius + b.contactRadius * 0.95;
        const d2 = dx * dx + dz * dz;
        if (d2 >= rr * rr) continue;
        const d = Math.sqrt(d2) || 1e-4;
        const nx = dx / d;
        const nz = dz / d;
        const pen = rr - d;
        const heavy = b.mass > 40;
        if (!heavy) {
          b.pos.x += nx * pen * 0.7;
          b.pos.z += nz * pen * 0.7;
        }
        ch.x -= nx * pen * (heavy ? 1 : 0.3);
        ch.z -= nz * pen * (heavy ? 1 : 0.3);
        const along = ch.vx * nx + ch.vz * nz;
        if (!heavy && along > 0.2) {
          _d.set(nx, 0.15, nz).multiplyScalar(along * Math.min(b.mass, 8) * 0.06);
          _c.set(b.pos.x - nx * b.contactRadius, b.pos.y + 0.05, b.pos.z - nz * b.contactRadius);
          b.applyImpulse(_d, _c);
        }
      }
    }
    for (const r of this.ragdolls) r.step(h, GRAVITY, this.statics, this.bodies, alive);
    for (let i = 0; i < this.ragdolls.length; i++) {
      for (let j = i + 1; j < this.ragdolls.length; j++) {
        const a = this.ragdolls[i];
        const b = this.ragdolls[j];
        a.center(_c);
        b.center(_o);
        if (_c.distanceToSquared(_o) < 2.6) Ragdoll.collidePair(a, b);
      }
    }
  }

  /** Push a character circle out of static geometry. Returns true if it collided. */
  resolveCharacter(ch: { x: number; z: number; radius: number }, height = 1.2): boolean {
    let hit = false;
    const out = { x: 0, z: 0 };
    for (let iter = 0; iter < 2; iter++) {
      for (const c of this.statics) {
        if (!c.enabled || c.walkable || c.y0 > height || c.y1 < 0.25) continue;
        const dx = ch.x - c.x;
        const dz = ch.z - c.z;
        const br = c.boundR + ch.radius;
        if (dx * dx + dz * dz > br * br) continue;
        if (c.pushCircle(ch.x, ch.z, ch.radius, out)) {
          ch.x += out.x;
          ch.z += out.z;
          hit = true;
        }
      }
    }
    return hit;
  }

  /** An enabled climbable collider (fence) covering this point, if any. */
  climbableAt(x: number, z: number, pad = 0.1): StaticCollider | null {
    for (const c of this.statics) {
      if (c.enabled && c.climbable && c.containsXZ(x, z, pad)) return c;
    }
    return null;
  }

  /** Height of walkable surfaces (porch, steps) under a point; 0 on open ground. */
  heightAt(x: number, z: number): number {
    let h = 0;
    for (const c of this.statics) {
      if (!c.enabled || !c.walkable) continue;
      if (c.y1 > h && c.containsXZ(x, z)) h = c.y1;
    }
    return h;
  }

  /** Is the straight XZ segment clear of tall static geometry? (line of sight / steering) */
  segmentClear(ax: number, az: number, bx: number, bz: number, y = 0.8, pad = 0): boolean {
    _o.set(ax, y, az);
    _d.set(bx - ax, 0, bz - az);
    const len = _d.length();
    if (len < 1e-4) return true;
    _d.divideScalar(len);
    for (const c of this.statics) {
      if (!c.enabled || c.walkable || c.y1 < y || c.y0 > y) continue;
      if (pad > 0) {
        const grown = c.kind === 'cyl'
          ? StaticCollider.cyl(c.x, c.z, c.r + pad, c.y1, c.surface, null, c.y0)
          : StaticCollider.box(c.x, c.z, c.hx + pad, c.hz + pad, c.y1, c.rot, c.surface, null, c.y0);
        if (grown.raycast(_o, _d, len, _n) >= 0) return false;
      } else if (c.raycast(_o, _d, len, _n) >= 0) return false;
    }
    return true;
  }

  /**
   * Bullet raycast against everything. `ignore` skips a character (the shooter).
   */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, ignore?: CharacterBody | null): RayHit | null {
    let best: RayHit | null = null;
    let bestT = maxDist;
    // ground
    if (dir.y < -1e-5) {
      const t = -origin.y / dir.y;
      if (t >= 0 && t < bestT) {
        bestT = t;
        best = {
          kind: 'ground',
          point: origin.clone().addScaledVector(dir, t),
          normal: new THREE.Vector3(0, 1, 0),
          distance: t,
          surface: 'grass',
        };
      }
    }
    for (const c of this.statics) {
      if (!c.enabled || c.ignoreBullets) continue;
      const t = c.raycast(origin, dir, bestT, _n);
      if (t >= 0 && t < bestT) {
        bestT = t;
        best = { kind: 'static', point: origin.clone().addScaledVector(dir, t), normal: _n.clone(), distance: t, surface: c.surface, collider: c };
      }
    }
    for (const b of this.bodies) {
      if (b.removed) continue;
      const tb = raySphere(origin, dir, b.pos, b.radius, bestT);
      if (tb < 0) continue;
      let t = -1;
      if (b.shape.type === 'box') {
        _q.copy(b.quat).invert();
        _o.copy(origin).sub(b.pos).applyQuaternion(_q);
        _d.copy(dir).applyQuaternion(_q);
        const s = b.shape;
        t = rayAabbLocal(_o, _d, s.hx, s.hy, s.hz, bestT, _n);
        if (t >= 0) _n.applyQuaternion(b.quat);
      } else {
        const r = b.contactRadius;
        t = raySphere(origin, dir, b.pos, r, bestT);
        if (t >= 0) _n.copy(origin).addScaledVector(dir, t).sub(b.pos).normalize();
      }
      if (t >= 0 && t < bestT) {
        bestT = t;
        best = { kind: 'body', point: origin.clone().addScaledVector(dir, t), normal: _n.clone(), distance: t, surface: b.surface, body: b };
      }
    }
    for (const r of this.ragdolls) {
      if (r.removed) continue;
      for (let i = 0; i < r.n; i++) {
        _c.set(r.p[i * 3], r.p[i * 3 + 1], r.p[i * 3 + 2]);
        const t = raySphere(origin, dir, _c, r.r[i] * 1.35 + 0.05, bestT);
        if (t >= 0 && t < bestT) {
          bestT = t;
          const pt = origin.clone().addScaledVector(dir, t);
          best = { kind: 'ragdoll', point: pt, normal: pt.clone().sub(_c).normalize(), distance: t, surface: 'flesh', ragdoll: r, particle: i };
        }
      }
    }
    for (const ch of this.characters) {
      if (!ch.alive || ch === ignore) continue;
      // head sphere
      _c.set(ch.x, ch.headY, ch.z);
      let t = raySphere(origin, dir, _c, ch.headR, bestT);
      let head = t >= 0;
      // body: vertical cylinder
      const tb = rayCapsuleY(origin, dir, ch.x, ch.z, ch.radius, 0.05, ch.headY - ch.headR * 0.5, bestT, _n);
      if (tb >= 0 && (t < 0 || tb < t)) {
        t = tb;
        head = false;
      }
      if (t >= 0 && t < bestT) {
        bestT = t;
        const pt = origin.clone().addScaledVector(dir, t);
        const nrm = head ? pt.clone().sub(_c).normalize() : new THREE.Vector3(pt.x - ch.x, 0, pt.z - ch.z).normalize();
        best = { kind: 'character', point: pt, normal: nrm, distance: t, surface: 'flesh', character: ch, headshot: head };
      }
    }
    return best;
  }

  /** Radial impulse on bodies and ragdolls. Characters are handled by gameplay code. */
  blast(center: THREE.Vector3, radius: number, strength: number): void {
    for (const b of this.bodies) {
      const d = b.pos.distanceTo(center);
      if (d > radius) continue;
      const k = 1 - d / radius;
      _d.subVectors(b.pos, center).normalize();
      _d.y = Math.max(_d.y, 0.35) + 0.5;
      _d.normalize().multiplyScalar(strength * k * Math.min(b.mass, 25) * 0.7);
      _c.copy(b.pos).addScaledVector(_d.clone().normalize(), -b.contactRadius * 0.5);
      _c.y -= b.contactRadius * 0.3;
      b.applyImpulse(_d, _c);
    }
    for (const r of this.ragdolls) {
      r.center(_c);
      const d = _c.distanceTo(center);
      if (d > radius) continue;
      const k = 1 - d / radius;
      for (let i = 0; i < r.n; i++) {
        _o.set(r.p[i * 3], r.p[i * 3 + 1], r.p[i * 3 + 2]);
        _d.subVectors(_o, center);
        _d.y = Math.max(_d.y, 0.3) + 0.6;
        _d.normalize().multiplyScalar(strength * k * 0.5 * (0.85 + Math.random() * 0.3));
        r.addVelocity(i, _d.x, _d.y, _d.z);
      }
    }
  }
}

function rayAabbLocal(o: THREE.Vector3, d: THREE.Vector3, hx: number, hy: number, hz: number, maxT: number, n: THREE.Vector3): number {
  let tmin = 0;
  let tmax = maxT;
  let axis = -1;
  let sgn = 0;
  const oo = [o.x, o.y, o.z];
  const dd = [d.x, d.y, d.z];
  const hh = [hx, hy, hz];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(dd[i]) < 1e-9) {
      if (Math.abs(oo[i]) > hh[i]) return -1;
      continue;
    }
    const inv = 1 / dd[i];
    let t1 = (-hh[i] - oo[i]) * inv;
    let t2 = (hh[i] - oo[i]) * inv;
    let s = -1;
    if (t1 > t2) {
      const t = t1;
      t1 = t2;
      t2 = t;
      s = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      axis = i;
      sgn = s;
    }
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  n.set(0, 0, 0);
  if (axis === 0) n.x = sgn;
  else if (axis === 1) n.y = sgn;
  else if (axis === 2) n.z = sgn;
  else n.set(-d.x, -d.y, -d.z);
  return tmin;
}

/** Ray vs vertical capsule-ish cylinder (flat caps are fine for bullets). */
function rayCapsuleY(o: THREE.Vector3, d: THREE.Vector3, cx: number, cz: number, r: number, y0: number, y1: number, maxT: number, n: THREE.Vector3): number {
  const ox = o.x - cx;
  const oz = o.z - cz;
  const a = d.x * d.x + d.z * d.z;
  if (a < 1e-9) return -1;
  const b = 2 * (ox * d.x + oz * d.z);
  const c = ox * ox + oz * oz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  let t = (-b - Math.sqrt(disc)) / (2 * a);
  if (t < 0) {
    if (c < 0) t = 0;
    else return -1;
  }
  if (t > maxT) return -1;
  const y = o.y + d.y * t;
  if (y < y0 || y > y1) return -1;
  n.set(ox + d.x * t, 0, oz + d.z * t).normalize();
  return t;
}
