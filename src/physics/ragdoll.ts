import * as THREE from 'three';
import type { StaticCollider } from './colliders';
import type { RigidBody } from './rigid';

/** Joint indices of the chibi humanoid ragdoll. */
export const J = {
  head: 0,
  shoulderL: 1,
  shoulderR: 2,
  hipL: 3,
  hipR: 4,
  handL: 5,
  handR: 6,
  footL: 7,
  footR: 8,
} as const;
export const JOINT_COUNT = 9;
/** Height of the pond surface. */
export const WATER_Y = 0.05;

export interface Link {
  a: number;
  b: number;
  min: number;
  max: number;
  /** stiffness 0..1 per iteration */
  k: number;
}

export interface RagdollImpact {
  index: number;
  speed: number;
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  kind: 'ground' | 'static' | 'body' | 'character';
  collider: StaticCollider | null;
}

export interface CharacterProxy {
  x: number;
  z: number;
  radius: number;
  height: number;
  vx: number;
  vz: number;
  mass: number;
  onRagdollHit?(speed: number, dir: THREE.Vector3, mass: number): void;
}

const _push = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _dir = new THREE.Vector3();

/**
 * Verlet-particle ragdoll (Jakobsen style). 9 particles for a chibi body: a rigid torso quad,
 * a head hinged on the shoulders and single-segment limbs. Cheap, stable and very floppy in
 * a fun way. The owner reads particle positions to pose the character's parts.
 */
export class Ragdoll {
  readonly n: number;
  readonly p: Float32Array;
  readonly o: Float32Array;
  readonly pre: Float32Array;
  readonly r: Float32Array;
  readonly w: Float32Array;
  readonly contact: Uint8Array;
  readonly cn: Float32Array;
  readonly contactCollider: (StaticCollider | null)[];
  links: Link[] = [];
  sleeping = false;
  private stillTime = 0;
  dt = 1 / 120;
  groundFriction = 0.11;
  restitution = 0.14;
  impacts: RagdollImpact[] = [];
  /** Hit characters recently (avoid multi-hits). */
  private charHitCooldown = new Map<CharacterProxy, number>();
  time = 0;
  totalMass = 0;
  headDetached = false;
  removed = false;
  /** Stop colliding with a specific collider for a moment (after breaking it). */
  private ignoreCollider: StaticCollider | null = null;
  private ignoreTimer = 0;
  breakSpeed = 6.5;
  /** Gameplay object this ragdoll belongs to (a Zombie or the Player). */
  owner: unknown = null;
  /** Water depth under a point (0 = dry land). Water surface is at WATER_Y. */
  water: ((x: number, z: number) => number) | null = null;
  /** 1 = floats, 0 = sinks like a stone (bodies sink after a while). */
  buoyancy = 1;
  /** Particles currently (partly) under water. */
  submerged = 0;

  constructor(radii: number[], masses: number[]) {
    this.n = radii.length;
    this.p = new Float32Array(this.n * 3);
    this.o = new Float32Array(this.n * 3);
    this.pre = new Float32Array(this.n * 3);
    this.r = new Float32Array(radii);
    this.w = new Float32Array(masses.map((m) => (m > 0 ? 1 / m : 0)));
    this.contact = new Uint8Array(this.n);
    this.cn = new Float32Array(this.n * 3);
    this.contactCollider = new Array(this.n).fill(null);
    this.totalMass = masses.reduce((a, b) => a + b, 0);
  }

  setPositions(pos: THREE.Vector3[], vel?: THREE.Vector3[]): void {
    for (let i = 0; i < this.n; i++) {
      const v = vel?.[i];
      this.p[i * 3] = pos[i].x;
      this.p[i * 3 + 1] = Math.max(pos[i].y, this.r[i]);
      this.p[i * 3 + 2] = pos[i].z;
      this.o[i * 3] = pos[i].x - (v ? v.x * this.dt : 0);
      this.o[i * 3 + 1] = this.p[i * 3 + 1] - (v ? v.y * this.dt : 0);
      this.o[i * 3 + 2] = pos[i].z - (v ? v.z * this.dt : 0);
    }
    this.sleeping = false;
  }

  /** Build links with rest lengths taken from the given positions. */
  link(a: number, b: number, pos: THREE.Vector3[], minK = 1, maxK = 1, k = 1): void {
    const rest = pos[a].distanceTo(pos[b]);
    this.links.push({ a, b, min: rest * minK, max: rest * maxK, k });
  }

  get(i: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.p[i * 3], this.p[i * 3 + 1], this.p[i * 3 + 2]);
  }

  velocity(i: number, out: THREE.Vector3): THREE.Vector3 {
    return out
      .set(this.p[i * 3] - this.o[i * 3], this.p[i * 3 + 1] - this.o[i * 3 + 1], this.p[i * 3 + 2] - this.o[i * 3 + 2])
      .divideScalar(this.dt);
  }

  center(out: THREE.Vector3): THREE.Vector3 {
    out.set(0, 0, 0);
    let m = 0;
    for (let i = 0; i < this.n; i++) {
      const wi = this.w[i] > 0 ? 1 / this.w[i] : 0;
      out.x += this.p[i * 3] * wi;
      out.y += this.p[i * 3 + 1] * wi;
      out.z += this.p[i * 3 + 2] * wi;
      m += wi;
    }
    return out.divideScalar(m || 1);
  }

  /** Add velocity to one particle. */
  addVelocity(i: number, vx: number, vy: number, vz: number): void {
    this.o[i * 3] -= vx * this.dt;
    this.o[i * 3 + 1] -= vy * this.dt;
    this.o[i * 3 + 2] -= vz * this.dt;
    this.wake();
  }

  /** Impulse (N·s) at a particle. */
  applyImpulse(i: number, ix: number, iy: number, iz: number): void {
    const w = this.w[i];
    this.addVelocity(i, ix * w, iy * w, iz * w);
  }

  /** Radial impulse on all particles (explosions). */
  addVelocityAll(vx: number, vy: number, vz: number): void {
    for (let i = 0; i < this.n; i++) this.addVelocity(i, vx, vy, vz);
  }

  wake(): void {
    this.sleeping = false;
    this.stillTime = 0;
  }

  detach(index: number): void {
    this.links = this.links.filter((l) => l.a !== index && l.b !== index);
    if (index === J.head) this.headDetached = true;
  }

  step(
    dt: number,
    gravity: number,
    statics: readonly StaticCollider[],
    bodies: readonly RigidBody[],
    chars: readonly CharacterProxy[],
    iterations = 8,
  ): void {
    this.impacts.length = 0;
    if (this.sleeping || this.removed) return;
    this.dt = dt;
    this.time += dt;
    if (this.ignoreTimer > 0) {
      this.ignoreTimer -= dt;
      if (this.ignoreTimer <= 0) this.ignoreCollider = null;
    }
    const p = this.p;
    const o = this.o;
    const g = gravity * dt * dt;
    const maxStep = 26 * dt;
    let maxMove = 0;
    this.submerged = 0;
    for (let i = 0; i < this.n; i++) {
      const ix = i * 3;
      let vx = (p[ix] - o[ix]) * 0.999;
      let vy = (p[ix + 1] - o[ix + 1]) * 0.999;
      let vz = (p[ix + 2] - o[ix + 2]) * 0.999;
      // water: heavy drag and buoyancy on the submerged part of each particle
      let lift = 0;
      if (this.water && this.water(p[ix], p[ix + 2]) > 0) {
        const r = this.r[i];
        const sub = Math.min(1, Math.max(0, (WATER_Y + r - p[ix + 1]) / (2 * r)));
        if (sub > 0) {
          this.submerged++;
          const drag = Math.max(0.5, 1 - 7 * dt * sub);
          vx *= drag;
          vy *= drag;
          vz *= drag;
          lift = -g * 1.7 * sub * this.buoyancy;
        }
      }
      const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (sp > maxStep) {
        const k = maxStep / sp;
        vx *= k;
        vy *= k;
        vz *= k;
      }
      if (sp > maxMove) maxMove = sp;
      o[ix] = p[ix];
      o[ix + 1] = p[ix + 1];
      o[ix + 2] = p[ix + 2];
      p[ix] += vx;
      p[ix + 1] += vy + g + lift;
      p[ix + 2] += vz;
      this.pre[ix] = vx / dt;
      this.pre[ix + 1] = (vy + g) / dt;
      this.pre[ix + 2] = vz / dt;
      this.contact[i] = 0;
      this.contactCollider[i] = null;
    }

    // whole body deep inside something (spawned in a wall): slide it out as one piece first
    this.center(_p);
    for (const c of statics) {
      if (!c.enabled || !c.pushSphere(_p, 0.45, _push)) continue;
      if (_push.lengthSq() < 0.04) continue;
      for (let i = 0; i < this.n; i++) {
        p[i * 3] += _push.x;
        p[i * 3 + 1] += _push.y;
        p[i * 3 + 2] += _push.z;
        o[i * 3] += _push.x;
        o[i * 3 + 1] += _push.y;
        o[i * 3 + 2] += _push.z;
      }
      _p.add(_push);
    }

    for (let it = 0; it < iterations; it++) {
      this.solveLinks();
      this.collide(statics, bodies, chars, it === iterations - 1);
    }
    this.finishContacts();

    // sleep when nothing moves
    if (maxMove < 0.0025) {
      this.stillTime += dt;
      if (this.stillTime > 0.9) this.sleeping = true;
    } else this.stillTime = 0;
  }

  private solveLinks(): void {
    const p = this.p;
    for (const l of this.links) {
      const a = l.a * 3;
      const b = l.b * 3;
      const dx = p[b] - p[a];
      const dy = p[b + 1] - p[a + 1];
      const dz = p[b + 2] - p[a + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
      let target: number;
      if (d < l.min) target = l.min;
      else if (d > l.max) target = l.max;
      else continue;
      const wa = this.w[l.a];
      const wb = this.w[l.b];
      const ws = wa + wb;
      if (ws === 0) continue;
      const diff = ((d - target) / d) * l.k;
      const ka = (wa / ws) * diff;
      const kb = (wb / ws) * diff;
      p[a] += dx * ka;
      p[a + 1] += dy * ka;
      p[a + 2] += dz * ka;
      p[b] -= dx * kb;
      p[b + 1] -= dy * kb;
      p[b + 2] -= dz * kb;
    }
  }

  private collide(statics: readonly StaticCollider[], bodies: readonly RigidBody[], chars: readonly CharacterProxy[], last: boolean): void {
    const p = this.p;
    for (let i = 0; i < this.n; i++) {
      const ix = i * 3;
      const r = this.r[i];
      // ground (or the pond bottom)
      const floor = this.water ? -this.water(p[ix], p[ix + 2]) : 0;
      if (p[ix + 1] < r + floor) {
        p[ix + 1] = r + floor;
        this.contact[i] = 1;
        this.cn[ix] = 0;
        this.cn[ix + 1] = 1;
        this.cn[ix + 2] = 0;
      }
      _p.set(p[ix], p[ix + 1], p[ix + 2]);
      // statics
      for (const c of statics) {
        if (!c.enabled || c === this.ignoreCollider) continue;
        const dx = _p.x - c.x;
        const dz = _p.z - c.z;
        const br = c.boundR + r;
        if (dx * dx + dz * dz > br * br) continue;
        if (!c.pushSphere(_p, r, _push)) continue;
        const depth = _push.length() || 1e-6;
        if (depth > r * 0.8) {
          // deep overlap (spawned inside, squeezed by constraints): move out without gaining speed
          this.o[ix] += _push.x;
          this.o[ix + 1] += _push.y;
          this.o[ix + 2] += _push.z;
        }
        const nx = _push.x / depth;
        const ny = _push.y / depth;
        const nz = _push.z / depth;
        // breakables: check approach speed on first contact
        if (c.owner?.onImpact) {
          const vn = -(this.pre[ix] * nx + this.pre[ix + 1] * ny + this.pre[ix + 2] * nz);
          if (vn > this.breakSpeed) {
            _dir.set(this.pre[ix], this.pre[ix + 1], this.pre[ix + 2]).normalize();
            if (c.owner.onImpact(vn, _p, _dir, this.totalMass)) {
              this.ignoreCollider = c;
              this.ignoreTimer = 0.25;
              // lose a bit of energy smashing through
              for (let k = 0; k < this.n; k++) {
                const kx = k * 3;
                this.o[kx] = p[kx] - (p[kx] - this.o[kx]) * 0.75;
                this.o[kx + 2] = p[kx + 2] - (p[kx + 2] - this.o[kx + 2]) * 0.75;
              }
              continue;
            }
          }
        }
        _p.add(_push);
        this.contact[i] = 2;
        this.contactCollider[i] = c;
        this.cn[ix] = nx;
        this.cn[ix + 1] = ny;
        this.cn[ix + 2] = nz;
      }
      // rigid bodies
      for (const b of bodies) {
        if (b.removed) continue;
        const dx = _p.x - b.pos.x;
        const dy = _p.y - b.pos.y;
        const dz = _p.z - b.pos.z;
        const rr = b.radius + r;
        if (dx * dx + dy * dy + dz * dz > rr * rr) continue;
        let hit = false;
        if (b.shape.type === 'box') {
          // OBB test in body space
          _q.copy(b.quat).invert();
          _push.set(dx, dy, dz).applyQuaternion(_q);
          const s = b.shape;
          const cx = Math.max(-s.hx, Math.min(s.hx, _push.x));
          const cy = Math.max(-s.hy, Math.min(s.hy, _push.y));
          const cz = Math.max(-s.hz, Math.min(s.hz, _push.z));
          let ox = _push.x - cx;
          let oy = _push.y - cy;
          let oz = _push.z - cz;
          const d2 = ox * ox + oy * oy + oz * oz;
          if (d2 < r * r) {
            let depth: number;
            if (d2 > 1e-10) {
              const d = Math.sqrt(d2);
              depth = r - d;
              ox /= d;
              oy /= d;
              oz /= d;
            } else {
              ox = 0;
              oy = 1;
              oz = 0;
              depth = s.hy - _push.y + r;
            }
            _push.set(ox, oy, oz).applyQuaternion(b.quat);
            hit = this.resolveBody(i, b, _push.x, _push.y, _push.z, depth);
          }
        } else {
          const cr = b.contactRadius + r;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < cr * cr) {
            const d = Math.sqrt(d2) || 1e-6;
            hit = this.resolveBody(i, b, dx / d, dy / d, dz / d, cr - d);
          }
        }
        if (hit) {
          _p.set(p[ix], p[ix + 1], p[ix + 2]);
        }
      }
      // characters (vertical capsules)
      for (const ch of chars) {
        if (_p.y > ch.height + r) continue;
        const dx = _p.x - ch.x;
        const dz = _p.z - ch.z;
        const rr = ch.radius + r;
        const d2 = dx * dx + dz * dz;
        if (d2 >= rr * rr) continue;
        const d = Math.sqrt(d2) || 1e-6;
        const nx = dx / d;
        const nz = dz / d;
        const depth = rr - d;
        // character is heavy-ish: particle takes most of the correction
        _p.x += nx * depth * 0.8;
        _p.z += nz * depth * 0.8;
        ch.x -= nx * depth * 0.2;
        ch.z -= nz * depth * 0.2;
        if (last) {
          const sp = Math.hypot(this.pre[ix], this.pre[ix + 2]);
          const cd = this.charHitCooldown.get(ch) ?? -1;
          if (sp > 5 && this.time - cd > 0.4) {
            this.charHitCooldown.set(ch, this.time);
            _dir.set(this.pre[ix], 0, this.pre[ix + 2]).normalize();
            ch.onRagdollHit?.(sp, _dir.clone(), this.totalMass);
            this.impacts.push({ index: i, speed: sp, x: _p.x, y: _p.y, z: _p.z, nx, ny: 0, nz, kind: 'character', collider: null });
          }
        }
      }
      p[ix] = _p.x;
      p[ix + 1] = _p.y;
      p[ix + 2] = _p.z;
    }
  }

  private resolveBody(i: number, b: RigidBody, nx: number, ny: number, nz: number, depth: number): boolean {
    const ix = i * 3;
    const mp = this.w[i] > 0 ? 1 / this.w[i] : 1e6;
    const total = mp + b.mass;
    const kp = b.mass / total;
    const kb = mp / total;
    this.p[ix] += nx * depth * kp;
    this.p[ix + 1] += ny * depth * kp;
    this.p[ix + 2] += nz * depth * kp;
    // push the body with the particle's momentum along the normal
    const vn = this.pre[ix] * nx + this.pre[ix + 1] * ny + this.pre[ix + 2] * nz;
    if (vn < -0.3) {
      _dir.set(-nx, -ny, -nz).multiplyScalar(-vn * mp * 0.5);
      const cp = new THREE.Vector3(this.p[ix] - nx * this.r[i], this.p[ix + 1] - ny * this.r[i], this.p[ix + 2] - nz * this.r[i]);
      b.applyImpulse(_dir, cp);
      if (-vn > 4) {
        this.impacts.push({ index: i, speed: -vn, x: cp.x, y: cp.y, z: cp.z, nx, ny, nz, kind: 'body', collider: null });
        if (b.owner?.onImpact && -vn > this.breakSpeed) b.owner.onImpact(-vn, cp, _dir.normalize(), this.totalMass);
      }
    } else if (depth * kb > 0.001) {
      b.pos.x -= nx * depth * kb;
      b.pos.z -= nz * depth * kb;
      b.wake();
    }
    this.contact[i] = 3;
    this.cn[ix] = nx;
    this.cn[ix + 1] = ny;
    this.cn[ix + 2] = nz;
    return true;
  }

  /** Restitution + friction from recorded contacts, and impact reporting. */
  private finishContacts(): void {
    const p = this.p;
    const o = this.o;
    // rolling resistance: while touching the ground, damp spin around the center of mass so the
    // body skids to a stop instead of cartwheeling away
    let grounded = 0;
    let groundedMass = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.contact[i] === 1) {
        grounded++;
        groundedMass += this.w[i] > 0 ? 1 / this.w[i] : 0;
      }
    }
    if (grounded > 0) {
      let cx = 0;
      let cy = 0;
      let cz = 0;
      let m = 0;
      for (let i = 0; i < this.n; i++) {
        const wi = this.w[i] > 0 ? 1 / this.w[i] : 0;
        cx += (p[i * 3] - o[i * 3]) * wi;
        cy += (p[i * 3 + 1] - o[i * 3 + 1]) * wi;
        cz += (p[i * 3 + 2] - o[i * 3 + 2]) * wi;
        m += wi;
      }
      cx /= m;
      cy /= m;
      cz /= m;
      const k = Math.min(0.3, 0.05 * grounded);
      // whole-body skid friction, proportional to how much of the body rests on the ground
      const fc = (groundedMass / this.totalMass) * 0.16;
      for (let i = 0; i < this.n; i++) {
        const ix = i * 3;
        const dvx = p[ix] - o[ix] - cx;
        const dvy = p[ix + 1] - o[ix + 1] - cy;
        const dvz = p[ix + 2] - o[ix + 2] - cz;
        o[ix] += dvx * k + cx * fc;
        o[ix + 1] += dvy * k;
        o[ix + 2] += dvz * k + cz * fc;
      }
    }
    for (let i = 0; i < this.n; i++) {
      if (!this.contact[i]) continue;
      const ix = i * 3;
      const nx = this.cn[ix];
      const ny = this.cn[ix + 1];
      const nz = this.cn[ix + 2];
      const vpn = this.pre[ix] * nx + this.pre[ix + 1] * ny + this.pre[ix + 2] * nz;
      // current (post projection) velocity
      let vx = (p[ix] - o[ix]) / this.dt;
      let vy = (p[ix + 1] - o[ix + 1]) / this.dt;
      let vz = (p[ix + 2] - o[ix + 2]) / this.dt;
      const vn = vx * nx + vy * ny + vz * nz;
      // remove normal component and replace by a bounce of the pre-impact speed
      let bounce = 0;
      if (vpn < -2.5) bounce = -vpn * this.restitution;
      vx += nx * (bounce - vn);
      vy += ny * (bounce - vn);
      vz += nz * (bounce - vn);
      // tangential friction (a hard landing bites extra hard: thud, then a short skid)
      let f = this.contact[i] === 1 ? this.groundFriction : 0.12;
      if (vpn < -3.5) f = Math.min(0.6, f + (-vpn - 3.5) * 0.05);
      const tvn = vx * nx + vy * ny + vz * nz;
      const tx = vx - nx * tvn;
      const ty = vy - ny * tvn;
      const tz = vz - nz * tvn;
      vx -= tx * f;
      vy -= ty * f;
      vz -= tz * f;
      o[ix] = p[ix] - vx * this.dt;
      o[ix + 1] = p[ix + 1] - vy * this.dt;
      o[ix + 2] = p[ix + 2] - vz * this.dt;
      if (vpn < -3) {
        this.impacts.push({
          index: i,
          speed: -vpn,
          x: p[ix] - nx * this.r[i],
          y: p[ix + 1] - ny * this.r[i],
          z: p[ix + 2] - nz * this.r[i],
          nx,
          ny,
          nz,
          kind: this.contact[i] === 1 ? 'ground' : this.contact[i] === 2 ? 'static' : 'body',
          collider: this.contactCollider[i],
        });
      }
    }
  }

  /** Particle-particle push between two ragdolls. */
  static collidePair(a: Ragdoll, b: Ragdoll): void {
    if (a.sleeping && b.sleeping) return;
    for (let i = 0; i < a.n; i++) {
      const ix = i * 3;
      for (let j = 0; j < b.n; j++) {
        const jx = j * 3;
        const dx = b.p[jx] - a.p[ix];
        const dy = b.p[jx + 1] - a.p[ix + 1];
        const dz = b.p[jx + 2] - a.p[ix + 2];
        const rr = a.r[i] + b.r[j];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= rr * rr || d2 < 1e-10) continue;
        const d = Math.sqrt(d2);
        const k = ((rr - d) / d) * 0.5;
        a.p[ix] -= dx * k;
        a.p[ix + 1] -= dy * k;
        a.p[ix + 2] -= dz * k;
        b.p[jx] += dx * k;
        b.p[jx + 1] += dy * k;
        b.p[jx + 2] += dz * k;
        if (a.sleeping) a.wake();
        if (b.sleeping) b.wake();
      }
    }
  }
}
