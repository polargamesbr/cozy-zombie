import * as THREE from 'three';
import { rng } from '../core/rng';
import { compose } from '../core/math';
import { PAL } from '../render/palette';
import { blob, box, cyl, GeoBuilder, rbox, sphere, worldUV } from '../render/geometry';
import { toon, toonUnique, vcToon } from '../render/materials';
import { crateTexture, strawTexture } from '../render/textures';
import { RigidBody, type BodyOwner, type Shape } from '../physics/rigid';
import type { Surface } from '../physics/colliders';
import type { GameCtx, Updatable } from '../game/context';
import { sfx } from '../audio/sfx';
import { TEX } from '../fx/particles';

const _v = new THREE.Vector3();

/** Base class for dynamic physics props. Visual origin = body center of mass. */
export abstract class Prop implements BodyOwner, Updatable {
  readonly body: RigidBody;
  readonly object: THREE.Object3D;
  hp = Infinity;
  broken = false;
  dead = false;
  /** Bullet impulse multiplier – props get pushed more than physically fair, it feels better. */
  protected kickScale = 2.2;

  constructor(
    protected ctx: GameCtx,
    shape: Shape,
    mass: number,
    surface: Surface,
    object: THREE.Object3D,
    pos: THREE.Vector3,
    yaw = 0,
  ) {
    this.body = new RigidBody(shape, mass, surface);
    this.body.pos.copy(pos);
    this.body.quat.setFromEuler(new THREE.Euler(0, yaw, 0));
    this.body.owner = this;
    this.body.object = object;
    this.object = object;
    object.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    ctx.root.add(object);
    ctx.physics.addBody(this.body);
    this.body.sync();
    this.body.sleeping = true;
  }

  onBulletHit(point: THREE.Vector3, normal: THREE.Vector3, dir: THREE.Vector3, damage: number, force: number): void {
    if (this.broken) return;
    _v.copy(dir).setY(Math.max(dir.y, 0) + 0.25).normalize().multiplyScalar(force * this.kickScale);
    this.body.applyImpulse(_v, point);
    this.hitFx(point, normal, dir);
    this.hp -= damage;
    if (this.hp <= 0) this.breakApart(dir, force);
  }

  onImpact(speed: number, _point: THREE.Vector3, dir: THREE.Vector3, mass: number): boolean {
    if (this.broken) return true;
    if (this.fragile(speed * Math.min(mass, 40) / 20)) {
      this.breakApart(dir, speed);
      return true;
    }
    return false;
  }

  onBodyImpact(speed: number, point: THREE.Vector3): void {
    if (this.broken) return;
    this.landFx(speed, point);
    if (this.fragile(speed)) this.breakApart(this.body.vel.clone().normalize(), speed);
  }

  onBlast(center: THREE.Vector3, strength: number): void {
    if (this.broken) return;
    if (this.hp < Infinity && strength > 0.55) {
      this.breakApart(this.body.pos.clone().sub(center).normalize(), strength * 10);
    }
  }

  /** Should an impact of this speed break it? */
  protected fragile(_speed: number): boolean {
    return false;
  }

  protected hitFx(point: THREE.Vector3, normal: THREE.Vector3, dir: THREE.Vector3): void {
    this.ctx.fx.impact(this.body.surface, point, normal, dir, true);
  }

  protected landFx(speed: number, point: THREE.Vector3): void {
    if (speed > 3) {
      this.ctx.fx.dust(point, 2, 0.5, PAL.dust, 0.3);
      if (this.body.surface === 'metal') sfx.metalHit(point);
      else sfx.thud(point, speed / 8);
    }
  }

  breakApart(_dir: THREE.Vector3, _speed: number): void {
    this.broken = true;
    this.remove();
  }

  remove(): void {
    this.dead = true;
    this.ctx.physics.removeBody(this.body);
    this.object.removeFromParent();
  }

  update(): void {
    if (!this.body.sleeping) this.body.sync();
  }
}

// ---------------------------------------------------------------------------------------------

export class Crate extends Prop {
  constructor(ctx: GameCtx, pos: THREE.Vector3, size = 0.7, yaw = 0) {
    const geo = rbox(size, size, size, 0.05, 2);
    const m = new THREE.Mesh(geo, toon(0xffffff, { map: crateTexture() }));
    super(ctx, { type: 'box', hx: size / 2, hy: size / 2, hz: size / 2 }, 14 * size, 'wood', m, pos.clone().setY(size / 2), yaw);
    this.hp = 2.6 * size + 0.6;
  }

  protected fragile(speed: number): boolean {
    return speed > 9;
  }

  breakApart(dir: THREE.Vector3, speed: number): void {
    if (this.broken) return;
    const p = this.body.pos.clone();
    const s = (this.body.shape as { hx: number }).hx * 2;
    for (let i = 0; i < 8; i++) {
      const v = dir.clone().setY(0).normalize().multiplyScalar(speed * rng.range(0.2, 0.5)).add(new THREE.Vector3(rng.spread(3), rng.range(2, 5), rng.spread(3)));
      const long = rng.chance(0.6);
      this.ctx.fx.debris.spawn('plank', p.clone().add(new THREE.Vector3(rng.spread(s * 0.4), rng.spread(s * 0.4), rng.spread(s * 0.4))), v, new THREE.Vector3(long ? s : s * 0.5, 0.05, 0.13), rng.chance(0.5) ? PAL.crate : PAL.crateDark, { spin: 16, life: 8 });
    }
    this.ctx.fx.dust(p, 6, 1.2, 0xe8d5b5, 0.45);
    this.ctx.fx.splinters(p, new THREE.Vector3(0, 1, 0), 5, PAL.crate);
    sfx.woodBreak(p);
    if (rng.chance(0.55)) this.ctx.spawnPickup(rng.chance(0.2) ? 'dynamite' : rng.chance(0.5) ? 'ammoShotgun' : 'ammoPistol', p.clone().setY(0.2));
    super.breakApart(dir, speed);
  }
}

export class Barrel extends Prop {
  constructor(ctx: GameCtx, pos: THREE.Vector3, yaw = 0) {
    const g = new GeoBuilder();
    const r = 0.36;
    const hh = 0.48;
    const body = new THREE.CylinderGeometry(r, r, hh * 2, 16, 4);
    const bp = body.getAttribute('position');
    for (let i = 0; i < bp.count; i++) {
      const y = bp.getY(i) / hh;
      const bulge = 1 + 0.08 * (1 - y * y);
      bp.setX(i, bp.getX(i) * bulge);
      bp.setZ(i, bp.getZ(i) * bulge);
    }
    body.computeVertexNormals();
    g.add(body, PAL.barrel);
    for (const y of [-0.34, 0, 0.34]) g.add(cyl(r * (y === 0 ? 1.09 : 1.06), r * (y === 0 ? 1.09 : 1.06), 0.06, 16), PAL.metal, compose(0, y, 0));
    g.add(cyl(r * 0.92, r * 0.92, 0.02, 16), 0x8a5e41, compose(0, hh + 0.005, 0));
    const m = new THREE.Mesh(g.build(), vcToon());
    super(ctx, { type: 'cyl', r, hh }, 30, 'wood', m, pos.clone().setY(hh), yaw);
    this.kickScale = 3;
  }
}

export class Can extends Prop {
  constructor(ctx: GameCtx, pos: THREE.Vector3, color: number) {
    const g = new GeoBuilder();
    g.add(cyl(0.055, 0.055, 0.14, 10), color);
    g.add(cyl(0.05, 0.05, 0.02, 10), PAL.metalLight, compose(0, 0.075, 0));
    g.add(cyl(0.056, 0.056, 0.03, 10), 0xf6efe0, compose(0, 0.0, 0));
    const m = new THREE.Mesh(g.build(), vcToon());
    super(ctx, { type: 'cyl', r: 0.055, hh: 0.07 }, 0.25, 'metal', m, pos.clone().setY(0.07), rng.angle());
    this.kickScale = 0.9;
  }

  protected hitFx(point: THREE.Vector3, normal: THREE.Vector3): void {
    this.ctx.fx.sparks(point, normal, 4, 5);
    sfx.metalHit(point);
  }

  protected landFx(speed: number, point: THREE.Vector3): void {
    if (speed > 2) sfx.shellTink(point);
  }
}

export class FlowerPot extends Prop {
  private flower: number;

  constructor(ctx: GameCtx, pos: THREE.Vector3, flower: number) {
    const g = new GeoBuilder();
    g.add(cyl(0.2, 0.15, 0.3, 12), PAL.terracotta, compose(0, -0.02, 0));
    g.add(cyl(0.23, 0.23, 0.07, 12), 0xdb8d68, compose(0, 0.13, 0));
    g.add(cyl(0.19, 0.19, 0.02, 12), PAL.soil, compose(0, 0.15, 0));
    const leaves = blob(0.2, 1, 0.2, 3, 0.9);
    leaves.translate(0, 0.33, 0);
    g.add(leaves, PAL.leafA);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      g.add(sphere(0.06, 6, 5), flower, compose(Math.cos(a) * 0.13, 0.42 + rng.next() * 0.06, Math.sin(a) * 0.13));
    }
    const m = new THREE.Mesh(g.build(), vcToon());
    super(ctx, { type: 'cyl', r: 0.2, hh: 0.17 }, 3, 'terracotta', m, pos.clone().setY(0.17 + pos.y), rng.angle());
    this.hp = 0.5;
    this.flower = flower;
  }

  protected fragile(speed: number): boolean {
    return speed > 4.5;
  }

  breakApart(dir: THREE.Vector3, speed: number): void {
    if (this.broken) return;
    const p = this.body.pos.clone();
    for (let i = 0; i < 7; i++) {
      const v = dir.clone().multiplyScalar(speed * rng.range(0.1, 0.3)).add(new THREE.Vector3(rng.spread(2.5), rng.range(1.5, 4), rng.spread(2.5)));
      this.ctx.fx.debris.spawn('shard', p, v, new THREE.Vector3(rng.range(0.1, 0.18), rng.range(0.1, 0.16), rng.range(0.1, 0.18)), rng.chance(0.5) ? PAL.terracotta : 0xdb8d68, { life: 7 });
    }
    for (let i = 0; i < 6; i++) {
      this.ctx.fx.particles.drops.spawn(p, new THREE.Vector3(rng.spread(2), rng.range(1, 3.5), rng.spread(2)), rng.range(0.03, 0.05), PAL.soil, 1, 1);
    }
    this.ctx.fx.debris.spawn('chunk', p.clone().setY(p.y + 0.2), new THREE.Vector3(rng.spread(1), 3, rng.spread(1)), 0.16, PAL.leafA, { life: 6 });
    this.ctx.fx.debris.spawn('chunk', p.clone().setY(p.y + 0.3), new THREE.Vector3(rng.spread(1.5), 3.5, rng.spread(1.5)), 0.08, this.flower, { life: 6 });
    this.ctx.fx.dust(p, 4, 0.8, 0xe2b596, 0.3);
    sfx.ceramicBreak(p);
    super.breakApart(dir, speed);
  }
}

export class Chair extends Prop {
  constructor(ctx: GameCtx, pos: THREE.Vector3, yaw: number, color: number = PAL.houseDoor) {
    const g = new GeoBuilder();
    // centered at the seat's center of mass (seat at y=0 local)
    g.add(rbox(0.5, 0.07, 0.48, 0.02), color, compose(0, 0, 0));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(rbox(0.06, 0.45, 0.06, 0.015), color, compose(sx * 0.2, -0.24, sz * 0.19));
    for (const sx of [-1, 1]) g.add(rbox(0.06, 0.55, 0.06, 0.015), color, compose(sx * 0.2, 0.3, -0.21));
    for (const y of [0.18, 0.36, 0.52]) g.add(rbox(0.46, 0.07, 0.04, 0.015), 0xf4eadc, compose(0, y, -0.21));
    const m = new THREE.Mesh(g.build(), vcToon());
    super(ctx, { type: 'box', hx: 0.25, hy: 0.24, hz: 0.24 }, 5, 'wood', m, pos.clone().setY(pos.y + 0.46), yaw);
    // shift collision box a bit lower than the seat so legs touch the floor
    this.kickScale = 2.5;
  }
}

export class Pumpkin extends Prop {
  constructor(ctx: GameCtx, pos: THREE.Vector3, size = 1) {
    const g = new GeoBuilder();
    const r = 0.28 * size;
    const body = new THREE.SphereGeometry(r, 18, 12);
    const bp = body.getAttribute('position');
    for (let i = 0; i < bp.count; i++) {
      const x = bp.getX(i);
      const z = bp.getZ(i);
      const a = Math.atan2(z, x);
      const rib = 1 - 0.07 * Math.pow(Math.abs(Math.cos(a * 4)), 3);
      bp.setX(i, x * rib * 1.15);
      bp.setZ(i, z * rib * 1.15);
      bp.setY(i, bp.getY(i) * 0.82);
    }
    body.computeVertexNormals();
    g.add(body, PAL.pumpkin);
    g.add(cyl(0.035 * size, 0.05 * size, 0.14 * size, 6), PAL.pumpkinStem, compose(0.01, r * 0.85, 0, 0.2, 0, 0.1));
    g.add(sphere(0.08 * size, 6, 4), PAL.leafC, compose(0.1 * size, r * 0.75, 0.05, 0, 0, 0, 1.4, 0.35, 1));
    const m = new THREE.Mesh(g.build(), vcToon());
    super(ctx, { type: 'sphere', r: r * 1.05 }, 6 * size, 'pumpkin', m, pos.clone().setY(r * 0.85), rng.angle());
    this.hp = 0.9;
  }

  protected hitFx(point: THREE.Vector3, normal: THREE.Vector3): void {
    this.ctx.fx.particles.drops.spawn(point, normal.clone().multiplyScalar(2).setY(2), 0.04, PAL.pumpkin, 2, 1);
  }

  protected fragile(speed: number): boolean {
    return speed > 8;
  }

  breakApart(dir: THREE.Vector3, speed: number): void {
    if (this.broken) return;
    const p = this.body.pos.clone();
    for (let i = 0; i < 9; i++) {
      const v = dir.clone().multiplyScalar(speed * rng.range(0.1, 0.35)).add(new THREE.Vector3(rng.spread(3), rng.range(2, 5), rng.spread(3)));
      this.ctx.fx.debris.spawn('chunk', p, v, rng.range(0.07, 0.13), rng.chance(0.7) ? PAL.pumpkin : 0xf6c07a, { life: 6 });
    }
    for (let i = 0; i < 14; i++) {
      this.ctx.fx.particles.drops.spawn(p, new THREE.Vector3(rng.spread(3), rng.range(1.5, 4.5), rng.spread(3)).addScaledVector(dir, 2), rng.range(0.025, 0.05), rng.chance(0.6) ? 0xf7d9a0 : PAL.pumpkin, 2, 1.2);
    }
    this.ctx.fx.decals.splat(p.clone().setY(0), new THREE.Vector3(0, 1, 0), 0.9, PAL.pumpkin, 30);
    sfx.squish(p);
    super.breakApart(dir, speed);
  }
}

export class HayBale extends Prop {
  constructor(ctx: GameCtx, pos: THREE.Vector3, yaw: number) {
    const grp = new THREE.Group();
    const geo = rbox(1.2, 0.62, 0.8, 0.14, 3);
    worldUV(geo, 1.2);
    grp.add(new THREE.Mesh(geo, toon(0xffffff, { map: strawTexture() })));
    const twine = new GeoBuilder();
    for (const x of [-0.3, 0.3]) twine.add(box(0.05, 0.64, 0.82), 0xb78c46, compose(x, 0, 0));
    grp.add(new THREE.Mesh(twine.build(), vcToon()));
    super(ctx, { type: 'box', hx: 0.6, hy: 0.31, hz: 0.4 }, 45, 'hay', grp, pos.clone().setY(0.31 + pos.y), yaw);
    this.kickScale = 1.2;
  }

  protected hitFx(point: THREE.Vector3, normal: THREE.Vector3): void {
    this.ctx.fx.dust(point, 3, 0.8, PAL.hay, 0.3);
    for (let i = 0; i < 4; i++) {
      this.ctx.fx.debris.spawn('stick', point, normal.clone().multiplyScalar(2).add(new THREE.Vector3(rng.spread(1.5), rng.range(1, 3), rng.spread(1.5))), new THREE.Vector3(0.012, 0.12, 0.012), rng.pick([PAL.hay, PAL.hayDark]), { life: 3 });
    }
  }
}

/** Propane tank: shoot it once to start a leak, it hisses, spins… and blows up. */
export class PropaneTank extends Prop {
  private armed = -1;
  private cap: THREE.MeshToonMaterial;
  private blink = 0;

  constructor(ctx: GameCtx, pos: THREE.Vector3, yaw = 0) {
    const grp = new THREE.Group();
    const g = new GeoBuilder();
    g.add(new THREE.CapsuleGeometry(0.27, 0.62, 6, 16), PAL.propane);
    g.add(cyl(0.2, 0.25, 0.12, 12), PAL.propane, compose(0, -0.6, 0));
    g.add(cyl(0.29, 0.29, 0.05, 16), PAL.propaneCap, compose(0, 0.12, 0));
    // warning label
    g.add(box(0.16, 0.1, 0.01), PAL.propaneCap, compose(0, -0.05, 0.275));
    const m = new THREE.Mesh(g.build(), vcToon());
    grp.add(m);
    const capMat = toonUnique(PAL.propaneCap, { emissive: 0xff3a2a, emissiveIntensity: 0 });
    const valve = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.14, 10), capMat);
    valve.position.y = 0.66;
    grp.add(valve);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.03, 6, 12), capMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.72;
    grp.add(ring);
    super(ctx, { type: 'cyl', r: 0.27, hh: 0.6 }, 16, 'metal', grp, pos.clone().setY(0.6 + pos.y), yaw);
    this.cap = capMat;
    this.kickScale = 1.5;
  }

  onBulletHit(point: THREE.Vector3, normal: THREE.Vector3, dir: THREE.Vector3, damage: number, force: number): void {
    if (this.broken) return;
    super.onBulletHit(point, normal, dir, 0, force);
    if (this.armed < 0) {
      this.armed = 0.9;
      sfx.metalHit(point);
    } else if (damage > 0) this.armed = Math.min(this.armed, 0.12);
  }

  onBlast(): void {
    if (this.broken) return;
    if (this.armed < 0 || this.armed > 0.15) this.armed = 0.15 + rng.next() * 0.1;
  }

  protected hitFx(point: THREE.Vector3, normal: THREE.Vector3): void {
    this.ctx.fx.sparks(point, normal, 8, 7);
  }

  protected fragile(speed: number): boolean {
    if (speed > 10 && this.armed < 0) this.armed = 0.5;
    return false;
  }

  update(dt = 1 / 60): void {
    super.update();
    if (this.armed < 0 || this.broken || dt <= 0) return;
    this.armed -= dt;
    this.blink += dt;
    this.cap.emissiveIntensity = Math.sin(this.blink * 40) > 0 ? 1.8 : 0.2;
    // leaking gas jet from the valve, which also pushes the tank around a bit
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.body.quat);
    const valve = this.body.pos.clone().addScaledVector(up, 0.7);
    this.ctx.fx.particles.soft.spawn(valve, { vel: up.clone().multiplyScalar(6).add(new THREE.Vector3(rng.spread(0.5), rng.spread(0.5), rng.spread(0.5))), life: 0.4, size: 0.12, sizeEnd: 0.5, color: 0xffffff, alpha: 0.8, drag: 5, cell: TEX.puff });
    this.body.applyImpulse(up.clone().multiplyScalar(-2.2), valve);
    sfx.hiss(valve);
    if (this.armed <= 0) {
      this.broken = true;
      const p = this.body.pos.clone();
      this.remove();
      this.ctx.explode(p, 1, 'propane');
    }
  }
}
