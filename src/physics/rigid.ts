import * as THREE from 'three';
import type { HitReceiver, StaticCollider, Surface } from './colliders';

export type Shape =
  | { type: 'box'; hx: number; hy: number; hz: number }
  | { type: 'cyl'; r: number; hh: number }
  | { type: 'sphere'; r: number };

export interface BodyOwner extends HitReceiver {
  /** Called when the body slams into something hard (ground, wall, another body). */
  onBodyImpact?(speed: number, point: THREE.Vector3): void;
}

interface Contact {
  px: number;
  py: number;
  pz: number;
  nx: number;
  ny: number;
  nz: number;
  pen: number;
  collider: StaticCollider | null;
}

const _r = new THREE.Vector3();
const _v = new THREE.Vector3();
const _t = new THREE.Vector3();
const _n = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _qc = new THREE.Quaternion();
const _wq = new THREE.Quaternion();
const _push = new THREE.Vector3();

let nextBodyId = 1;

/**
 * Small impulse-based rigid body for props (crates, barrels, cans, pots, chairs...).
 * Contacts come from sample points (box corners, analytic cylinder rims) against the ground
 * plane and static colliders. Not a general physics engine – just enough to tumble, roll and
 * settle convincingly.
 */
export class RigidBody {
  readonly id = nextBodyId++;
  readonly pos = new THREE.Vector3();
  readonly quat = new THREE.Quaternion();
  readonly vel = new THREE.Vector3();
  readonly angVel = new THREE.Vector3();
  readonly invInertia = new THREE.Vector3();
  mass: number;
  invMass: number;
  restitution = 0.28;
  friction = 0.6;
  radius: number;
  contactRadius: number;
  sleeping = false;
  sleepTimer = 0;
  grounded = false;
  removed = false;
  /** Visual object synced every frame. Its origin must be the body's center of mass. */
  object: THREE.Object3D | null = null;
  owner: BodyOwner | null = null;
  surface: Surface;
  /** Height of the lowest point last step (for FX). */
  private localPoints: THREE.Vector3[] = [];
  private contacts: Contact[] = [];
  lastImpactTime = 0;

  constructor(
    public shape: Shape,
    mass: number,
    surface: Surface = 'wood',
  ) {
    this.mass = mass;
    this.invMass = 1 / mass;
    this.surface = surface;
    if (shape.type === 'box') {
      const w = shape.hx * 2;
      const h = shape.hy * 2;
      const d = shape.hz * 2;
      this.invInertia.set(12 / (mass * (h * h + d * d)), 12 / (mass * (w * w + d * d)), 12 / (mass * (w * w + h * h)));
      this.radius = Math.hypot(shape.hx, shape.hy, shape.hz);
      this.contactRadius = (shape.hx + shape.hy + shape.hz) / 3;
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) this.localPoints.push(new THREE.Vector3(sx * shape.hx, sy * shape.hy, sz * shape.hz));
    } else if (shape.type === 'cyl') {
      const r = shape.r;
      const h = shape.hh * 2;
      const iy = (mass * r * r) / 2;
      const ix = (mass * (3 * r * r + h * h)) / 12;
      this.invInertia.set(1 / ix, 1 / iy, 1 / ix);
      this.radius = Math.hypot(r, shape.hh);
      this.contactRadius = Math.max(r, shape.hh * 0.8);
      for (const sy of [-1, 1]) {
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          this.localPoints.push(new THREE.Vector3(Math.cos(a) * r, sy * shape.hh, Math.sin(a) * r));
        }
      }
    } else {
      const i = (2 / 5) * mass * shape.r * shape.r;
      this.invInertia.set(1 / i, 1 / i, 1 / i);
      this.radius = shape.r;
      this.contactRadius = shape.r;
    }
  }

  /** Height of the body's lowest point above its center when resting in its current orientation. */
  wake(): void {
    this.sleeping = false;
    this.sleepTimer = 0;
  }

  applyInvInertiaWorld(v: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    _qc.copy(this.quat).invert();
    out.copy(v).applyQuaternion(_qc).multiply(this.invInertia).applyQuaternion(this.quat);
    return out;
  }

  /** Apply an impulse at a world point. */
  applyImpulse(impulse: THREE.Vector3, point?: THREE.Vector3): void {
    this.wake();
    this.vel.addScaledVector(impulse, this.invMass);
    if (point) {
      _r.subVectors(point, this.pos);
      _a.crossVectors(_r, impulse);
      this.applyInvInertiaWorld(_a, _b);
      this.angVel.add(_b);
    }
  }

  /** Point velocity. */
  velocityAt(point: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    _r.subVectors(point, this.pos);
    return out.crossVectors(this.angVel, _r).add(this.vel);
  }

  private gatherContacts(statics: readonly StaticCollider[]): void {
    const cs = this.contacts;
    cs.length = 0;
    const s = this.shape;
    // ---- ground
    if (s.type === 'sphere') {
      const pen = s.r - this.pos.y;
      if (pen > -0.005) cs.push({ px: this.pos.x, py: this.pos.y - s.r, pz: this.pos.z, nx: 0, ny: 1, nz: 0, pen, collider: null });
    } else if (s.type === 'cyl') {
      const axis = _a.set(0, 1, 0).applyQuaternion(this.quat);
      const ay = axis.y;
      for (const sgn of [-1, 1]) {
        const cx = this.pos.x + axis.x * s.hh * sgn;
        const cy = this.pos.y + axis.y * s.hh * sgn;
        const cz = this.pos.z + axis.z * s.hh * sgn;
        if (Math.abs(ay) > 0.985) {
          // upright: four rim points
          for (let i = 0; i < 4; i++) {
            const ang = (i / 4) * Math.PI * 2;
            _t.set(Math.cos(ang) * s.r, 0, Math.sin(ang) * s.r).applyQuaternion(this.quat);
            const py = cy + _t.y;
            if (py < 0.005) cs.push({ px: cx + _t.x, py, pz: cz + _t.z, nx: 0, ny: 1, nz: 0, pen: -py, collider: null });
          }
        } else {
          // lowest point of the rim circle: direction of -Y projected on the rim plane
          _t.set(axis.x * ay, ay * ay - 1, axis.z * ay);
          const l = _t.length();
          if (l > 1e-6) _t.multiplyScalar(s.r / l);
          const py = cy + _t.y;
          if (py < 0.005) cs.push({ px: cx + _t.x, py, pz: cz + _t.z, nx: 0, ny: 1, nz: 0, pen: -py, collider: null });
        }
      }
    } else {
      for (const lp of this.localPoints) {
        _t.copy(lp).applyQuaternion(this.quat).add(this.pos);
        if (_t.y < 0.005) cs.push({ px: _t.x, py: _t.y, pz: _t.z, nx: 0, ny: 1, nz: 0, pen: -_t.y, collider: null });
      }
    }
    // ---- statics (sample points + center sphere)
    for (const c of statics) {
      if (!c.enabled) continue;
      const dx = this.pos.x - c.x;
      const dz = this.pos.z - c.z;
      const br = c.boundR + this.radius;
      if (dx * dx + dz * dz > br * br) continue;
      if (this.pos.y - this.radius > c.y1 || this.pos.y + this.radius < c.y0) continue;
      if (s.type === 'sphere') {
        if (c.pushSphere(this.pos, s.r, _push)) {
          const d = _push.length();
          _n.copy(_push).divideScalar(d || 1);
          cs.push({ px: this.pos.x - _n.x * s.r, py: this.pos.y - _n.y * s.r, pz: this.pos.z - _n.z * s.r, nx: _n.x, ny: _n.y, nz: _n.z, pen: d, collider: c });
        }
        continue;
      }
      let found = false;
      for (const lp of this.localPoints) {
        _t.copy(lp).applyQuaternion(this.quat).add(this.pos);
        const pen = c.pointInside(_t.x, _t.y, _t.z, _n);
        if (pen >= 0) {
          cs.push({ px: _t.x, py: _t.y, pz: _t.z, nx: _n.x, ny: _n.y, nz: _n.z, pen, collider: c });
          found = true;
        }
      }
      if (!found && c.pushSphere(this.pos, this.contactRadius, _push)) {
        const d = _push.length();
        _n.copy(_push).divideScalar(d || 1);
        cs.push({
          px: this.pos.x - _n.x * this.contactRadius,
          py: this.pos.y - _n.y * this.contactRadius,
          pz: this.pos.z - _n.z * this.contactRadius,
          nx: _n.x,
          ny: _n.y,
          nz: _n.z,
          pen: d,
          collider: c,
        });
      }
    }
  }

  step(dt: number, gravity: number, statics: readonly StaticCollider[], time: number): void {
    if (this.sleeping || this.removed) return;
    this.vel.y += gravity * dt;
    // air drag
    this.vel.multiplyScalar(1 / (1 + dt * 0.08));
    this.angVel.multiplyScalar(1 / (1 + dt * 0.25));

    this.gatherContacts(statics);
    const cs = this.contacts;
    this.grounded = false;
    let maxImpact = 0;
    let impactPoint: Contact | null = null;
    let breakTarget: StaticCollider | null = null;

    // pre-pass: measure approach speeds for impact FX/breaking before resolving
    for (const c of cs) {
      _t.set(c.px, c.py, c.pz);
      this.velocityAt(_t, _v);
      const vn = -(_v.x * c.nx + _v.y * c.ny + _v.z * c.nz);
      if (vn > maxImpact) {
        maxImpact = vn;
        impactPoint = c;
      }
      if (c.collider?.owner?.onImpact && vn > 5 && !breakTarget) breakTarget = c.collider;
    }
    if (breakTarget && breakTarget.owner?.onImpact) {
      _t.set(this.pos.x, this.pos.y, this.pos.z);
      _v.copy(this.vel).normalize();
      if (breakTarget.owner.onImpact(this.vel.length(), _t, _v, this.mass)) {
        // it broke: drop those contacts and lose some speed
        for (let i = cs.length - 1; i >= 0; i--) if (cs[i].collider === breakTarget) cs.splice(i, 1);
        this.vel.multiplyScalar(0.7);
      }
    }

    for (let iter = 0; iter < 4; iter++) {
      for (const c of cs) {
        _t.set(c.px, c.py, c.pz);
        _n.set(c.nx, c.ny, c.nz);
        _r.subVectors(_t, this.pos);
        this.velocityAt(_t, _v);
        const vn = _v.dot(_n);
        if (vn >= 0) continue;
        if (c.ny > 0.5) this.grounded = true;
        // effective mass along normal
        _a.crossVectors(_r, _n);
        this.applyInvInertiaWorld(_a, _b);
        _a.crossVectors(_b, _r);
        const k = this.invMass + _n.dot(_a);
        const e = iter === 0 && vn < -1.6 ? this.restitution : 0;
        const j = (-(1 + e) * vn) / k;
        _a.copy(_n).multiplyScalar(j);
        this.vel.addScaledVector(_a, this.invMass);
        _b.crossVectors(_r, _a);
        this.applyInvInertiaWorld(_b, _b);
        this.angVel.add(_b);
        // friction
        this.velocityAt(_t, _v);
        const vn2 = _v.dot(_n);
        _v.addScaledVector(_n, -vn2);
        const vt = _v.length();
        if (vt > 1e-5) {
          _v.divideScalar(vt);
          _a.crossVectors(_r, _v);
          this.applyInvInertiaWorld(_a, _b);
          _a.crossVectors(_b, _r);
          const kt = this.invMass + _v.dot(_a);
          const jt = Math.min(vt / kt, this.friction * j);
          _a.copy(_v).multiplyScalar(-jt);
          this.vel.addScaledVector(_a, this.invMass);
          _b.crossVectors(_r, _a);
          this.applyInvInertiaWorld(_b, _b);
          this.angVel.add(_b);
        }
      }
    }

    // integrate
    this.pos.addScaledVector(this.vel, dt);
    _wq.set(this.angVel.x * dt * 0.5, this.angVel.y * dt * 0.5, this.angVel.z * dt * 0.5, 0);
    _wq.multiply(this.quat);
    this.quat.x += _wq.x;
    this.quat.y += _wq.y;
    this.quat.z += _wq.z;
    this.quat.w += _wq.w;
    this.quat.normalize();

    // positional correction: ground by the deepest point, statics individually
    let groundPen = 0;
    for (const c of cs) if (c.collider === null && c.pen > groundPen) groundPen = c.pen;
    if (groundPen > 0.002) this.pos.y += (groundPen - 0.002) * 0.85;
    const seen = new Set<StaticCollider>();
    for (const c of cs) {
      if (!c.collider || seen.has(c.collider)) continue;
      seen.add(c.collider);
      let best = 0;
      for (const c2 of cs) if (c2.collider === c.collider && c2.pen > best) best = c2.pen;
      if (best > 0.002) {
        this.pos.x += c.nx * (best - 0.002) * 0.8;
        this.pos.y += c.ny * (best - 0.002) * 0.8;
        this.pos.z += c.nz * (best - 0.002) * 0.8;
      }
    }
    if (this.pos.y < -2) this.pos.y = this.radius; // safety

    if (this.grounded && this.shape.type !== 'box') {
      // rolling resistance
      this.angVel.multiplyScalar(1 / (1 + dt * 1.2));
      this.vel.x /= 1 + dt * 0.6;
      this.vel.z /= 1 + dt * 0.6;
    }

    if (maxImpact > 1.8 && impactPoint && time - this.lastImpactTime > 0.08) {
      this.lastImpactTime = time;
      _t.set(impactPoint.px, impactPoint.py, impactPoint.pz);
      this.owner?.onBodyImpact?.(maxImpact, _t);
    }

    // sleep
    if (this.grounded && this.vel.lengthSq() < 0.02 && this.angVel.lengthSq() < 0.05) {
      this.sleepTimer += dt;
      if (this.sleepTimer > 0.5) {
        this.sleeping = true;
        this.vel.set(0, 0, 0);
        this.angVel.set(0, 0, 0);
      }
    } else this.sleepTimer = 0;
  }

  sync(): void {
    if (!this.object) return;
    this.object.position.copy(this.pos);
    this.object.quaternion.copy(this.quat);
  }
}

/** Resolve overlap between two bodies using their contact spheres. */
export function collideBodies(a: RigidBody, b: RigidBody): void {
  if (a.removed || b.removed) return;
  if (a.sleeping && b.sleeping) return;
  const dx = b.pos.x - a.pos.x;
  const dy = b.pos.y - a.pos.y;
  const dz = b.pos.z - a.pos.z;
  const rr = a.contactRadius + b.contactRadius;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= rr * rr || d2 < 1e-10) return;
  const d = Math.sqrt(d2);
  const nx = dx / d;
  const ny = dy / d;
  const nz = dz / d;
  const pen = rr - d;
  const wa = a.invMass / (a.invMass + b.invMass);
  const wb = 1 - wa;
  a.pos.x -= nx * pen * wa;
  a.pos.y -= ny * pen * wa;
  a.pos.z -= nz * pen * wa;
  b.pos.x += nx * pen * wb;
  b.pos.y += ny * pen * wb;
  b.pos.z += nz * pen * wb;
  const rv = (b.vel.x - a.vel.x) * nx + (b.vel.y - a.vel.y) * ny + (b.vel.z - a.vel.z) * nz;
  if (rv < 0) {
    const j = (-(1 + 0.3) * rv) / (a.invMass + b.invMass);
    _n.set(nx, ny, nz);
    const cp = new THREE.Vector3(a.pos.x + nx * a.contactRadius, a.pos.y + ny * a.contactRadius, a.pos.z + nz * a.contactRadius);
    a.applyImpulse(_n.clone().multiplyScalar(-j), cp);
    b.applyImpulse(_n.clone().multiplyScalar(j), cp);
  } else if (pen > 0.01) {
    a.wake();
    b.wake();
  }
}
