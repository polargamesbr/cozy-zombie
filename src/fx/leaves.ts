import * as THREE from 'three';
import { rng } from '../core/rng';
import { leafTexture } from '../render/textures';
import { toonUnique } from '../render/materials';

interface Leaf {
  alive: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  rot: THREE.Euler;
  spin: THREE.Vector3;
  phase: number;
  life: number;
  max: number;
  size: number;
  color: THREE.Color;
  landed: boolean;
}

/** Fluttering leaves: slow fall, sway, flip, rest on the ground, then fade. */
export class Leaves {
  readonly mesh: THREE.InstancedMesh;
  private leaves: Leaf[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();

  constructor(max = 160) {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = toonUnique(0xffffff, { map: leafTexture(), side: THREE.DoubleSide });
    mat.alphaTest = 0.5;
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    for (let i = 0; i < max; i++) {
      this.leaves.push({
        alive: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        rot: new THREE.Euler(),
        spin: new THREE.Vector3(),
        phase: 0,
        life: 0,
        max: 8,
        size: 0.15,
        color: new THREE.Color(),
        landed: false,
      });
    }
  }

  spawn(pos: THREE.Vector3, vel: THREE.Vector3, color: number): void {
    let l = this.leaves.find((x) => !x.alive);
    if (!l) l = this.leaves.reduce((a, b) => (a.life > b.life ? a : b));
    l.alive = true;
    l.pos.copy(pos);
    l.vel.copy(vel);
    l.rot.set(rng.angle(), rng.angle(), rng.angle());
    l.spin.set(rng.spread(4), rng.spread(3), rng.spread(4));
    l.phase = rng.angle();
    l.life = 0;
    l.max = rng.range(9, 13);
    l.size = rng.range(0.13, 0.2);
    l.color.set(color);
    l.landed = false;
  }

  update(dt: number, t: number): void {
    let n = 0;
    for (const l of this.leaves) {
      if (!l.alive) continue;
      l.life += dt;
      if (l.life > l.max) {
        l.alive = false;
        continue;
      }
      if (!l.landed) {
        // air drag towards a slow terminal fall, plus a sideways flutter
        l.vel.multiplyScalar(1 / (1 + dt * 2.8));
        l.vel.y -= dt * 2.4;
        const flutter = Math.sin(t * 3.1 + l.phase);
        l.pos.x += (l.vel.x + flutter * 0.55) * dt;
        l.pos.y += l.vel.y * dt;
        l.pos.z += (l.vel.z + Math.cos(t * 2.3 + l.phase) * 0.35) * dt;
        l.rot.x += l.spin.x * dt * (0.6 + Math.abs(flutter));
        l.rot.y += l.spin.y * dt;
        l.rot.z += l.spin.z * dt;
        if (l.pos.y < 0.03) {
          l.pos.y = 0.02 + rng.next() * 0.01;
          l.landed = true;
          l.rot.x = 0;
          l.rot.z = 0;
        }
      }
      const k = l.life > l.max - 1 ? l.max - l.life : 1;
      this.q.setFromEuler(l.rot);
      this.s.set(l.size * k, 1, l.size * 1.3 * k);
      this.m.compose(l.pos, this.q, this.s);
      this.mesh.setMatrixAt(n, this.m);
      this.mesh.setColorAt(n, l.color);
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  clear(): void {
    for (const l of this.leaves) l.alive = false;
  }
}
