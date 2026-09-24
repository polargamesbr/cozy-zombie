import * as THREE from 'three';
import { rng } from '../core/rng';
import { rbox } from '../render/geometry';
import { toonUnique } from '../render/materials';
import type { StaticCollider } from '../physics/colliders';

export type DebrisKind = 'plank' | 'chunk' | 'shard' | 'shell' | 'casing' | 'stick' | 'flat';

interface Piece {
  alive: boolean;
  kind: DebrisKind;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  quat: THREE.Quaternion;
  ang: THREE.Vector3;
  scale: THREE.Vector3;
  color: THREE.Color;
  life: number;
  max: number;
  radius: number;
  bounces: number;
  onBounce?: (speed: number, p: THREE.Vector3) => void;
}

function shellGeometry(): THREE.BufferGeometry {
  const body = new THREE.CylinderGeometry(0.5, 0.5, 1, 10);
  const base = new THREE.CylinderGeometry(0.53, 0.53, 0.28, 10);
  base.translate(0, -0.5, 0);
  const paintGeo = (g: THREE.BufferGeometry, c: number) => {
    const col = new THREE.Color(c);
    const n = g.getAttribute('position').count;
    const a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) a.set([col.r, col.g, col.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    return g;
  };
  const merged = new THREE.BufferGeometry();
  const b1 = paintGeo(body.toNonIndexed(), 0xcf4a3f);
  const b2 = paintGeo(base.toNonIndexed(), 0xe8bf5c);
  const pos = new Float32Array([...b1.getAttribute('position').array, ...b2.getAttribute('position').array]);
  const nrm = new Float32Array([...b1.getAttribute('normal').array, ...b2.getAttribute('normal').array]);
  const col = new Float32Array([...b1.getAttribute('color').array, ...b2.getAttribute('color').array]);
  merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  merged.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return merged;
}

const GEOS: Record<DebrisKind, () => THREE.BufferGeometry> = {
  plank: () => rbox(1, 1, 1, 0.12, 1),
  chunk: () => new THREE.IcosahedronGeometry(0.6, 0),
  shard: () => {
    const g = new THREE.CylinderGeometry(0.6, 0.6, 0.25, 3);
    return g;
  },
  shell: shellGeometry,
  casing: () => new THREE.CylinderGeometry(0.5, 0.5, 1, 8),
  stick: () => new THREE.CylinderGeometry(0.5, 0.5, 1, 6),
  flat: () => new THREE.BoxGeometry(1, 1, 1),
};

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _push = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Short-lived tumbling pieces: fence pickets, crate planks, pot shards, gibs, shells.
 * They bounce, spin, settle flat, then shrink away after a few seconds.
 */
export class DebrisSystem {
  readonly group = new THREE.Group();
  private meshes = new Map<DebrisKind, THREE.InstancedMesh>();
  private pieces: Piece[] = [];
  private readonly perKind = 90;
  statics: readonly StaticCollider[] = [];

  constructor() {
    for (const kind of Object.keys(GEOS) as DebrisKind[]) {
      const geo = GEOS[kind]();
      const mat = toonUnique(0xffffff, { vertexColors: kind === 'shell' });
      const mesh = new THREE.InstancedMesh(geo, mat, this.perKind);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.setColorAt(0, new THREE.Color(1, 1, 1));
      mesh.count = 0;
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      this.meshes.set(kind, mesh);
      this.group.add(mesh);
    }
  }

  spawn(
    kind: DebrisKind,
    pos: THREE.Vector3,
    vel: THREE.Vector3,
    scale: THREE.Vector3 | number,
    color: number,
    opts: { life?: number; spin?: number; quat?: THREE.Quaternion; onBounce?: (speed: number, p: THREE.Vector3) => void } = {},
  ): void {
    const alive = this.pieces.filter((p) => p.alive && p.kind === kind);
    let piece: Piece | undefined;
    if (alive.length >= this.perKind) {
      // recycle the oldest of this kind
      piece = alive.reduce((a, b) => (a.life > b.life ? a : b));
    } else {
      piece = this.pieces.find((p) => !p.alive);
      if (!piece) {
        piece = {
          alive: false,
          kind,
          pos: new THREE.Vector3(),
          vel: new THREE.Vector3(),
          quat: new THREE.Quaternion(),
          ang: new THREE.Vector3(),
          scale: new THREE.Vector3(),
          color: new THREE.Color(),
          life: 0,
          max: 6,
          radius: 0.05,
          bounces: 0,
        };
        this.pieces.push(piece);
      }
    }
    const s = typeof scale === 'number' ? _v.set(scale, scale, scale) : scale;
    piece.alive = true;
    piece.kind = kind;
    piece.pos.copy(pos);
    piece.vel.copy(vel);
    if (opts.quat) piece.quat.copy(opts.quat);
    else piece.quat.setFromEuler(new THREE.Euler(rng.angle(), rng.angle(), rng.angle()));
    const spin = opts.spin ?? 14;
    piece.ang.set(rng.spread(spin), rng.spread(spin), rng.spread(spin));
    piece.scale.copy(s);
    piece.color.set(color);
    piece.life = 0;
    piece.max = (opts.life ?? 7) * (0.8 + rng.next() * 0.4);
    piece.radius = Math.min(s.x, s.y, s.z) * 0.5 + 0.005;
    piece.bounces = 0;
    piece.onBounce = opts.onBounce;
  }

  update(dt: number, gravity: number): void {
    const counts = new Map<DebrisKind, number>();
    for (const p of this.pieces) {
      if (!p.alive) continue;
      p.life += dt;
      if (p.life > p.max) {
        p.alive = false;
        continue;
      }
      p.vel.y += gravity * dt;
      p.pos.addScaledVector(p.vel, dt);
      // spin
      const w = p.ang.length();
      if (w > 1e-4) {
        _q.setFromAxisAngle(_v.copy(p.ang).divideScalar(w), w * dt);
        p.quat.premultiply(_q);
      }
      // walls
      for (const c of this.statics) {
        if (!c.enabled) continue;
        const dx = p.pos.x - c.x;
        const dz = p.pos.z - c.z;
        const br = c.boundR + p.radius;
        if (dx * dx + dz * dz > br * br) continue;
        if (c.pushSphere(p.pos, p.radius, _push)) {
          p.pos.add(_push);
          const n = _push.normalize();
          const vn = p.vel.dot(n);
          if (vn < 0) p.vel.addScaledVector(n, -1.4 * vn);
          p.vel.multiplyScalar(0.7);
        }
      }
      // ground
      const half = p.kind === 'shell' || p.kind === 'casing' || p.kind === 'stick' ? p.radius : Math.min(p.scale.y, p.scale.x, p.scale.z) * 0.5;
      if (p.pos.y < half) {
        p.pos.y = half;
        if (p.vel.y < -1.2 && p.bounces < 4) {
          const sp = -p.vel.y;
          p.vel.y = sp * 0.38;
          p.vel.x *= 0.7;
          p.vel.z *= 0.7;
          p.ang.multiplyScalar(0.6);
          p.ang.x += rng.spread(sp * 1.5);
          p.ang.z += rng.spread(sp * 1.5);
          p.bounces++;
          p.onBounce?.(sp, p.pos);
        } else {
          p.vel.y = 0;
          p.vel.x /= 1 + dt * 7;
          p.vel.z /= 1 + dt * 7;
          if (p.kind === 'shell' || p.kind === 'casing') {
            // roll a bit around the long axis, then stop
            p.ang.multiplyScalar(1 / (1 + dt * 4));
          } else {
            p.ang.multiplyScalar(1 / (1 + dt * 10));
          }
          // settle to lie flat: align the most vertical local axis with world up
          const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
          let bestAxis = axes[1];
          let bestDot = 0;
          let bestSize = Infinity;
          const sizes = [p.scale.x, p.scale.y, p.scale.z];
          const flatKinds = p.kind === 'plank' || p.kind === 'shard' || p.kind === 'flat';
          axes.forEach((a, i) => {
            const wa = a.clone().applyQuaternion(p.quat);
            const d = Math.abs(wa.y);
            // prefer the thinnest axis for flat pieces
            const score = flatKinds ? sizes[i] : -d;
            if ((flatKinds && score < bestSize) || (!flatKinds && d > bestDot)) {
              bestSize = score;
              bestDot = d;
              bestAxis = a;
            }
          });
          if (p.kind === 'shell' || p.kind === 'casing' || p.kind === 'stick') bestAxis = axes[0];
          const wa = bestAxis.clone().applyQuaternion(p.quat);
          if (wa.y < 0) wa.negate();
          _q.setFromUnitVectors(wa, UP);
          const target = p.quat.clone().premultiply(_q);
          p.quat.slerp(target, Math.min(1, dt * 8));
        }
      }
      // shrink out
      const t = p.life / p.max;
      const k = t > 0.85 ? 1 - (t - 0.85) / 0.15 : 1;
      const mesh = this.meshes.get(p.kind)!;
      const i = counts.get(p.kind) ?? 0;
      if (i >= this.perKind) continue;
      _m.compose(p.pos, p.quat, _v.copy(p.scale).multiplyScalar(k));
      mesh.setMatrixAt(i, _m);
      mesh.setColorAt(i, p.color);
      counts.set(p.kind, i + 1);
    }
    for (const [kind, mesh] of this.meshes) {
      mesh.count = counts.get(kind) ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  clear(): void {
    for (const p of this.pieces) p.alive = false;
  }
}
