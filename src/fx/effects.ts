import * as THREE from 'three';
import { rng } from '../core/rng';
import { PAL } from '../render/palette';
import { canvasTexture } from '../render/textures';
import type { Surface } from '../physics/colliders';
import { Particles, TEX } from './particles';
import { Decals } from './decals';
import { DebrisSystem } from './debris';
import { Leaves } from './leaves';
import { sfx } from '../audio/sfx';

const _v = new THREE.Vector3();
const _u = new THREE.Vector3();

function tracerTexture(): THREE.CanvasTexture {
  return canvasTexture('tracer', 128, 16, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, 'rgba(255,220,150,0)');
    g.addColorStop(0.7, 'rgba(255,230,170,0.8)');
    g.addColorStop(1, 'rgba(255,255,230,1)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    const v = ctx.createLinearGradient(0, 0, 0, h);
    v.addColorStop(0, 'rgba(0,0,0,1)');
    v.addColorStop(0.5, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, w, h);
  });
}

interface Tracer {
  mesh: THREE.Mesh;
  a: THREE.Vector3;
  b: THREE.Vector3;
  life: number;
  max: number;
  width: number;
}

/** Bullet streaks: camera-facing ribbons that fade in a few frames. */
class Tracers {
  readonly group = new THREE.Group();
  private pool: Tracer[] = [];
  private cursor = 0;

  constructor() {
    const geo = new THREE.PlaneGeometry(1, 1);
    const tex = tracerTexture();
    for (let i = 0; i < 32; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        color: new THREE.Color(2.2, 1.9, 1.3),
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 25;
      this.group.add(mesh);
      this.pool.push({ mesh, a: new THREE.Vector3(), b: new THREE.Vector3(), life: 0, max: 0.07, width: 0.05 });
    }
  }

  add(a: THREE.Vector3, b: THREE.Vector3, width = 0.05, life = 0.07): void {
    const t = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % this.pool.length;
    t.a.copy(a);
    t.b.copy(b);
    t.life = 0;
    t.max = life;
    t.width = width;
    t.mesh.visible = true;
  }

  update(dt: number, camPos: THREE.Vector3): void {
    for (const t of this.pool) {
      if (!t.mesh.visible) continue;
      t.life += dt;
      if (t.life >= t.max) {
        t.mesh.visible = false;
        continue;
      }
      const k = t.life / t.max;
      // the streak races forward and thins out
      const head = new THREE.Vector3().lerpVectors(t.a, t.b, Math.min(1, 0.35 + k * 1.2));
      const tail = new THREE.Vector3().lerpVectors(t.a, t.b, Math.min(1, k * 0.9));
      const d = new THREE.Vector3().subVectors(head, tail);
      const len = d.length();
      if (len < 1e-3) {
        t.mesh.visible = false;
        continue;
      }
      const c = new THREE.Vector3().addVectors(head, tail).multiplyScalar(0.5);
      const view = new THREE.Vector3().subVectors(camPos, c).normalize();
      const x = d.clone().divideScalar(len);
      const y = new THREE.Vector3().crossVectors(view, x).normalize();
      const z = new THREE.Vector3().crossVectors(x, y);
      const w = t.width * (1 - k * 0.6);
      t.mesh.matrix.makeBasis(x.multiplyScalar(len), y.multiplyScalar(w), z);
      t.mesh.matrix.setPosition(c);
      (t.mesh.material as THREE.MeshBasicMaterial).opacity = 1 - k * k;
    }
  }
}

/**
 * High-level "juice" recipes. Every effect is short and self-cleaning: bursts that vanish in a
 * second, decals that fade after ~40 s, debris that shrinks away.
 */
export class Effects {
  readonly particles = new Particles();
  readonly decals = new Decals();
  readonly debris = new DebrisSystem();
  readonly tracers = new Tracers();
  readonly leaves = new Leaves();
  readonly group = new THREE.Group();
  private time = 0;
  readonly muzzleLight: THREE.PointLight;
  readonly boomLight: THREE.PointLight;
  private muzzleT = 0;
  private boomT = 0;

  constructor() {
    this.group.add(this.particles.group, this.decals.group, this.debris.group, this.tracers.group, this.leaves.mesh);
    this.muzzleLight = new THREE.PointLight(0xffc36b, 0, 6, 2);
    this.boomLight = new THREE.PointLight(0xffa24d, 0, 13, 2);
    this.group.add(this.muzzleLight, this.boomLight);
    this.particles.drops.onLand = (pos, vel, kind, size) => {
      if (kind === 0) {
        if (rng.chance(0.45)) return;
        _v.set(0, 1, 0);
        const sp = Math.hypot(vel.x, vel.z);
        if (sp > 4 && rng.chance(0.4)) this.decals.blood(pos, _v, size * 7 + 0.16, { streakDir: vel });
        else this.decals.blood(pos, _v, size * 7 + 0.12);
      } else if (kind === 2) {
        this.decals.splat(pos, new THREE.Vector3(0, 1, 0), size * 3.5, PAL.pumpkin, 25);
      }
    };
  }

  update(dt: number, gravity: number, camPos: THREE.Vector3): void {
    this.time += dt;
    this.leaves.update(dt, this.time);
    this.particles.update(dt, gravity);
    this.decals.update(dt);
    this.debris.update(dt, gravity);
    this.tracers.update(dt, camPos);
    if (this.muzzleT > 0) {
      this.muzzleT -= dt;
      this.muzzleLight.intensity = Math.max(0, this.muzzleT / 0.07) * 14;
    } else this.muzzleLight.intensity = 0;
    if (this.boomT > 0) {
      this.boomT -= dt;
      this.boomLight.intensity = Math.max(0, this.boomT / 0.45) ** 2 * 90;
    } else this.boomLight.intensity = 0;
  }

  clear(): void {
    this.particles.clear();
    this.decals.clear();
    this.debris.clear();
    this.leaves.clear();
  }

  // ------------------------------------------------------------------ recipes

  dust(pos: THREE.Vector3, n = 4, spread = 0.6, color: number = PAL.dust, size = 0.45): void {
    for (let i = 0; i < n; i++) {
      const a = rng.angle();
      const s = rng.range(0.4, 1.4) * spread;
      this.particles.soft.spawn([pos.x + rng.spread(0.12), pos.y + 0.05 + rng.next() * 0.1, pos.z + rng.spread(0.12)], {
        vel: [Math.cos(a) * s, rng.range(0.4, 1.4), Math.sin(a) * s],
        life: rng.range(0.45, 0.85),
        size: size * rng.range(0.6, 1),
        sizeEnd: size * rng.range(1.5, 2.3),
        color,
        alpha: 0.75,
        alphaEnd: 0,
        drag: 3,
        gravity: -0.4,
        rotVel: rng.spread(2),
      });
    }
  }

  dustRing(pos: THREE.Vector3, radius: number, n = 14, color: number = PAL.dust): void {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rng.spread(0.2);
      const sp = radius * rng.range(3, 5);
      this.particles.soft.spawn([pos.x + Math.cos(a) * 0.3, 0.15, pos.z + Math.sin(a) * 0.3], {
        vel: [Math.cos(a) * sp, rng.range(0.3, 1), Math.sin(a) * sp],
        life: rng.range(0.5, 0.9),
        size: 0.5,
        sizeEnd: 1.2,
        color,
        alpha: 0.7,
        drag: 4.5,
      });
    }
  }

  smokePuff(pos: THREE.Vector3, dir: THREE.Vector3, n = 3, size = 0.3): void {
    for (let i = 0; i < n; i++) {
      const s = rng.range(0.6, 2.2);
      this.particles.soft.spawn([pos.x, pos.y, pos.z], {
        vel: [dir.x * s + rng.spread(0.3), dir.y * s + rng.range(0.2, 0.7), dir.z * s + rng.spread(0.3)],
        life: rng.range(0.5, 1.0),
        size: size * rng.range(0.7, 1.1),
        sizeEnd: size * rng.range(2.5, 3.6),
        color: 0xf1ebe4,
        colorEnd: 0xc9c2c9,
        alpha: 0.6,
        drag: 3.2,
        gravity: 0.5,
        rotVel: rng.spread(1.5),
      });
    }
  }

  sparks(pos: THREE.Vector3, normal: THREE.Vector3, n = 6, speed = 7): void {
    for (let i = 0; i < n; i++) {
      _v.copy(normal).multiplyScalar(rng.range(0.4, 1)).add(_u.set(rng.spread(0.8), rng.spread(0.8) + 0.3, rng.spread(0.8))).normalize();
      this.particles.glow.spawn(pos, {
        vel: _v.multiplyScalar(speed * rng.range(0.5, 1.2)).clone(),
        life: rng.range(0.12, 0.3),
        size: 0.035,
        color: PAL.spark,
        intensity: 3,
        alpha: 1,
        alphaEnd: 0.2,
        gravity: -9,
        drag: 2,
        cell: TEX.soft,
        stretch: 0.06,
      });
    }
  }

  muzzleFlash(pos: THREE.Vector3, dir: THREE.Vector3, big: boolean): void {
    const s = big ? 0.85 : 0.5;
    this.particles.glow.spawn(pos, { life: big ? 0.06 : 0.045, size: s, sizeEnd: s * 1.2, color: 0xfff4d6, intensity: 1.5, alpha: 1, alphaEnd: 0.2, cell: TEX.star, rot: rng.angle() });
    // a stretched cone of fire along the barrel
    this.particles.glow.spawn(pos.clone().addScaledVector(dir, s * 0.35), {
      life: big ? 0.05 : 0.04,
      size: s * 0.38,
      sizeEnd: s * 0.5,
      color: PAL.muzzleHot,
      intensity: 1.6,
      alpha: 1,
      alphaEnd: 0,
      cell: TEX.soft,
      vel: dir.clone().multiplyScalar(big ? 3 : 2),
      stretch: 1.2,
    });
    this.muzzleLight.position.copy(pos).addScaledVector(dir, 0.3);
    this.muzzleLight.position.y += 0.3;
    this.muzzleT = 0.07;
    this.smokePuff(pos, dir, big ? 5 : 2, big ? 0.26 : 0.18);
    if (big) this.sparks(pos, dir, 6, 9);
  }

  bloodBurst(pos: THREE.Vector3, dir: THREE.Vector3, amount: number, force = 1): void {
    const n = Math.round(amount * 0.6);
    for (let i = 0; i < n; i++) {
      _v.copy(dir)
        .multiplyScalar(rng.range(0.6, 1.3) * 5 * force)
        .add(_u.set(rng.spread(2.4), rng.range(0.8, 4.2), rng.spread(2.4)));
      const size = rng.range(0.04, 0.08) * (rng.chance(0.2) ? 1.7 : 1);
      this.particles.drops.spawn(pos, _v, size, rng.pick([PAL.blood, PAL.bloodLight, PAL.bloodDark]), 0, 1.5);
    }
    // a quick mist puff
    this.particles.soft.spawn(pos, {
      vel: dir.clone().multiplyScalar(1.5),
      life: 0.22,
      size: 0.25,
      sizeEnd: 0.6 + amount * 0.02,
      color: PAL.bloodLight,
      alpha: 0.7,
      alphaEnd: 0,
      drag: 6,
    });
  }

  /** Just a quick red puff, no droplets (per-pellet feedback). */
  bloodMist(pos: THREE.Vector3, dir: THREE.Vector3): void {
    this.particles.soft.spawn(pos, { vel: dir.clone().multiplyScalar(2), life: 0.18, size: 0.18, sizeEnd: 0.45, color: PAL.bloodLight, alpha: 0.75, alphaEnd: 0, drag: 7 });
  }

  gibs(pos: THREE.Vector3, dir: THREE.Vector3, n: number, color: number = PAL.gib): void {
    for (let i = 0; i < n; i++) {
      _v.copy(dir)
        .multiplyScalar(rng.range(3, 8))
        .add(_u.set(rng.spread(3), rng.range(2, 6), rng.spread(3)));
      const s = rng.range(0.05, 0.1);
      this.debris.spawn('chunk', pos, _v.clone(), s, rng.chance(0.5) ? color : PAL.zombieSkinDark, {
        life: 5,
        onBounce: (sp, p) => {
          if (sp > 2) this.decals.blood(p.clone(), new THREE.Vector3(0, 1, 0), 0.22);
        },
      });
    }
  }

  splinters(pos: THREE.Vector3, normal: THREE.Vector3, n: number, color: number): void {
    for (let i = 0; i < n; i++) {
      _v.copy(normal).multiplyScalar(rng.range(1.5, 4)).add(_u.set(rng.spread(1.5), rng.range(0.5, 3), rng.spread(1.5)));
      this.debris.spawn('plank', pos, _v.clone(), new THREE.Vector3(rng.range(0.04, 0.1), 0.02, 0.02), color, { life: 3.5, spin: 25 });
    }
    this.dust(pos, 2, 0.4, 0xe9d9c0, 0.25);
  }

  leafBurst(pos: THREE.Vector3, n: number, colors: readonly number[], force = 1): void {
    for (let i = 0; i < n; i++) {
      _v.set(rng.spread(2.5), rng.range(-0.3, 1.8), rng.spread(2.5)).multiplyScalar(force);
      this.leaves.spawn(pos.clone().add(_u.set(rng.spread(0.6), rng.spread(0.4), rng.spread(0.6))), _v, rng.pick(colors));
    }
  }

  /** Surface-appropriate bullet impact. */
  impact(surface: Surface, pos: THREE.Vector3, normal: THREE.Vector3, dir: THREE.Vector3, small = false): void {
    switch (surface) {
      case 'grass':
      case 'dirt':
      case 'road':
      case 'hay': {
        const col = surface === 'hay' ? PAL.hay : surface === 'road' ? 0xc8c4c8 : PAL.dust;
        this.dust(pos, small ? 2 : 3, 0.8, col, 0.28);
        for (let i = 0; i < (small ? 1 : 3); i++) {
          _v.set(rng.spread(1.2), rng.range(2, 4.5), rng.spread(1.2)).addScaledVector(normal, 1.5);
          this.particles.drops.spawn(pos, _v, rng.range(0.025, 0.045), surface === 'hay' ? PAL.hayDark : PAL.soil, 1, 0.8);
        }
        break;
      }
      case 'wood':
        this.splinters(pos, normal, small ? 2 : 4, PAL.fenceWood);
        this.decals.bulletHole(pos, normal);
        sfx.woodHit(pos);
        break;
      case 'metal':
        this.sparks(pos, normal, 8, 8);
        this.decals.bulletHole(pos, normal, 0.09);
        sfx.metalHit(pos);
        break;
      case 'stone':
        this.sparks(pos, normal, 3, 5);
        this.dust(pos, 3, 0.6, 0xd6d0c6, 0.25);
        this.decals.bulletHole(pos, normal, 0.1);
        break;
      case 'plant':
        this.leafBurst(pos, 4, [PAL.leafA, PAL.leafB, PAL.leafGold]);
        break;
      case 'water':
        this.splash(pos, 0.6);
        break;
      case 'terracotta':
        this.dust(pos, 2, 0.5, 0xe0b49a, 0.25);
        break;
      case 'glass':
        this.sparks(pos, normal, 4, 4);
        break;
      default:
        this.dust(pos, 2, 0.5);
    }
  }

  splash(pos: THREE.Vector3, size = 1): void {
    for (let i = 0; i < 10 * size; i++) {
      _v.set(rng.spread(1.5), rng.range(2, 5), rng.spread(1.5)).multiplyScalar(size);
      this.particles.drops.spawn(pos, _v, rng.range(0.03, 0.06), 0xd8f1f4, 1, 0.7);
    }
    this.particles.soft.spawn([pos.x, 0.06, pos.z], { life: 0.7, size: 0.2, sizeEnd: 1.6 * size, color: 0xeaf8f8, alpha: 0.8, alphaEnd: 0, cell: TEX.ring, rot: 0, floor: true });
    sfx.splash(pos);
  }

  /** Big cartoon explosion: flash, fire blobs, smoke, shockwave ring, embers. */
  explosion(pos: THREE.Vector3, scale = 1): void {
    const p = this.particles;
    this.boomLight.position.copy(pos).setY(1.5);
    this.boomT = 0.45;
    p.glow.spawn(pos.clone().setY(1), { life: 0.1, size: 3.2 * scale, sizeEnd: 4.5 * scale, color: 0xfff2c6, intensity: 1.2, alpha: 0.9, alphaEnd: 0, cell: TEX.soft });
    for (let i = 0; i < 12; i++) {
      _v.set(rng.spread(1), rng.range(0.2, 1), rng.spread(1)).normalize();
      const c = pos.clone().addScaledVector(_v, rng.range(0.2, 0.9) * scale).setY(rng.range(0.4, 1.6) * scale);
      p.fire.spawn(c, _v.clone().multiplyScalar(rng.range(3, 7) * scale), rng.range(0.35, 0.6), 0.5 * scale, rng.range(0.9, 1.6) * scale, new THREE.Color(PAL.fireHot).multiplyScalar(2.2), new THREE.Color(PAL.fireDeep).multiplyScalar(1.2));
    }
    for (let i = 0; i < 10; i++) {
      _v.set(rng.spread(1), rng.range(0.4, 1.2), rng.spread(1)).normalize();
      p.soft.spawn(pos.clone().addScaledVector(_v, rng.range(0.5, 1.5) * scale).setY(rng.range(0.8, 2.2) * scale), {
        vel: _v.clone().multiplyScalar(rng.range(1, 3) * scale),
        life: rng.range(1.8, 3),
        size: 1.2 * scale,
        sizeEnd: 3.2 * scale,
        color: 0xe9e1da,
        colorEnd: 0xf6f1ec,
        alpha: 0.7,
        drag: 1.5,
        gravity: 0.4,
        fadeIn: 0.1,
        rotVel: rng.spread(0.6),
      });
    }
    for (let i = 0; i < 8; i++) {
      _v.set(rng.spread(1), rng.range(0.5, 1.4), rng.spread(1)).normalize();
      const c = pos.clone().addScaledVector(_v, rng.range(0.3, 1.2) * scale).setY(rng.range(0.6, 2) * scale);
      p.smoke.spawn(c, _v.clone().multiplyScalar(rng.range(1.5, 4) * scale), rng.range(1.0, 1.7), 0.3 * scale, rng.range(0.9, 1.4) * scale, new THREE.Color(0x9a8d88), new THREE.Color(0xf1ebe6));
    }
    // shockwave ring on the floor
    p.soft.spawn([pos.x, 0.08, pos.z], { life: 0.45, size: 1, sizeEnd: 9 * scale, color: 0xfff6e2, alpha: 0.85, alphaEnd: 0, cell: TEX.ring, rot: 0, floor: true });
    // embers
    for (let i = 0; i < 24; i++) {
      _v.set(rng.spread(1), rng.range(0.4, 1.3), rng.spread(1)).normalize().multiplyScalar(rng.range(5, 13) * scale);
      p.glow.spawn(pos.clone().setY(0.8), { vel: _v.clone(), life: rng.range(0.4, 1.0), size: 0.06, color: PAL.fire, intensity: 3, alpha: 1, alphaEnd: 0, gravity: -12, drag: 1.2, cell: TEX.soft, stretch: 0.05 });
    }
    // dirt clods
    for (let i = 0; i < 14; i++) {
      _v.set(rng.spread(1), rng.range(0.8, 1.6), rng.spread(1)).normalize().multiplyScalar(rng.range(5, 10) * scale);
      p.drops.spawn(pos.clone().setY(0.3), _v, rng.range(0.05, 0.1), rng.pick([PAL.soil, PAL.soilDark, PAL.dirtDark]), 1, 2.2);
    }
    this.dustRing(pos, 1.2 * scale, 18);
    this.decals.scorchMark(pos.clone().setY(0), 4.2 * scale);
  }
}
