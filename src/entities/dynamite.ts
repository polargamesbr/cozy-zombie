import * as THREE from 'three';
import { compose } from '../core/math';
import { rng } from '../core/rng';
import { cyl, GeoBuilder, rbox, sphere } from '../render/geometry';
import { outlineMaterial, vcToon } from '../render/materials';
import type { GameCtx, Updatable } from '../game/context';
import { inPond } from '../world/layout';
import { TEX } from '../fx/particles';
import { sfx } from '../audio/sfx';

/** Gravity used by thrown things (floatier than the physics world: reads better). */
export const THROW_G = 17;
export const FUSE_TIME = 1.9;
export const THROW_RANGE = 13;
const RADIUS = 0.09;
const FUSE_TIP = new THREE.Vector3(0.04, 0.24, 0);

/** Three red sticks, black tape, a fuse. */
export function dynamiteMesh(): THREE.Group {
  const g = new GeoBuilder();
  for (const [x, z] of [
    [-0.047, -0.025],
    [0.047, -0.025],
    [0, 0.055],
  ]) {
    g.add(cyl(0.046, 0.046, 0.3, 10), 0xd9483e, compose(x, 0, z));
    g.add(cyl(0.041, 0.041, 0.305, 10), 0xf1ddc0, compose(x, 0, z));
  }
  g.add(rbox(0.2, 0.05, 0.18, 0.02), 0x3a3236, compose(0, 0.07, 0.005));
  g.add(rbox(0.2, 0.05, 0.18, 0.02), 0x3a3236, compose(0, -0.08, 0.005));
  g.add(cyl(0.012, 0.012, 0.12, 5), 0x6b5a4a, compose(0.02, 0.19, 0, 0, 0, -0.35));
  const geo = g.build();
  const grp = new THREE.Group();
  const m = new THREE.Mesh(geo, vcToon());
  m.castShadow = true;
  grp.add(m);
  const ol = new THREE.Mesh(geo, outlineMaterial(0x3b2a2e, 0.012));
  ol.userData.noAO = true;
  grp.add(ol);
  return grp;
}

/** Launch velocity that lands on `target` (a nice lob: flight time grows with distance). */
export function throwVelocity(from: THREE.Vector3, target: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  const dx = target.x - from.x;
  const dz = target.z - from.z;
  const d = Math.hypot(dx, dz);
  const t = 0.42 + d * 0.05;
  return out.set(dx / t, (target.y - from.y + 0.5 * THROW_G * t * t) / t, dz / t);
}

/** Clamp an aim point to the throwing range, on the ground. */
export function throwTarget(from: THREE.Vector3, aim: THREE.Vector3, ground: (x: number, z: number) => number, out = new THREE.Vector3()): THREE.Vector3 {
  const dx = aim.x - from.x;
  const dz = aim.z - from.z;
  const d = Math.hypot(dx, dz);
  const k = d > THROW_RANGE ? THROW_RANGE / d : d < 1.5 && d > 1e-3 ? 1.5 / d : 1;
  out.set(from.x + dx * k, 0, from.z + dz * k);
  out.y = ground(out.x, out.z) + RADIUS;
  return out;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const _push = new THREE.Vector3();
const _q = new THREE.Quaternion();

/** A lit stick of dynamite: flies on an exact parabola, bounces, rolls, then goes boom. */
export class Dynamite implements Updatable {
  dead = false;
  private group = dynamiteMesh();
  private pos: THREE.Vector3;
  private vel: THREE.Vector3;
  private spin = new THREE.Vector3(rng.spread(14), rng.spread(6), rng.spread(14));
  private fuse = FUSE_TIME;
  private wet = false;
  private bounces = 0;
  private sizzleT = 0;

  constructor(
    private ctx: GameCtx,
    pos: THREE.Vector3,
    vel: THREE.Vector3,
  ) {
    this.pos = pos.clone();
    this.vel = vel.clone();
    this.group.position.copy(this.pos);
    this.group.rotation.set(rng.angle(), rng.angle(), 0);
    ctx.root.add(this.group);
  }

  update(dt: number): void {
    if (this.dead || dt <= 0) return;
    this.fuse -= dt;
    const ctx = this.ctx;
    // fuse: sparks, a little smoke, sizzle
    const tip = this.group.localToWorld(_a.copy(FUSE_TIP));
    if (!this.wet) {
      for (let i = 0; i < 2; i++) {
        ctx.fx.particles.glow.spawn(tip, {
          vel: new THREE.Vector3(rng.spread(2.5), rng.range(0.5, 3), rng.spread(2.5)),
          life: rng.range(0.12, 0.3),
          size: 0.03,
          color: 0xffc46b,
          intensity: 3,
          alpha: 1,
          alphaEnd: 0,
          gravity: -6,
          cell: TEX.soft,
          stretch: 0.04,
        });
      }
      if (rng.chance(dt * 12)) ctx.fx.particles.soft.spawn(tip, { vel: new THREE.Vector3(0, 0.6, 0), life: 0.6, size: 0.06, sizeEnd: 0.22, color: 0xd9d1c9, alpha: 0.5, drag: 1, cell: TEX.puff });
      this.sizzleT -= dt;
      if (this.sizzleT <= 0) {
        this.sizzleT = 0.22;
        sfx.fuse(tip);
      }
    } else if (rng.chance(dt * 10)) {
      ctx.fx.particles.drops.spawn(new THREE.Vector3(this.pos.x + rng.spread(0.2), 0.08, this.pos.z + rng.spread(0.2)), new THREE.Vector3(0, rng.range(0.5, 1.2), 0), 0.03, 0xeaf8f8, 1, 0.4);
    }

    if (this.wet) {
      // sinking slowly, fuse still burning (it's that kind of dynamite)
      this.pos.y = Math.max(-0.35, this.pos.y - dt * 0.4);
    } else {
      // exact ballistic step so the flight matches the predicted arc
      this.pos.x += this.vel.x * dt;
      this.pos.y += this.vel.y * dt - 0.5 * THROW_G * dt * dt;
      this.pos.z += this.vel.z * dt;
      this.vel.y -= THROW_G * dt;
      // walls, fences, props
      for (const c of ctx.physics.statics) {
        if (!c.enabled) continue;
        const dx = this.pos.x - c.x;
        const dz = this.pos.z - c.z;
        const br = c.boundR + RADIUS;
        if (dx * dx + dz * dz > br * br) continue;
        if (c.pushSphere(this.pos, RADIUS, _push)) {
          this.pos.add(_push);
          const n = _push.normalize();
          const vn = this.vel.dot(n);
          if (vn < 0) {
            this.vel.addScaledVector(n, -1.4 * vn);
            if (-vn > 2) this.clunk(-vn);
          }
          this.vel.multiplyScalar(0.7);
        }
      }
      // zombies: bonk off heads and bellies
      for (const ch of ctx.physics.characters) {
        if (!ch.alive || ch.team === 'player') continue;
        const dx = this.pos.x - ch.x;
        const dz = this.pos.z - ch.z;
        const d = Math.hypot(dx, dz);
        if (d > ch.radius + RADIUS || this.pos.y > ch.headY + ch.headR) continue;
        const nx = dx / (d || 1);
        const nz = dz / (d || 1);
        const vn = this.vel.x * nx + this.vel.z * nz;
        if (vn < 0) {
          this.vel.x -= 1.5 * vn * nx;
          this.vel.z -= 1.5 * vn * nz;
          this.vel.multiplyScalar(0.5);
          this.clunk(-vn);
        }
        this.pos.x = ch.x + nx * (ch.radius + RADIUS);
        this.pos.z = ch.z + nz * (ch.radius + RADIUS);
      }
      // water
      if (inPond(this.pos.x, this.pos.z, -0.3) && this.pos.y < 0.12) {
        this.wet = true;
        this.vel.set(0, 0, 0);
        ctx.fx.splash(new THREE.Vector3(this.pos.x, 0.06, this.pos.z), 0.8);
      } else {
        const gy = ctx.groundAt(this.pos.x, this.pos.z) + RADIUS;
        if (this.pos.y < gy) {
          this.pos.y = gy;
          if (this.vel.y < -1.5 && this.bounces < 4) {
            this.clunk(-this.vel.y);
            this.vel.y *= -0.33;
            this.vel.x *= 0.6;
            this.vel.z *= 0.6;
            this.spin.multiplyScalar(0.6);
            this.bounces++;
          } else {
            // roll to a stop
            this.vel.y = 0;
            this.vel.x /= 1 + dt * 5;
            this.vel.z /= 1 + dt * 5;
            this.spin.set(this.vel.z / RADIUS, 0, -this.vel.x / RADIUS).multiplyScalar(0.5);
          }
        }
      }
    }
    const w = this.spin.length();
    if (w > 1e-3 && !this.wet) this.group.quaternion.premultiply(_q.setFromAxisAngle(_d.copy(this.spin).divideScalar(w), w * dt));
    this.group.position.copy(this.pos);
    // last half second: it pulses
    const pulse = this.fuse < 0.5 ? 1 + Math.max(0, Math.sin(this.fuse * 40)) * 0.25 : 1;
    this.group.scale.setScalar(pulse);
    if (this.fuse <= 0) this.explode();
  }

  private clunk(speed: number): void {
    sfx.thud(this.pos, Math.min(1, speed / 8) * 0.5);
  }

  private explode(): void {
    this.dead = true;
    this.group.removeFromParent();
    const p = _b.copy(this.pos);
    if (this.wet) {
      // underwater: a geyser, then the boom
      p.y = 0.2;
      this.ctx.fx.splash(new THREE.Vector3(p.x, 0.06, p.z), 3);
      for (let i = 0; i < 40; i++) {
        this.ctx.fx.particles.drops.spawn(new THREE.Vector3(p.x + rng.spread(0.6), 0.1, p.z + rng.spread(0.6)), new THREE.Vector3(rng.spread(2), rng.range(6, 12), rng.spread(2)), rng.range(0.05, 0.1), 0xdff4f6, 1, 1.4);
      }
      this.ctx.explode(p, 0.85, 'dynamite');
    } else {
      p.y = Math.max(p.y, 0.3);
      this.ctx.explode(p, 1.05, 'dynamite');
    }
  }

  dispose(): void {
    this.dead = true;
    this.group.removeFromParent();
  }
}

/**
 * The predicted throw: a dotted parabola that stops where it would first hit something, a
 * landing ring and a faint blast ring. Dots march along the arc so it reads as motion.
 */
export class ThrowArc {
  readonly group = new THREE.Group();
  private dots: THREE.InstancedMesh;
  private ring: THREE.Mesh;
  private blastRing: THREE.Mesh;
  private readonly n = 30;
  private m = new THREE.Matrix4();

  constructor() {
    const dotMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfff0cf).multiplyScalar(1.2), transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false });
    this.dots = new THREE.InstancedMesh(sphere(0.05, 8, 6), dotMat, this.n);
    this.dots.frustumCulled = false;
    this.dots.renderOrder = 60;
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffd08a, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.55, 32), ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    const blastMat = new THREE.MeshBasicMaterial({ color: 0xff8a6a, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide });
    this.blastRing = new THREE.Mesh(new THREE.RingGeometry(3.0, 3.25, 48), blastMat);
    this.blastRing.rotation.x = -Math.PI / 2;
    this.group.add(this.dots, this.ring, this.blastRing);
    this.group.traverse((o) => (o.userData.noAO = true));
    this.group.visible = false;
  }

  /** Recompute the arc from `from` with launch velocity `vel`. */
  update(ctx: GameCtx, from: THREE.Vector3, vel: THREE.Vector3, time: number): void {
    this.group.visible = true;
    // march until the first hit (statics, ground, water)
    const step = 1 / 40;
    let tHit = 3;
    const hit = new THREE.Vector3();
    const prev = from.clone();
    for (let t = step; t <= 3; t += step) {
      const p = _a.set(from.x + vel.x * t, from.y + vel.y * t - 0.5 * THROW_G * t * t, from.z + vel.z * t);
      _d.subVectors(p, prev);
      const len = _d.length();
      _d.divideScalar(len || 1);
      const rh = ctx.physics.raycast(prev, _d, len, null);
      if (rh && rh.kind !== 'character' && rh.kind !== 'ragdoll') {
        tHit = t - step + (rh.distance / (len || 1)) * step;
        hit.copy(rh.point);
        break;
      }
      const gy = ctx.groundAt(p.x, p.z);
      if (p.y < gy + 0.02) {
        tHit = t;
        hit.set(p.x, gy, p.z);
        break;
      }
      prev.copy(p);
    }
    const phase = (time * 1.6) % 1;
    for (let i = 0; i < this.n; i++) {
      const t = ((i + phase) / this.n) * tHit;
      const p = _a.set(from.x + vel.x * t, from.y + vel.y * t - 0.5 * THROW_G * t * t, from.z + vel.z * t);
      // dots fade in near the hand and shrink toward the end
      const k = i / this.n;
      const s = (0.6 + 0.6 * Math.min(1, k * 4)) * (1 - k * 0.3);
      this.m.makeScale(s, s, s).setPosition(p);
      this.dots.setMatrixAt(i, this.m);
    }
    this.dots.instanceMatrix.needsUpdate = true;
    const wet = inPond(hit.x, hit.z, -0.3);
    const y = (wet ? 0.07 : hit.y) + 0.04;
    this.ring.position.set(hit.x, y, hit.z);
    const pulse = 1 + Math.sin(time * 8) * 0.08;
    this.ring.scale.setScalar(pulse);
    this.blastRing.position.set(hit.x, y - 0.01, hit.z);
  }

  hide(): void {
    this.group.visible = false;
  }
}
