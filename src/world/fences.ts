import * as THREE from 'three';
import { Rng, rng } from '../core/rng';
import { compose, Spring } from '../core/math';
import { PAL } from '../render/palette';
import { cone, cyl, GeoBuilder, rbox } from '../render/geometry';
import { vcToon } from '../render/materials';
import { StaticCollider, type HitReceiver } from '../physics/colliders';
import type { GameCtx, Updatable } from '../game/context';
import type { Pt } from './layout';
import { sfx } from '../audio/sfx';

export type FenceKind = 'picket' | 'rustic';

let picketGeo: THREE.BufferGeometry | null = null;
function picketShape(): THREE.BufferGeometry {
  if (picketGeo) return picketGeo;
  const s = new THREE.Shape();
  const w = 0.05;
  const h = 1;
  s.moveTo(-w, 0);
  s.lineTo(w, 0);
  s.lineTo(w, h - 0.07);
  s.lineTo(0, h);
  s.lineTo(-w, h - 0.07);
  s.closePath();
  picketGeo = new THREE.ExtrudeGeometry(s, { depth: 0.03, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.008, bevelSegments: 1 });
  picketGeo.translate(0, 0, -0.015);
  return picketGeo;
}

interface Piece {
  kind: 'picket' | 'rail';
  local: THREE.Vector3;
  size: THREE.Vector3;
  color: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qx = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);
const _ax = new THREE.Vector3(1, 0, 0);
const _ay = new THREE.Vector3(0, 1, 0);

/**
 * One breakable span of fence between two posts. Its geometry lives in the run's BatchedMesh
 * (one draw call for the whole run); the segment just moves / hides its own instance.
 */
export class FenceSegment implements HitReceiver, Updatable {
  /** Segment geometry in its local frame (origin at the first post, +X along the fence). */
  readonly geometry: THREE.BufferGeometry;
  private batch: THREE.BatchedMesh | null = null;
  private instance = -1;
  private lastTilt = NaN;
  readonly collider: StaticCollider;
  hp: number;
  private maxHp: number;
  broken = false;
  private wobble = new Spring(0, 120, 6);
  private pieces: Piece[] = [];
  private angle: number;
  private len: number;

  constructor(
    private ctx: GameCtx,
    private a: Pt,
    b: Pt,
    readonly kind: FenceKind,
    seed: number,
  ) {
    const r = new Rng(seed);
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    this.len = Math.hypot(dx, dz);
    this.angle = Math.atan2(-dz, dx);
    const L = this.len;
    const g = new GeoBuilder();
    if (kind === 'picket') {
      for (const y of [0.3, 0.7]) {
        g.add(rbox(L, 0.09, 0.04, 0.015), 0xe9e1d3, compose(L / 2, y, -0.035));
        this.pieces.push({ kind: 'rail', local: new THREE.Vector3(L / 2, y, -0.035), size: new THREE.Vector3(L, 0.09, 0.04), color: 0xe9e1d3 });
      }
      const n = Math.max(3, Math.round(L / 0.26));
      for (let i = 0; i < n; i++) {
        const x = ((i + 0.5) / n) * L;
        const h = 0.92 + r.spread(0.04);
        const col = r.chance(0.2) ? 0xefe7d8 : PAL.pickets;
        g.add(picketShape(), col, compose(x, 0.02, 0, 0, 0, r.spread(0.02), 1, h, 1));
        this.pieces.push({ kind: 'picket', local: new THREE.Vector3(x, h / 2, 0), size: new THREE.Vector3(0.1, h, 0.03), color: col });
      }
      this.hp = 2.2;
    } else {
      const ys = [0.42, 0.82];
      for (const y of ys) {
        const sag = r.spread(0.03);
        const col = r.chance(0.5) ? PAL.fenceWood : PAL.fenceWoodDark;
        g.add(cyl(0.045, 0.05, L + 0.1, 7), col, compose(L / 2, y + sag, 0, r.spread(0.02), 0, Math.PI / 2 + r.spread(0.03)));
        this.pieces.push({ kind: 'rail', local: new THREE.Vector3(L / 2, y, 0), size: new THREE.Vector3(L, 0.09, 0.09), color: col });
      }
      this.hp = 3;
    }
    this.geometry = g.build();
    const mx = (a[0] + b[0]) / 2;
    const mz = (a[1] + b[1]) / 2;
    this.collider = StaticCollider.box(mx, mz, L / 2, kind === 'picket' ? 0.08 : 0.09, kind === 'picket' ? 1.0 : 0.95, this.angle, 'wood', this);
    this.collider.climbable = true;
    this.maxHp = this.hp;
  }

  /** Called by the FenceRun once the batch exists. */
  attach(batch: THREE.BatchedMesh, instance: number): void {
    this.batch = batch;
    this.instance = instance;
    this.place(0);
  }

  private place(tilt: number): void {
    if (!this.batch || tilt === this.lastTilt) return;
    this.lastTilt = tilt;
    _q.setFromAxisAngle(_ay, this.angle).multiply(_qx.setFromAxisAngle(_ax, tilt));
    _m.compose(_p.set(this.a[0], 0, this.a[1]), _q, _one);
    this.batch.setMatrixAt(this.instance, _m);
  }

  private setVisible(v: boolean): void {
    if (this.batch) this.batch.setVisibleAt(this.instance, v);
  }

  /** Fence normal (horizontal, unit). */
  get normal(): THREE.Vector3 {
    return new THREE.Vector3(Math.sin(this.angle), 0, Math.cos(this.angle));
  }

  get center(): THREE.Vector3 {
    return new THREE.Vector3(this.collider.x, 0, this.collider.z);
  }

  /** Something leaning on / climbing over it. */
  shake(amount: number): void {
    if (!this.broken) this.wake(amount);
  }

  /** A zombie hammering at it. Returns true once it gives way. */
  bash(dir: THREE.Vector3, damage: number): boolean {
    if (this.broken) return true;
    this.hp -= damage;
    const p = new THREE.Vector3(this.collider.x, 0.6, this.collider.z);
    this.ctx.fx.splinters(p, dir.clone().negate(), 4, this.kind === 'picket' ? PAL.pickets : PAL.fenceWood);
    sfx.woodHit(p);
    this.wake(this.sideOf(dir) * 5);
    if (this.kind === 'picket' && rng.chance(0.4)) this.popPicket(dir);
    if (this.hp <= 0) {
      this.break(dir, 4);
      return true;
    }
    return false;
  }

  /** Put it back together (the player, between waves). */
  repair(): void {
    if (!this.broken) return;
    this.broken = false;
    this.hp = this.maxHp;
    this.setVisible(true);
    this.collider.enabled = true;
    this.wobble.value = 0;
    this.wake(4);
    const mid = new THREE.Vector3(this.collider.x, 0.4, this.collider.z);
    this.ctx.fx.dust(mid, 5, 1, 0xe9dcc6, 0.35);
    sfx.woodHit(mid);
  }

  private wake(amount: number): void {
    this.wobble.kick(amount);
  }

  onBulletHit(point: THREE.Vector3, normal: THREE.Vector3, dir: THREE.Vector3, damage: number): void {
    if (this.broken) return;
    this.hp -= damage;
    this.ctx.fx.splinters(point, normal, 3, this.kind === 'picket' ? PAL.pickets : PAL.fenceWood);
    sfx.woodHit(point);
    const side = this.sideOf(dir);
    this.wake(side * 3);
    if (this.hp <= 0) this.break(dir, 4);
    else if (this.kind === 'picket' && rng.chance(0.35)) this.popPicket(dir);
  }

  onImpact(speed: number, _point: THREE.Vector3, dir: THREE.Vector3, mass: number): boolean {
    if (this.broken) return true;
    if (speed * Math.min(mass, 40) > 45) {
      this.break(dir, speed);
      return true;
    }
    this.hp -= 0.6;
    this.wake(this.sideOf(dir) * speed * 0.6);
    return false;
  }

  onBlast(center: THREE.Vector3, strength: number): void {
    if (this.broken) return;
    const mid = new THREE.Vector3(this.collider.x, 0.5, this.collider.z);
    const dir = mid.clone().sub(center).setY(0).normalize();
    if (strength > 0.45) this.break(dir.setY(0.4).normalize(), 6 + strength * 8);
    else this.wake(this.sideOf(dir) * strength * 8);
  }

  /** +1 / -1 depending on which side of the fence the push comes from. */
  private sideOf(dir: THREE.Vector3): number {
    const nx = Math.sin(this.angle);
    const nz = Math.cos(this.angle);
    return dir.x * nx + dir.z * nz > 0 ? 1 : -1;
  }

  private toWorld(local: THREE.Vector3): THREE.Vector3 {
    return local.clone().applyEuler(new THREE.Euler(0, this.angle, 0)).add(new THREE.Vector3(this.a[0], 0, this.a[1]));
  }

  private popPicket(dir: THREE.Vector3): void {
    const p = this.pieces.find((q) => q.kind === 'picket');
    if (!p) return;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, this.angle, 0));
    this.ctx.fx.debris.spawn('plank', this.toWorld(p.local), dir.clone().multiplyScalar(3).add(new THREE.Vector3(0, 3, 0)), p.size, p.color, { quat: q, spin: 8, life: 8 });
  }

  break(dir: THREE.Vector3, speed: number): void {
    if (this.broken) return;
    this.broken = true;
    this.setVisible(false);
    this.collider.enabled = false;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, this.angle, 0));
    const flat = dir.clone().setY(0).normalize();
    for (const p of this.pieces) {
      const pos = this.toWorld(p.local);
      if (p.kind === 'rail') {
        // rails snap in two
        for (const half of [-0.25, 0.25]) {
          const off = new THREE.Vector3(half * p.size.x, 0, 0).applyQuaternion(q);
          const v = flat.clone().multiplyScalar(speed * rng.range(0.35, 0.7)).add(new THREE.Vector3(rng.spread(1.5), rng.range(1.5, 4), rng.spread(1.5)));
          this.ctx.fx.debris.spawn('plank', pos.clone().add(off), v, new THREE.Vector3(p.size.x * 0.5, p.size.y, p.size.z), p.color, { quat: q, spin: 10, life: 9 });
        }
      } else {
        const v = flat.clone().multiplyScalar(speed * rng.range(0.3, 0.8)).add(new THREE.Vector3(rng.spread(2), rng.range(2, 5), rng.spread(2)));
        this.ctx.fx.debris.spawn('plank', pos, v, p.size, p.color, { quat: q, spin: 14, life: 9 });
      }
    }
    const mid = new THREE.Vector3(this.collider.x, 0.4, this.collider.z);
    this.ctx.fx.dust(mid, 6, 1.2, 0xe9dcc6, 0.4);
    sfx.woodBreak(mid);
  }

  update(dt: number): void {
    if (this.broken) return;
    this.wobble.update(dt);
    const tilt = Math.abs(this.wobble.value) < 1e-3 ? 0 : this.wobble.value * 0.06;
    this.place(tilt);
  }
}

/** A run of fence: static posts (one merged mesh) + breakable segments. */
export class FenceRun {
  readonly group = new THREE.Group();
  readonly segments: FenceSegment[] = [];

  constructor(ctx: GameCtx, pts: Pt[], kind: FenceKind, seed: number, spacing = 2.0) {
    const r = new Rng(seed);
    const posts = new GeoBuilder();
    const addPost = (x: number, z: number) => {
      if (kind === 'picket') {
        posts.add(rbox(0.13, 1.08, 0.13, 0.03), PAL.pickets, compose(x, 0.54, z));
        const capGeo = cone(0.11, 0.12, 4);
        posts.add(capGeo, 0xe9e1d3, compose(x, 1.14, z, 0, Math.PI / 4, 0));
      } else {
        posts.add(cyl(0.075, 0.09, 1.1, 7), PAL.fenceWoodDark, compose(x, 0.55, z, r.spread(0.04), 0, r.spread(0.04)));
      }
    };
    let k = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i];
      const [bx, bz] = pts[i + 1];
      const L = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.round(L / spacing));
      for (let j = 0; j < n; j++) {
        const t0 = j / n;
        const t1 = (j + 1) / n;
        const a: Pt = [ax + (bx - ax) * t0, az + (bz - az) * t0];
        const b: Pt = [ax + (bx - ax) * t1, az + (bz - az) * t1];
        const seg = new FenceSegment(ctx, a, b, kind, seed * 100 + k++);
        this.segments.push(seg);
        addPost(a[0], a[1]);
      }
    }
    const last = pts[pts.length - 1];
    addPost(last[0], last[1]);
    const pm = new THREE.Mesh(posts.build(), vcToon());
    pm.castShadow = true;
    pm.receiveShadow = true;
    this.group.add(pm);
    // all spans of the run in one batched draw call
    let verts = 0;
    for (const s of this.segments) verts += s.geometry.getAttribute('position').count;
    const batch = new THREE.BatchedMesh(this.segments.length, verts, 0, vcToon());
    batch.castShadow = true;
    batch.receiveShadow = true;
    for (const s of this.segments) {
      const id = batch.addInstance(batch.addGeometry(s.geometry));
      s.attach(batch, id);
    }
    batch.computeBoundingSphere();
    batch.computeBoundingBox();
    this.group.add(batch);
  }
}
